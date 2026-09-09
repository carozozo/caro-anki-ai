const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKILL_FILE = 'SKILL.md';
const REFERENCE_DIR = 'references';
const SEED_MARKER = '.caro-seeded';
const VERSION_DIR = 'versions';
const VERSION_KEEP = 10;
const SKILL_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SKILL_NAME_LIMIT = 64;
const SKILL_DESCRIPTION_LIMIT = 1024;
const SKILL_BODY_LIMIT = 16000;
const CATALOGUE_DESCRIPTION_CHARS = 250;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:md|txt)$/;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const TRUNCATION_MARK = '\n\n…(truncated)';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const resolveUserPath = value => path.resolve(String(value).replace(/^~(?=$|\/)/, os.homedir()));

function isSkillName (value) {
  return value.length <= SKILL_NAME_LIMIT && !value.includes('--') && SKILL_NAME_PATTERN.test(value);
}

// A skill is addressed by name, and users type it as a slash command, so `/Card-Audit` resolves to the
// `card-audit` folder. Anything that is not a valid name resolves to '' instead of being guessed at.
function skillToken (value) {
  const token = String(value ?? '').trim().replace(/^\//, '').toLowerCase();
  return isSkillName(token) ? token : '';
}

// The composer pins a skill by starting the message with its command, so the request itself names the
// procedure to apply. Only the first word can be a command — a slash later in the sentence is prose — and
// the command ends at whitespace, which is what makes everything after it the skill's argument.
const COMMAND_PATTERN = /^\/([^\s/]*)(?=\s|$)/;
function commandName (text) {
  const match = String(text ?? '').trim().match(COMMAND_PATTERN);
  return match ? skillToken(match[1]) : '';
}

// References are the skill's second layer, read one at a time. Only a plain file name inside the skill's
// own `references/` directory is allowed: no nesting, no traversal, no absolute paths.
function referenceRelPath (file) {
  const value = String(file ?? '').trim();
  if (!value || value.startsWith('/') || value.includes('..') || value.includes('\\')) return '';
  return REFERENCE_PATTERN.test(value) ? value : '';
}

// The two shapes a skill folder holds, and nothing else: the body at its root, and a reference file one level
// down. Anything else — a nested folder, an absolute path, a dotfile, another extension — is a file the loader
// would never hand the model, so it resolves to '' and the caller refuses it.
function skillFilePath (file) {
  const value = String(file ?? '').trim();
  if (value === SKILL_FILE) return value;
  if (!value.startsWith(`${REFERENCE_DIR}/`)) return '';
  const reference = referenceRelPath(value.slice(REFERENCE_DIR.length + 1));
  return reference ? `${REFERENCE_DIR}/${reference}` : '';
}

function parseFrontmatter (block) {
  return block.split(/\r?\n/).reduce((meta, line) => {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/);
    if (!match) return meta;
    const value = match[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    meta[match[1].toLowerCase()] = value;
    return meta;
  }, {});
}

// `meta` is null when the document has no frontmatter block at all, which is a different failure from a
// block that is present but missing a required field.
function parseSkillMarkdown (text) {
  const source = String(text ?? '');
  const match = source.match(FRONTMATTER_PATTERN);
  if (!match) return { meta: null, body: source.trim() };
  return { meta: parseFrontmatter(match[1]), body: source.slice(match[0].length).trim() };
}

const clip = (text, limit, mark) => text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}${mark}`;
const flag = (value, fallback) => value === undefined || value === '' ? fallback : value.toLowerCase() !== 'false';

class SkillLibrary {
  constructor ({ dir, seedDir = '' }) {
    this.dir = resolveUserPath(dir);
    this.seedDir = seedDir ? resolveUserPath(seedDir) : '';
    this.skills = new Map();
    this.failures = [];
    this.seedNames = new Set();
  }

  // Seeds are copied once — a marker file records that it happened — so a user edit is never overwritten
  // and a deleted skill is not silently restored. Later bundled skills are copied by hand from the repo.
  seed () {
    if (fs.existsSync(path.join(this.dir, SEED_MARKER))) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    if (this.seedDir && fs.existsSync(this.seedDir)) {
      fs.cpSync(this.seedDir, this.dir, { recursive: true, force: false, errorOnExist: false });
    }
    fs.writeFileSync(path.join(this.dir, SEED_MARKER),
      'Bundled skills were copied here once. Delete this file to copy them again.\n', { flag: 'wx' });
    return true;
  }

  initialize () {
    this.seed();
    return this.refresh();
  }

  refresh () {
    const skills = new Map();
    const failures = [];
    this.seedNames = this.#seedNames();
    for (const name of this.#skillDirs()) {
      const { skill, error } = this.#load(name);
      if (error) failures.push({ name, error });
      else if (skill) skills.set(skill.name, skill);
    }
    const byName = (left, right) => left.name.localeCompare(right.name);
    this.skills = new Map([...skills.values()].sort(byName).map(skill => [skill.name, skill]));
    this.failures = failures.sort(byName);
    return this.list();
  }

  list () {
    return [...this.skills.values()].map(({ name, description, argumentHint, userInvocable,
      disableModelInvocation, references }) => ({ name, description, argumentHint, userInvocable,
      disableModelInvocation, references }));
  }

  names () { return [...this.skills.keys()]; }

  // Settings hides bundled procedures without taking them away from the slash menu or the model catalogue.
  entries () {
    return [...this.skills.values()].map(({ name, description, body, seeded }) => ({
      name, description, body, ...(seeded ? { seeded: true } : {}),
    }));
  }

  errors () { return [...this.failures]; }

  resolve (name) {
    const skill = this.skills.get(skillToken(name));
    if (!skill) fail(`unknown skill: ${String(name ?? '')}`, 404);
    return skill;
  }

  // The skill a message pins with a leading command, or null. An unknown or invalid name, and a skill its
  // author kept out of the slash menu, all read as "no command": the text stays ordinary prose and the
  // model is still free to load the skill itself.
  pinned (text) {
    const name = commandName(text);
    const skill = name ? this.skills.get(name) : null;
    return skill?.userInvocable ? skill : null;
  }

  // The catalogue is what the model sees up front; a library with no usable skill contributes nothing to
  // the prompt, which is what keeps skill support additive for a user who never writes one.
  catalogue ({ maxDescription = CATALOGUE_DESCRIPTION_CHARS } = {}) {
    const skills = [...this.skills.values()].filter(skill => !skill.disableModelInvocation);
    if (!skills.length) return '';
    const lines = skills.map(skill => `- ${skill.name}: ${clip(skill.description, maxDescription, ' …')}`);
    return ['## Skills',
      ...lines,
      'Load a skill before acting on it — its description alone is not the instructions.'].join('\n');
  }

  // `body` is the progressive-disclosure entry point: the skill's own instructions, or one reference file
  // from its `references/` directory.
  body (name, { file = '' } = {}) {
    const skill = this.resolve(name);
    if (!file) return clip(skill.body, SKILL_BODY_LIMIT, TRUNCATION_MARK);
    const reference = referenceRelPath(file);
    if (!reference) fail(`invalid skill reference: ${String(file)}`);
    const text = fs.readFileSync(this.#referenceFile(skill, reference), 'utf8').trim();
    return clip(text, SKILL_BODY_LIMIT, TRUNCATION_MARK);
  }

  // The read half of a save: the same name and body rules, the same answer to "would this replace a file?",
  // and nothing touched on disk. A skill is a folder, so its files travel together — the body and every
  // reference — and it is the folder that a save creates, which is why the name is validated as a new skill
  // name in every case: a folder the loader would skip is one the model could never be told about.
  check (name, files) {
    const { folder, created, entries } = this.#plan(name, files);
    return {
      name: folder,
      created,
      files: entries.map(({ path: file, bytes, exists }) => ({ path: file, bytes, exists })),
    };
  }

  // Saving is the only write this library performs, and what it replaces is the user's own procedure, so the
  // shape is validated here rather than trusted from a caller, every file that is overwritten is kept first,
  // and each one lands by rename so a failure leaves the previous version in place.
  save (name, files) {
    const { folder, created, entries } = this.#plan(name, files);
    const saved = entries.map(entry => {
      const target = path.join(this.dir, folder, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const backup = entry.exists ? this.#version(folder, entry.path, target) : '';
      this.#replace(target, entry.written);
      return { path: entry.path, bytes: entry.bytes, created: !entry.exists, backup };
    });
    this.refresh();
    return { name: folder, created, files: saved };
  }

  // A rename is a folder move plus the one line of frontmatter that has to follow it: the loader matches
  // `name` against the folder, so a folder moved on its own is a skill the catalogue silently loses. Nothing
  // else in the text changes — a rename is not a rewrite of a procedure the user already wrote. The target
  // must be free, because the operation that tidies a name must never be the one that destroys a folder.
  checkRename (name, to) {
    const { from, to: target, dir } = this.#planRename(name, to);
    return { name: from, to: target, bytes: this.#folderBytes(dir) };
  }

  // The copies under `versions/` come first, so a rename is as recoverable as a replacement: the folder that
  // is left behind keeps its references as well as its body, and the loader never reads any of them.
  rename (name, to) {
    const { name: from, to: target } = this.checkRename(name, to);
    const dir = path.join(this.dir, from);
    const backup = this.#versionFolder(from, dir);
    fs.renameSync(dir, path.join(this.dir, target));
    this.#followFolder(path.join(this.dir, target), target);
    this.refresh();
    return { name: from, to: target, backup };
  }

  // Retiring a skill is a different wish from rewriting one, and it is the one operation the user asked for by
  // name, so it is its own pair rather than a folder with an empty body passed to `save()`. Nothing is
  // written: the skill has to be installed, and what a removal would do is answered without deleting anything.
  checkRemove (name) {
    const skill = this.resolve(name);
    return { name: skill.name, bytes: this.#folderBytes(skill.dir) };
  }

  // A skill that is gone is gone from the menu and the catalogue in the same refresh, and the folder kept
  // under `versions/` is the whole of what makes that reversible.
  remove (name) {
    const skill = this.resolve(name);
    const backup = this.#versionFolder(skill.name, skill.dir);
    fs.rmSync(skill.dir, { recursive: true, force: true });
    this.refresh();
    return { name: skill.name, backup };
  }

  // Everything a save needs, decided before anything is written: the folder, whether it is new, and each file
  // with the text as it will land on disk. `check()` and `save()` both run through it, which is what makes a
  // proposal validated here one a save cannot refuse later.
  #plan (name, files) {
    const folder = skillToken(name);
    if (!folder) fail(`a skill name must be a lowercase name such as card-audit: ${String(name ?? '')}`);
    const list = Array.isArray(files) ? files : [];
    if (!list.length) fail('files must contain at least one file');
    const dir = path.join(this.dir, folder);
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) {
      fail(`refusing to save ${folder}: ${dir} is not a directory`);
    }
    const entries = list.map(entry => this.#planFile(folder, dir, entry));
    const paths = entries.map(({ path: file }) => file);
    if (new Set(paths).size !== paths.length) fail('files must name each path exactly once');
    if (!paths.includes(SKILL_FILE)) fail(`${SKILL_FILE} is required: it is what makes the folder a skill`);
    return { folder, created: !fs.existsSync(path.join(dir, SKILL_FILE)), entries };
  }

  // A file is addressable in the two shapes a skill folder holds and no others, so a path the loader could
  // not read back — nested deeper, absolute, or naming a dotfile — is refused rather than written where the
  // skill would never see it. The body is checked as the loader will read it, because a folder whose
  // frontmatter cannot be parsed is an error the next refresh reports rather than a skill.
  #planFile (folder, dir, { path: file, content } = {}) {
    const relative = skillFilePath(file);
    if (!relative) {
      fail(`invalid skill file: ${String(file ?? '') || '(missing)'}`
        + ` — expected ${SKILL_FILE} or ${REFERENCE_DIR}/<name>.md`);
    }
    const text = String(content ?? '');
    if (!text.trim()) fail(`${relative} is empty: a file the user cannot read is not worth saving`);
    if (text.length > SKILL_BODY_LIMIT) {
      fail(`${relative} exceeds ${SKILL_BODY_LIMIT} characters, which the prompt would silently truncate`);
    }
    if (relative === SKILL_FILE) this.#planBody(folder, text);
    const target = path.join(dir, relative);
    const written = text.endsWith('\n') ? text : `${text}\n`;
    return { path: relative, written, bytes: Buffer.byteLength(written, 'utf8'), exists: this.#claimable(target) };
  }

  // The body is the one file whose contents are a contract rather than prose: the loader answers with its
  // frontmatter name and its catalogue line, so a body that does not load is refused here instead of being
  // left behind as a skill that silently disappears from the catalogue.
  #planBody (folder, text) {
    const { meta, body } = parseSkillMarkdown(text);
    const error = this.#validate(folder, meta);
    if (error) fail(error);
  }

  // The two names a rename connects, decided before anything moves: the source is a skill the library has
  // already loaded, the target is a name the loader could read back, they must differ, and the target has to
  // be free — a rename never overwrites a folder.
  #planRename (name, to) {
    const from = this.resolve(name).name;
    const target = skillToken(to);
    if (!target) fail(`a skill name must be a lowercase name such as card-audit: ${String(to ?? '')}`);
    if (from === target) fail(`a rename must change the name: ${from} is already its own name`);
    if (fs.existsSync(path.join(this.dir, target))) {
      fail(`refusing to rename onto ${target}: that skill already exists`);
    }
    return { from, to: target, dir: path.join(this.dir, from) };
  }

  // Everything the folder holds that the loader would read back, which is what a rename and a removal have to
  // preserve: a copy of the body alone would lose the references that body names.
  #folderFiles (dir) {
    return [SKILL_FILE, ...this.#references(dir).map(file => `${REFERENCE_DIR}/${file}`)]
      .filter(file => fs.existsSync(path.join(dir, file)));
  }

  #folderBytes (dir) {
    return this.#folderFiles(dir).reduce((total, file) => total + fs.statSync(path.join(dir, file)).size, 0);
  }

  // A folder is versioned whole, under the name it had, so the copies travel with the thing they are a copy
  // of — and since `versions/` holds no readable `SKILL.md` at a folder's root, none of it is ever loaded.
  #versionFolder (folder, dir) {
    for (const file of this.#folderFiles(dir)) this.#version(folder, file, path.join(dir, file));
    return path.join(VERSION_DIR, folder);
  }

  // The frontmatter name is what ties a body to its folder, so it is the one line a rename rewrites — and the
  // only one: everything else in the file is the user's own text.
  #followFolder (dir, name) {
    const target = path.join(dir, SKILL_FILE);
    const text = fs.readFileSync(target, 'utf8');
    this.#replace(target, text.replace(FRONTMATTER_PATTERN,
      block => block.replace(/^([ \t]*name[ \t]*:[ \t]*).*$/mi, `$1${name}`)));
  }

  // Anything other than a regular file is something the loader cannot read, and a symlink would make the
  // backup read a file from outside the folder — so both are refused rather than followed.
  #claimable (target) {
    try {
      const stats = fs.lstatSync(target);
      if (stats.isFile()) return true;
      fail(stats.isSymbolicLink()
        ? `refusing to save over the symlink ${target}`
        : `refusing to save over something that is not a file: ${target}`);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  // The text a save replaces is kept under the library's own `versions/`, which the loader never reads
  // because a folder there holds no readable `SKILL.md` at its root. A reference is versioned beside itself,
  // under the same two-level shape, so the copy of a replaced reference is pruned with its own kind rather
  // than as a name that no directory lists. Names are stamped and then de-duplicated, so two saves in the
  // same millisecond stay two copies, and the oldest beyond the cap is dropped.
  #version (folder, file, target) {
    const root = path.join(this.dir, VERSION_DIR, folder, path.dirname(file));
    fs.mkdirSync(root, { recursive: true });
    const leaf = path.basename(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backup = path.join(root, `${leaf}.${stamp}`);
    for (let index = 1; fs.existsSync(backup); index++) backup = path.join(root, `${leaf}.${stamp}-${index}`);
    fs.copyFileSync(target, backup);
    const mine = fs.readdirSync(root).filter(entry => entry.startsWith(`${leaf}.`)).sort();
    mine.slice(0, -VERSION_KEEP).forEach(stale => fs.rmSync(path.join(root, stale), { force: true }));
    return path.relative(this.dir, backup);
  }

  // A temporary name beside the target keeps the rename on one filesystem, which is what makes it atomic, and
  // its leading dot keeps a leftover from a crash out of the catalogue.
  #replace (target, text) {
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, text, { flag: 'wx' });
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  #skillDirs () {
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter(entry => fs.existsSync(path.join(this.dir, entry.name, SKILL_FILE)))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  // A bundled folder retains its identity after the one-time copy, including when a user edits its contents.
  // Names are the available provenance for installs created before there was per-skill seed metadata.
  #seedNames () {
    if (!this.seedDir) return new Set();
    let entries;
    try {
      entries = fs.readdirSync(this.seedDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return new Set();
      throw error;
    }
    return new Set(entries.filter(entry => entry.isDirectory()
      && fs.existsSync(path.join(this.seedDir, entry.name, SKILL_FILE))).map(entry => entry.name));
  }

  #load (folder) {
    const dir = path.join(this.dir, folder);
    const { meta, body } = parseSkillMarkdown(fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8'));
    const error = this.#validate(folder, meta);
    if (error) return { error };
    return { skill: { name: folder, dir, body, references: this.#references(dir),
      description: meta.description, argumentHint: meta['argument-hint'] || '',
      userInvocable: flag(meta['user-invocable'], true),
      disableModelInvocation: flag(meta['disable-model-invocation'], false), seeded: this.seedNames.has(folder) } };
  }

  #validate (folder, meta) {
    if (!meta) return 'missing frontmatter block';
    if (!isSkillName(folder)) return `invalid skill folder name: ${folder}`;
    if (!meta.name) return 'missing frontmatter name';
    if (!isSkillName(meta.name)) return `invalid frontmatter name: ${meta.name}`;
    if (meta.name !== folder) return `frontmatter name "${meta.name}" does not match folder "${folder}"`;
    if (!meta.description) return 'missing frontmatter description';
    if (meta.description.length > SKILL_DESCRIPTION_LIMIT) {
      return `description exceeds ${SKILL_DESCRIPTION_LIMIT} characters`;
    }
    return '';
  }

  #references (dir) {
    const root = path.join(dir, REFERENCE_DIR);
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter(entry => entry.isFile() && referenceRelPath(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  // Name and reference are already validated, so the only remaining escape is a symlink inside the skill
  // directory pointing outside it; resolving the real paths is what catches that.
  #referenceFile (skill, reference) {
    const target = path.join(skill.dir, REFERENCE_DIR, reference);
    let real;
    try {
      real = fs.realpathSync(target);
    } catch (error) {
      if (error.code === 'ENOENT') fail(`unknown skill reference: ${reference}`, 404);
      throw error;
    }
    const root = fs.realpathSync(skill.dir);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) fail('skill reference escapes its skill directory');
    return real;
  }
}

module.exports = { CATALOGUE_DESCRIPTION_CHARS, REFERENCE_DIR, SKILL_BODY_LIMIT, SKILL_DESCRIPTION_LIMIT,
  SKILL_FILE, SKILL_NAME_LIMIT, VERSION_DIR, VERSION_KEEP, SkillLibrary, commandName, parseSkillMarkdown,
  referenceRelPath, skillFilePath, skillToken };
