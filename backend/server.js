const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { loadConfig } = require('./config');
const { createDatabase } = require('../sqlite/database');
const Repository = require('../sqlite/repository');
const { EFFORT_CHOICES } = require('./providers/deepseek-provider');
const { AnkiLocal, ankiRuntimeProblem } = require('./anki-local');
const { AnkiBrowser } = require('./anki-browser');
const { AgentChat } = require('./agent-chat');
const { AgentManager } = require('./agent-manager');
const { KeychainStore } = require('./keychain-store');
const { AnkiSettings } = require('./anki-settings');
const { AnkiAccount } = require('./anki-account');
const syncProgress = require('./sync-progress');
const { AnkiExport, serializeExport } = require('./anki-export');
const { SkillLibrary } = require('./skill-library');
const { InstructionLibrary } = require('./instruction-library');
const { CardProfileLibrary } = require('./card-profile-library');
const { streamChat } = require('./chat-stream');
const { ProfileManager } = require('./profile-manager');

const config = loadConfig();
const db = createDatabase({ dbPath: config.sqlitePath, migrationsDir: config.migrationsDir });
const repository = new Repository(db);
const profileManager = new ProfileManager({ repository, ankiConfig: config.anki });
const initialAnkiProfile = profileManager.initialize();
const ankiSettings = new AnkiSettings({ repository, config: config.anki, profileId: initialAnkiProfile.id });
const ankiClient = new AnkiLocal(config.anki);
const ankiAccount = new AnkiAccount({ repository, client: ankiClient,
  keychain: new KeychainStore({ service: config.keychain.syncService }), profileId: initialAnkiProfile.id,
  legacyProfileId: repository.listAnkiProfiles()[0]?.id || initialAnkiProfile.id });
// The user's own card profiles are the only description of what a card holds, so the library exists before
// the services that read a note's fields: nothing in the app knows a field name that a profile did not give.
const cardProfileLibrary = new CardProfileLibrary({ dir: config.cardProfilesDir });
cardProfileLibrary.initialize();
// The note type the collection itself is described by. Absent is a real state — the user has not written a
// profile for it — so callers either refuse (an Anki export cannot be built) or pass values through (a note
// of an undescribed type is still readable and editable).
const cardContract = () => cardProfileLibrary.get(config.anki.modelName);
const ankiExport = new AnkiExport({ repository, client: ankiClient, config: config.anki,
  cardProfiles: cardProfileLibrary, getProfileId: () => profileManager.active().id });
const ankiBrowser = new AnkiBrowser({ client: ankiClient, config: config.anki,
  cardProfiles: cardProfileLibrary });
// User-authored skills live outside the checkout so a rebuild never touches them; the bundled seeds are
// copied in once and are never overwritten afterwards.
const skillLibrary = new SkillLibrary({ dir: config.skillsDir, seedDir: config.skillsSeedDir });
skillLibrary.initialize();
// Standing instructions are re-read on every request, so an edit takes effect on the next message without a
// restart. A file that cannot be read is a server-log line and nothing more: the browser and the chat are
// not the place to report a problem with a file the user is already editing, but a silent typo is worse, so
// the failure set is announced once per change.
const instructionLibrary = new InstructionLibrary({ dir: config.instructionsDir });
instructionLibrary.initialize();
let reportedInstructionFailures = '';
const reportInstructionFailures = () => {
  const signature = JSON.stringify(instructionLibrary.errors());
  if (signature === reportedInstructionFailures) return;
  reportedInstructionFailures = signature;
  for (const { name, error } of instructionLibrary.errors()) {
    process.stdout.write(`caro-anki instructions: cannot read ${name}: ${error}\n`);
  }
};
reportInstructionFailures();
// A profile the user is still editing is the same case: a server-log line reported once per change, never a
// failed request.
let reportedCardProfileFailures = '';
const reportCardProfileFailures = () => {
  const signature = JSON.stringify(cardProfileLibrary.errors());
  if (signature === reportedCardProfileFailures) return;
  reportedCardProfileFailures = signature;
  for (const { name, error } of cardProfileLibrary.errors()) {
    process.stdout.write(`caro-anki card profiles: cannot read ${name}: ${error}\n`);
  }
};
reportCardProfileFailures();
const agentManager = new AgentManager({ repository,
  keychain: new KeychainStore({ service: config.keychain.agentService }), browser: ankiBrowser,
  client: ankiClient, ankiConfig: config.anki, skills: skillLibrary, instructions: instructionLibrary,
  cardProfiles: cardProfileLibrary });
const agentChat = new AgentChat({ db, repository, getAgent: () => agentManager.getAgent(),
  getProfileId: () => profileManager.active().id });
profileManager.attach(ankiClient, {
  createCollection: async collectionPath => {
    const client = new AnkiLocal({ ...config.anki, collectionPath });
    try { await client.invoke('modelNames', {}); } finally { await client.close(); }
  },
  onActivate: profile => {
    ankiSettings.activate(profile.id);
    ankiAccount.activate(profile.id);
  },
  beforeChange: () => {
    if (agentChat.busy) throw Object.assign(new Error('An AI operation is running'), { statusCode: 409 });
    if (syncProgress.snapshot().running) throw Object.assign(new Error('Anki is syncing'), { statusCode: 409 });
  },
});

// The Anki runtime ships with the app, so its state is reported up front and the UI can name a
// setup problem before the user tries to read or sync the collection.
const ankiRuntimeStatus = () => {
  const error = ankiRuntimeProblem(config.anki);
  return { available: !error, bundled: Boolean(config.anki.helperPath), error };
};

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson (res, statusCode, payload) {
  const body = JSON.stringify(payload);
  const timing = res.apiStartedAt === undefined ? {} : {
    'Server-Timing': `app;dur=${(performance.now() - res.apiStartedAt).toFixed(1)}`,
  };
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...timing });
  res.end(body);
}

// `extra` is how an error names itself for the client: a chat turn answers with a `code` because two of its
// refusals share a status yet only one of them may be retried as it stands.
function sendError (res, statusCode, message, extra) {
  sendJson(res, statusCode, { ok: false, error: message, ...extra });
}

function isCrossOrigin (req) {
  const origin = req.headers.origin;
  return Boolean(origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site';
}

function isJsonRequest (req) {
  return req.headers['content-type']?.split(';')[0].trim().toLowerCase() === 'application/json';
}

// A read's `select` names the fields it may answer with. The allowed names belong to the shape each endpoint
// returns, so the browser layer owns the list and this stays a pass-through of exactly what was asked for.
const selectParams = url => ({ select: url.searchParams.get('select') });

function normalizeNoteIds (value, limit = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, limit);
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson (req) {
  const body = await readBody(req);
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function getStaticPath (pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(config.frontendDir, `.${requestedPath}`);
  if (filePath !== config.frontendDir && !filePath.startsWith(`${config.frontendDir}${path.sep}`)) return null;
  return filePath;
}

function serveStatic (req, res, pathname) {
  const filePath = getStaticPath(pathname);
  if (!filePath) return sendError(res, 400, 'Invalid path');

  try {
    const source = fs.readFileSync(filePath);
    const content = filePath === path.join(config.frontendDir, 'index.html')
      ? source.toString().replace('{{APP_TITLE}}', config.app.title) : source;
    const contentType = contentTypes[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendError(res, 404, 'Not found');
    throw error;
  }
}

function sessionRouteFromPath (pathname) {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(chat|messages|cards|anki-preview|anki-add|anki-exports))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || null } : null;
}

function profileRouteFromPath (pathname) {
  const match = pathname.match(/^\/api\/profiles\/([^/]+)\/(rename|activate)$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : null;
}

function serializeCardVersion (version) {
  if (!version) return null;
  const stored = JSON.parse(version.cards_json);
  const contract = cardContract();
  // A version recorded under a profile the user has since renamed or removed is still their history, so it
  // is reported as it was stored rather than re-judged by a contract that never described it.
  if (!contract) return { ...version, cards: stored, unchanged: Boolean(version.unchanged) };
  const validation = contract.validateCards(stored);
  return {
    ...version,
    cards: validation.cards.map(contract.orderCardFields),
    unchanged: Boolean(version.unchanged),
    validation_status: version.validation_status === 'invalid' || !validation.valid ? 'invalid' : 'valid',
    validationErrors: [...new Set([...JSON.parse(version.validation_errors_json), ...validation.errors])],
  };
}

const skillMarkdown = ({ name, description, body = '' }) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

async function handleApi (req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'caro-anki', anki: ankiRuntimeStatus() });
  }

  if (req.method === 'GET' && url.pathname === '/api/profiles') {
    return sendJson(res, 200, { ok: true, ...profileManager.list() });
  }

  if (req.method === 'POST' && url.pathname === '/api/profiles') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin profile requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const result = await profileManager.create(await readJson(req));
    return sendJson(res, 201, { ok: true, ...result });
  }

  const profileRoute = profileRouteFromPath(url.pathname);
  if (req.method === 'POST' && profileRoute) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin profile requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    const result = profileRoute.action === 'rename'
      ? await profileManager.rename({ id: profileRoute.id, ...body })
      : await profileManager.activate({ id: profileRoute.id });
    return sendJson(res, 200, { ok: true, ...result });
  }

  // Deleting a collection profile is the one profile route that destroys data, so it names the profile in the
  // URL and carries no body: there is nothing the caller may choose about what is removed.
  const profileId = url.pathname.match(/^\/api\/profiles\/([^/]+)$/)?.[1];
  if (req.method === 'DELETE' && profileId) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin profile requests are not allowed');
    return sendJson(res, 200, { ok: true, ...(await profileManager.remove({ id: decodeURIComponent(profileId) })) });
  }

  return profileManager.useActive(lease => handleActiveApi(req, res, url, lease));
}

async function handleActiveApi (req, res, url, lease) {
  const activeProfileId = lease.profileId;

  if (req.method === 'GET' && url.pathname === '/api/anki-settings') {
    return sendJson(res, 200, {
      ok: true,
      ...(await ankiSettings.settings()),
      account: await ankiAccount.settings(),
      runtime: ankiRuntimeStatus(),
    });
  }

  if (req.method === 'PUT' && url.pathname === '/api/anki-settings') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const settings = await ankiSettings.update(await readJson(req));
    return sendJson(res, 200, { ok: true, ...settings });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/account/login') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin account requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 200, { ok: true, account: await ankiAccount.login(await readJson(req)) });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/anki/account') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin account requests are not allowed');
    return sendJson(res, 200, { ok: true, account: await ankiAccount.logout() });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/sync') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin sync requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const { direction } = await readJson(req);
    return sendJson(res, 200, { ok: true, sync: await ankiAccount.sync({ direction: direction ?? null }) });
  }

  // What the running sync is doing. A sync holds the bridge for its whole duration, so this answers from
  // the snapshot the account maintains rather than from Anki — which is what makes polling it safe: it
  // never queues behind the sync it is reporting on, and it stays a single JSON body like every other
  // route here.
  if (req.method === 'GET' && url.pathname === '/api/anki/sync-progress') {
    return sendJson(res, 200, { ok: true, progress: syncProgress.snapshot() });
  }

  // The check behind the UI's sync reminder: the local stamps answer first and only a clean, signed-in
  // collection asks AnkiWeb, so this is cheap enough to run after every collection change.
  if (req.method === 'GET' && url.pathname === '/api/anki/sync-status') {
    return sendJson(res, 200, { ok: true, ...(await ankiAccount.syncStatus()) });
  }

  // The settings editor reads, writes, and renames both libraries through these routes. Each write refreshes the
  // shared instance, so the slash menu and agent see it without a restart; a broken skill is reported beside
  // the list instead of hiding valid entries. Agent authoring uses the same library writers through its tools.
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    skillLibrary.refresh();
    return sendJson(res, 200, { ok: true, skills: skillLibrary.entries(), errors: skillLibrary.errors() });
  }

  if (req.method === 'GET' && url.pathname === '/api/instructions') {
    instructionLibrary.refresh();
    return sendJson(res, 200, { ok: true, instructions: instructionLibrary.entries(), errors: instructionLibrary.errors() });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/instructions/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const name = decodeURIComponent(url.pathname.slice('/api/instructions/'.length));
    return sendJson(res, 200, { ok: true, instruction: instructionLibrary.save(name, (await readJson(req)).content) });
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/instructions/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const name = decodeURIComponent(url.pathname.slice('/api/instructions/'.length));
    const { to } = await readJson(req);
    return sendJson(res, 200, { ok: true, instruction: instructionLibrary.rename(name, to) });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/instructions/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    const name = decodeURIComponent(url.pathname.slice('/api/instructions/'.length));
    return sendJson(res, 200, { ok: true, instruction: instructionLibrary.remove(name) });
  }

  if (req.method === 'POST' && url.pathname === '/api/instructions') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const { name, content } = await readJson(req);
    const plan = instructionLibrary.check(name, content);
    if (!plan.created) return sendError(res, 409, `instruction already exists: ${plan.name}`);
    return sendJson(res, 201, { ok: true, instruction: instructionLibrary.save(name, content) });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/skills/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const name = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
    const skill = skillLibrary.resolve(name);
    const content = String((await readJson(req)).body ?? '');
    return sendJson(res, 200, { ok: true, skill: skillLibrary.save(name, [{ path: 'SKILL.md',
      content: skillMarkdown({ name: skill.name, description: skill.description, body: content }) }]) });
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/skills/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const name = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
    const { to } = await readJson(req);
    return sendJson(res, 200, { ok: true, skill: skillLibrary.rename(name, to) });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/skills/')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    const name = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
    return sendJson(res, 200, { ok: true, skill: skillLibrary.remove(name) });
  }

  if (req.method === 'POST' && url.pathname === '/api/skills') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const { name, description, body } = await readJson(req);
    const files = [{ path: 'SKILL.md', content: skillMarkdown({ name, description, body }) }];
    const plan = skillLibrary.check(name, files);
    if (!plan.created) return sendError(res, 409, `skill already exists: ${plan.name}`);
    return sendJson(res, 201, { ok: true, skill: skillLibrary.save(name, files) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return sendJson(res, 200, { ok: true, sessions: repository.listSessions(activeProfileId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-settings') {
    return sendJson(res, 200, { ok: true, ...(await agentManager.settings()) });
  }

  if (req.method === 'PUT' && url.pathname === '/api/agent-settings') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const { enabled, activeProfileId } = await readJson(req);
    if (enabled !== undefined && typeof enabled !== 'boolean') return sendError(res, 400, 'enabled must be a boolean');
    if (activeProfileId !== undefined && typeof activeProfileId !== 'string') {
      return sendError(res, 400, 'activeProfileId must be a string');
    }
    repository.updateAgentSettings({ enabled, activeProfileId });
    return sendJson(res, 200, { ok: true, ...(await agentManager.settings()) });
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-profiles') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, { ok: true, profile: await agentManager.create(await readJson(req)) });
  }

  const agentProfileId = url.pathname.match(/^\/api\/agent-profiles\/([^/]+)$/)?.[1];
  if (agentProfileId && ['PUT', 'DELETE'].includes(req.method)) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin settings requests are not allowed');
    const id = decodeURIComponent(agentProfileId);
    if (req.method === 'DELETE') {
      const deleted = await agentManager.delete(id);
      return deleted ? sendJson(res, 200, { ok: true, deleted }) : sendError(res, 404, 'Agent profile not found');
    }
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const profile = await agentManager.update(id, await readJson(req));
    return profile ? sendJson(res, 200, { ok: true, profile }) : sendError(res, 404, 'Agent profile not found');
  }

  // A run is stopped by naming it, and the answer says whether a run was still there to stop: a turn that
  // already ended is the normal outcome of a slow click, so it is not an error. Because the run reads the
  // stop at its next step boundary, this route returns while the turn is still finishing — the conversation
  // is the record of that, not this answer.
  if (req.method === 'POST' && url.pathname === '/api/agent/cancel') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin AI requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const { requestId } = await readJson(req);
    if (typeof requestId !== 'string' || !requestId) return sendError(res, 400, 'requestId is required');
    return sendJson(res, 200, { ok: true, cancelled: agentChat.cancel(requestId) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const body = await readJson(req);
    const title = typeof body.title === 'string' ? body.title : undefined;
    return sendJson(res, 201, { ok: true, session: repository.createSession({ title, profileId: activeProfileId }) });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/sessions') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin clear requests are not allowed');
    if (agentChat.busy) return sendError(res, 409, 'An AI operation is running');
    return sendJson(res, 200, { ok: true, deleted: repository.clearSessions(activeProfileId) });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/decks') {
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.meta(selectParams(url))) });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/decks') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin deck requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, { ok: true, deck: await ankiBrowser.createDeck(await readJson(req)) });
  }

  const deckRoute = url.pathname.match(/^\/api\/anki\/decks\/([^/]+)$/);
  if (deckRoute && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin deck requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const deck = await ankiBrowser.renameDeck(decodeURIComponent(deckRoute[1]), await readJson(req));
    await ankiSettings.renameVisibleDecks(deck.oldName, deck.name);
    return sendJson(res, 200, {
      ok: true, deck,
    });
  }

  if (deckRoute && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin deck requests are not allowed');
    const result = await ankiBrowser.deleteDeck(decodeURIComponent(deckRoute[1]));
    await ankiSettings.removeVisibleDecks(result.deleted);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/study-options') {
    const presetId = url.searchParams.get('presetId');
    return sendJson(res, 200, {
      ok: true,
      ...(await ankiBrowser.studyOptions({ ...selectParams(url), presetId: presetId || undefined })),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/study-options') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin study option requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, { ok: true, preset: await ankiBrowser.createStudyOptions(await readJson(req)) });
  }

  const studyOptionRoute = url.pathname.match(/^\/api\/anki\/study-options\/([^/]+)$/);
  if (studyOptionRoute && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin study option requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const id = decodeURIComponent(studyOptionRoute[1]);
    return sendJson(res, 200, { ok: true, preset: await ankiBrowser.updateStudyOptions(id, await readJson(req)) });
  }

  if (studyOptionRoute && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin study option requests are not allowed');
    const id = decodeURIComponent(studyOptionRoute[1]);
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteStudyOptions(id)) });
  }

  // Which preset a deck studies with is the deck's own field, so it is written on the deck's own route.
  const deckStudyOptionRoute = url.pathname.match(/^\/api\/anki\/decks\/([^/]+)\/study-options$/);
  if (deckStudyOptionRoute && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin deck requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const deckName = decodeURIComponent(deckStudyOptionRoute[1]);
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.setDeckStudyOptions(deckName, await readJson(req))) });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/models') {
    return sendJson(res, 200, { ok: true, models: await ankiBrowser.models(selectParams(url)) });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/models') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, { ok: true, model: await ankiBrowser.createModel(await readJson(req)) });
  }

  const modelRoute = url.pathname.match(/^\/api\/anki\/models\/([^/]+)$/);
  if (modelRoute && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.model(decodeURIComponent(modelRoute[1]), selectParams(url)),
    });
  }

  if (modelRoute && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.updateModel(decodeURIComponent(modelRoute[1]), await readJson(req)),
    });
  }

  if (modelRoute && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteModel(decodeURIComponent(modelRoute[1]))) });
  }

  const modelFields = url.pathname.match(/^\/api\/anki\/models\/([^/]+)\/fields$/);
  if (modelFields && req.method === 'POST') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, {
      ok: true, model: await ankiBrowser.addModelField(decodeURIComponent(modelFields[1]), await readJson(req)),
    });
  }

  const modelField = url.pathname.match(/^\/api\/anki\/models\/([^/]+)\/fields\/([^/]+)$/);
  if (modelField && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.updateModelField(decodeURIComponent(modelField[1]),
        decodeURIComponent(modelField[2]), await readJson(req)),
    });
  }

  if (modelField && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.deleteModelField(decodeURIComponent(modelField[1]),
        decodeURIComponent(modelField[2])),
    });
  }

  const modelTemplatesCollection = url.pathname.match(/^\/api\/anki\/models\/([^/]+)\/templates$/);
  if (modelTemplatesCollection && req.method === 'POST') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 201, {
      ok: true, model: await ankiBrowser.addModelTemplate(decodeURIComponent(modelTemplatesCollection[1]),
        await readJson(req)),
    });
  }

  const modelTemplate = url.pathname.match(/^\/api\/anki\/models\/([^/]+)\/templates\/([^/]+)$/);
  if (modelTemplate && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.updateModelTemplate(decodeURIComponent(modelTemplate[1]),
        decodeURIComponent(modelTemplate[2]), await readJson(req)),
    });
  }

  if (modelTemplate && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin note type requests are not allowed');
    return sendJson(res, 200, {
      ok: true, model: await ankiBrowser.deleteModelTemplate(decodeURIComponent(modelTemplate[1]),
        decodeURIComponent(modelTemplate[2])),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/tags') {
    return sendJson(res, 200, {
      ok: true,
      ...(await ankiBrowser.tags({
        query: url.searchParams.get('query'),
        select: url.searchParams.get('select'),
        limit: url.searchParams.get('limit'),
        all: url.searchParams.get('all') === 'true',
      })),
    });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/anki/tags'
    && url.searchParams.get('unused') === 'true') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin tag requests are not allowed');
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.clearUnusedTags()) });
  }

  const tagRoute = url.pathname.match(/^\/api\/anki\/tags\/([^/]+)$/);
  if (tagRoute && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin tag requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    return sendJson(res, 200, {
      ok: true, tag: await ankiBrowser.renameTag(decodeURIComponent(tagRoute[1]), await readJson(req)),
    });
  }

  if (tagRoute && req.method === 'DELETE') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin tag requests are not allowed');
    return sendJson(res, 200, { ok: true, ...(await ankiBrowser.deleteTag(decodeURIComponent(tagRoute[1]))) });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/notes') {
    const limit = Number(url.searchParams.get('limit'));
    const options = {
      query: url.searchParams.get('query'),
      skip: url.searchParams.get('skip'),
      limit,
      all: url.searchParams.get('all') === 'true',
      includeIds: url.searchParams.get('includeIds') === 'true',
      sortField: url.searchParams.get('sortField'),
      sortDirection: url.searchParams.get('sortDirection'),
      select: url.searchParams.get('select'),
    };
    const result = await ankiBrowser.search(options);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/notes/new') {
    return sendJson(res, 200, {
      ok: true,
      note: await ankiBrowser.newNoteTemplate({
        ...selectParams(url), modelName: url.searchParams.get('modelName') || undefined,
      }),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/notes') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    return sendJson(res, 201, { ok: true, note: await ankiBrowser.createNote(body) });
  }

  if (req.method === 'POST' && url.pathname === '/api/anki/notes/batch') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    const result = body.action === 'changeDeck'
      ? await ankiBrowser.batchChangeDeck(body)
      : body.action === 'setDueDate'
        ? await ankiBrowser.batchSetDueDate(body)
        : body.action === 'setFlag'
          ? await ankiBrowser.batchSetNoteFlag(body)
          : body.action === 'copy'
            ? await ankiBrowser.batchCopyNotes(body)
            : body.action === 'delete'
              ? await ankiBrowser.batchDeleteNotes(body)
              : null;
    if (!result) return sendError(res, 400, 'action must be changeDeck, setDueDate, setFlag, copy or delete');
    return sendJson(res, 200, { ok: true, result });
  }

  if (req.method === 'GET' && url.pathname === '/api/anki/undo-status') {
    return sendJson(res, 200, { ok: true, status: await ankiBrowser.undoStatus() });
  }

  if (req.method === 'POST' && (url.pathname === '/api/anki/undo' || url.pathname === '/api/anki/redo')) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    const status = url.pathname === '/api/anki/undo' ? await ankiBrowser.undo() : await ankiBrowser.redo();
    return sendJson(res, 200, { ok: true, status });
  }

  const ankiNoteId = url.pathname.match(/^\/api\/anki\/notes\/([^/]+)$/)?.[1];
  if (ankiNoteId && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, note: await ankiBrowser.getNote(ankiNoteId, selectParams(url)) });
    }
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    const noteId = decodeURIComponent(ankiNoteId);
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { ok: true, note: await ankiBrowser.deleteNote(noteId) });
    }
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    return sendJson(res, 200, { ok: true, note: await ankiBrowser.updateNote(noteId, body) });
  }

  const ankiNotePreviewId = url.pathname.match(/^\/api\/anki\/notes\/([^/]+)\/preview$/)?.[1];
  if (ankiNotePreviewId && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, preview: await ankiBrowser.previewNote(decodeURIComponent(ankiNotePreviewId)) });
  }

  const ankiCopyNoteId = url.pathname.match(/^\/api\/anki\/notes\/([^/]+)\/copy$/)?.[1];
  if (ankiCopyNoteId && req.method === 'POST') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    return sendJson(res, 201, { ok: true, note: await ankiBrowser.copyNote(decodeURIComponent(ankiCopyNoteId)) });
  }

  const ankiNoteTagsId = url.pathname.match(/^\/api\/anki\/notes\/([^/]+)\/tags$/)?.[1];
  if (ankiNoteTagsId && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    const note = await ankiBrowser.updateNoteTags(decodeURIComponent(ankiNoteTagsId), body);
    return sendJson(res, 200, { ok: true, note });
  }

  const ankiNoteDueId = url.pathname.match(/^\/api\/anki\/notes\/([^/]+)\/due$/)?.[1];
  if (ankiNoteDueId && req.method === 'PUT') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki write requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    const note = await ankiBrowser.changeNoteDueDate(decodeURIComponent(ankiNoteDueId), body);
    return sendJson(res, 200, { ok: true, note });
  }

  const sessionRoute = sessionRouteFromPath(url.pathname);
  const sessionId = sessionRoute?.id;
  if (req.method === 'DELETE' && sessionId && !sessionRoute.action) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin delete requests are not allowed');
    if (agentChat.busy) return sendError(res, 409, 'An AI operation is running');
    if (!repository.deleteSession(sessionId, activeProfileId)) return sendError(res, 404, 'Session not found');
    return sendJson(res, 200, { ok: true, deleted: 1 });
  }
  if (req.method === 'POST' && sessionRoute?.action === 'chat') {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin Anki writes are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    if (!repository.getSession(sessionId, activeProfileId)) return sendError(res, 404, 'Session not found');
    // The run re-reads the instruction directory itself, so the one thing added here is the log line for a file
    // that cannot be read: the directory is asked before the turn that would have skipped it, and the failure
    // set is announced only when it changes. A profile is the same bargain one directory over — the agent
    // re-reads it every turn too, and the agent can now write it, so the file that defines what a card is has
    // to be announced when it stops compiling.
    instructionLibrary.refresh();
    reportInstructionFailures();
    cardProfileLibrary.refresh();
    reportCardProfileFailures();
    const { content, requestId, selectionNoteIds, retry, reasoningEffort, stream } = await readJson(req);
    if (typeof content !== 'string' || !content.trim() || typeof requestId !== 'string' || !requestId) {
      return sendError(res, 400, 'content and requestId are required');
    }
    if (reasoningEffort !== undefined && !EFFORT_CHOICES.includes(reasoningEffort)) {
      return sendError(res, 400, `reasoningEffort must be one of: ${EFFORT_CHOICES.join(', ')}`);
    }
    const options = {
      content, requestId, retry: retry === true, reasoningEffort,
      selectionNoteIds: normalizeNoteIds(selectionNoteIds),
    };
    if (stream === true) {
      const outcome = await streamChat(res, emit => agentChat.send(sessionId, { ...options, onEvent: emit }));
      if (outcome.error) {
        return sendError(res, outcome.error.statusCode || 500, outcome.error.message, { code: outcome.error.code });
      }
      return outcome.streamed ? undefined : sendJson(res, 200, outcome.payload);
    }
    return sendJson(res, 200, await agentChat.send(sessionId, options));
  }
  if (req.method === 'POST' && ['anki-preview', 'anki-add'].includes(sessionRoute?.action)) {
    if (isCrossOrigin(req)) return sendError(res, 403, 'Cross-origin export requests are not allowed');
    if (!isJsonRequest(req)) return sendError(res, 415, 'Content-Type must be application/json');
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'Expected JSON object');
    const result = sessionRoute.action === 'anki-preview'
      ? await ankiExport.preview(sessionId, body.cardVersionId, body.cardIndex, body.deck)
      : await ankiExport.add(sessionId, body);
    return sendJson(res, 200, { ok: true, export: result });
  }

  if (req.method === 'GET' && sessionRoute?.action === 'anki-exports') {
    if (!repository.getSession(sessionId, activeProfileId)) return sendError(res, 404, 'Session not found');
    return sendJson(res, 200, {
      ok: true, exports: repository.listAnkiExports(sessionId, activeProfileId).map(serializeExport),
    });
  }
  if (req.method === 'POST' && sessionRoute?.action === 'messages') {
    return sendError(res, 410, 'Use /api/sessions/:id/chat with an Agent profile configured in the app');
  }

  if (req.method === 'PUT' && sessionRoute?.action === 'cards') {
    if (!repository.getSession(sessionId, activeProfileId)) return sendError(res, 404, 'Session not found');
    const contract = cardContract();
    // A manual card version is only meaningful as the note type's own storage, so there is nothing to
    // validate it against and nothing to say about it: the collection's note type needs a profile first.
    if (!contract) {
      return sendError(res, 503,
        `No card profile is configured for the ${config.anki.modelName} note type`);
    }
    const body = await readJson(req);
    const validation = contract.validateCards(body.cards);
    const cardVersion = repository.createCardVersion({
      sessionId,
      cards: validation.cards,
      schemaVersion: contract.version,
      source: 'manual',
      validationStatus: validation.valid ? 'valid' : 'invalid',
      validationErrors: validation.errors,
      profileId: activeProfileId,
    });
    return sendJson(res, validation.valid ? 200 : 422, {
      ok: validation.valid,
      error: validation.valid ? undefined : 'Card validation failed',
      cardVersion: serializeCardVersion(cardVersion),
    });
  }

  if (req.method === 'GET' && sessionId && !sessionRoute.action) {
    const session = repository.getSession(sessionId, activeProfileId);
    if (!session) return sendError(res, 404, 'Session not found');
    const currentVersion = repository.getCurrentCardVersion(sessionId, activeProfileId);
    return sendJson(res, 200, {
      ok: true,
      session,
      messages: repository.listMessages(sessionId, activeProfileId),
      currentCardVersion: serializeCardVersion(currentVersion),
      cardVersions: repository.listCardVersions(sessionId, activeProfileId).map(serializeCardVersion),
    });
  }

  return sendError(res, 404, 'API route not found');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      res.apiStartedAt = performance.now();
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.message === 'Payload too large' ? 413 : error.statusCode || 500;
    if (!res.headersSent) sendError(res, status, error.message, { code: error.code });
  }
});

function close () {
  ankiClient.close();
  db.close();
  server.close(() => process.exit(0));
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

server.listen(config.port, config.host, () => {
  process.stdout.write(`caro-anki listening at http://${config.host}:${config.port}\n`);
});
