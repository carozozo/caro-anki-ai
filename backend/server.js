const http = require('node:http');
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
const { AnkiMaintenance } = require('./anki-maintenance');
const { AnkiAccount } = require('./anki-account');
const syncProgress = require('./sync-progress');
const { AnkiExport, serializeExport } = require('./anki-export');
const { SkillLibrary } = require('./skill-library');
const { InstructionLibrary } = require('./instruction-library');
const { AgentMemory } = require('./agent-memory');
const { CardProfileLibrary } = require('./card-profile-library');
const { streamChat } = require('./chat-stream');
const { ProfileManager } = require('./profile-manager');
const {
  createStaticHandler,
  isCrossOrigin,
  isJsonRequest,
  normalizeNoteIds,
  readJson,
  selectParams,
  sendError,
  sendJson,
} = require('./http');
const { createApiRoutes } = require('./routes/api');

const config = loadConfig();
const db = createDatabase({ dbPath: config.sqlitePath, migrationsDir: config.migrationsDir });
const repository = new Repository(db);
const profileManager = new ProfileManager({ repository, ankiConfig: config.anki });
const initialAnkiProfile = profileManager.initialize();
const ankiSettings = new AnkiSettings({ repository, config: config.anki, profileId: initialAnkiProfile.id });
const ankiClient = new AnkiLocal(config.anki);
const ankiMaintenance = new AnkiMaintenance({ client: ankiClient });
const ankiAccount = new AnkiAccount({
  repository,
  client: ankiClient,
  keychain: new KeychainStore({ service: config.keychain.syncService }),
  profileId: initialAnkiProfile.id,
  legacyProfileId: repository.listAnkiProfiles()[0]?.id || initialAnkiProfile.id,
});
const cardProfileLibrary = new CardProfileLibrary({ dir: config.cardProfilesDir });
cardProfileLibrary.initialize();
const cardContract = () => cardProfileLibrary.get(config.anki.modelName);
const ankiExport = new AnkiExport({
  repository,
  client: ankiClient,
  config: config.anki,
  cardProfiles: cardProfileLibrary,
  getProfileId: () => profileManager.active().id,
});
const ankiBrowser = new AnkiBrowser({
  client: ankiClient,
  config: config.anki,
  cardProfiles: cardProfileLibrary,
});
const skillLibrary = new SkillLibrary({ dir: config.skillsDir, seedDir: config.skillsSeedDir });
skillLibrary.initialize();
const instructionLibrary = new InstructionLibrary({ dir: config.instructionsDir });
instructionLibrary.initialize();
const agentMemory = new AgentMemory({ dir: config.memoriesDir, repository });
agentMemory.initialize();

const reportLibraryFailures = (library, label) => {
  let reported = '';
  return () => {
    const signature = JSON.stringify(library.errors());
    if (signature === reported) return;
    reported = signature;
    for (const { name, error } of library.errors()) {
      process.stdout.write(`caro-anki ${label}: cannot read ${name}: ${error}\n`);
    }
  };
};
const reportInstructionFailures = reportLibraryFailures(instructionLibrary, 'instructions');
const reportCardProfileFailures = reportLibraryFailures(cardProfileLibrary, 'card profiles');
reportInstructionFailures();
reportCardProfileFailures();

const agentManager = new AgentManager({
  repository,
  keychain: new KeychainStore({ service: config.keychain.agentService }),
  browser: ankiBrowser,
  client: ankiClient,
  ankiConfig: config.anki,
  skills: skillLibrary,
  instructions: instructionLibrary,
  memories: agentMemory,
  cardProfiles: cardProfileLibrary,
});
const agentChat = new AgentChat({
  db,
  repository,
  getAgent: () => agentManager.getAgent(),
  getProfileId: () => profileManager.active().id,
});
profileManager.attach(ankiClient, {
  createCollection: async collectionPath => {
    const client = new AnkiLocal({ ...config.anki, collectionPath });
    try {
      await client.invoke('modelNames', {});
    } finally {
      await client.close();
    }
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

const ankiRuntimeStatus = () => {
  const error = ankiRuntimeProblem(config.anki);
  return { available: !error, bundled: Boolean(config.anki.helperPath), error };
};
const handleApi = createApiRoutes({
  EFFORT_CHOICES,
  agentChat,
  agentManager,
  agentMemory,
  ankiAccount,
  ankiBrowser,
  ankiExport,
  ankiMaintenance,
  ankiRuntimeStatus,
  ankiSettings,
  cardContract,
  cardProfileLibrary,
  instructionLibrary,
  isCrossOrigin,
  isJsonRequest,
  modelName: config.anki.modelName,
  normalizeNoteIds,
  profileManager,
  readJson,
  reportCardProfileFailures,
  reportInstructionFailures,
  repository,
  selectParams,
  sendError,
  sendJson,
  serializeExport,
  skillLibrary,
  streamChat,
  syncProgress,
});
const serveStatic = createStaticHandler({ frontendDir: config.frontendDir, appTitle: config.app.title });

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

const close = () => {
  ankiClient.close();
  db.close();
  server.close(() => process.exit(0));
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
server.listen(config.port, config.host, () => {
  process.stdout.write(`caro-anki listening at http://${config.host}:${config.port}\n`);
});
