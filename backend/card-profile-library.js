const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkProfile, compileProfile } = require('./card-profile');

const EXTENSION = '.json';
const WRITE = 'write';
const EDIT = 'edit';
const RENAME = 'rename';
const REMOVE = 'remove';
const VERSION_DIR = 'versions';
const VERSION_KEEP = 10;
const INDENT = 2;

const resolveUserPath = value => path.resolve(String(value).replace(/^~(?=$|\/)/, os.homedir()));
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const asParts = value => (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter(Boolean);
// What this library writes is its own text: 2-space JSON with one trailing newline. A hand-formatted file is
// therefore reformatted by the first change it receives, which is why every change keeps its predecessor
// under `versions/` — the layout a save replaces is as recoverable as the values it replaces.
const serialize = profile => `${JSON.stringify(profile, null, INDENT)}\n`;
const holdsField = (entry, field) => isObject(entry) && asParts(entry.of).includes(field);
const changedKeys = (prefix, keys, unset) =>
  [...keys.map(key => `set ${prefix}${key}`), ...unset.map(key => `unset ${prefix}${key}`)];

// A profile is one file, and one change to it is one of four things: replaced whole, changed at one location,
// renamed with the note type it describes, or retired. Every one of them is checked before it lands, because
// a profile is not prose — it holds the Anki field names, separators and storage templates the app writes
// notes through, so a body that does not compile is a note that can never be created.
class CardProfileLibrary {
  constructor ({ dir }) {
    this.dir = resolveUserPath(dir);
    this.profiles = new Map();
    this.sources = new Map();
    this.failures = [];
  }

  initialize () {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.refresh();
  }

  #files () {
    let entries;
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter(entry => entry.isFile() && !entry.name.startsWith('.')
        && path.extname(entry.name).toLowerCase() === EXTENSION)
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  refresh () {
    const profiles = new Map();
    const sources = new Map();
    const failures = [];

    for (const fileName of this.#files()) {
      const filePath = path.join(this.dir, fileName);
      try {
        const text = fs.readFileSync(filePath, 'utf8').trim();
        if (!text) continue;
        const parsed = JSON.parse(text);
        const errors = checkProfile(parsed);
        if (errors.length > 0) {
          failures.push({ name: fileName, error: errors.join('; ') });
          continue;
        }
        const contract = compileProfile(parsed);
        // Indexed by noteType (and also by filename stem for convenience), with the file each key came from
        // beside it, so a write lands in the file a note type already has rather than in a second one.
        profiles.set(contract.noteType, contract);
        sources.set(contract.noteType, fileName);
        const baseName = path.basename(fileName, EXTENSION);
        if (!profiles.has(baseName)) {
          profiles.set(baseName, contract);
          sources.set(baseName, fileName);
        }
      } catch (error) {
        failures.push({ name: fileName, error: error.message });
      }
    }

    this.profiles = profiles;
    this.sources = sources;
    this.failures = failures;
    return this.list();
  }

  list () {
    return Array.from(new Set(Array.from(this.profiles.values()).map(profile => profile.noteType)));
  }

  // One shape for both libraries: the instruction library reports the same `{ name, error }` pair, so the
  // server logs a broken profile exactly as it logs a broken instruction file.
  errors () {
    return this.failures.map(failure => ({ ...failure }));
  }

  get (noteType) {
    if (!noteType) return null;
    return this.profiles.get(noteType) ?? null;
  }

  // Where the profile for this note type would live. Guidance the agent gives a user who has none names a
  // path this library really reads, so the file they write is the file that answers the next turn.
  pathFor (noteType) {
    return path.join(this.dir, `${String(noteType || 'profile').replace(/[/\\:]/g, '-')}${EXTENSION}`);
  }

  // The read half of a write: the profile is judged by the grammar's own validators plus a real compile, and
  // the answer says whether the file exists yet — all without touching the directory, so a proposal checked
  // here is one `save()` cannot refuse. `save()` runs through it, so the two can never disagree.
  check (profile) {
    const { noteType, content } = this.#validated(profile);
    const name = path.basename(this.#target(noteType));
    return { name, noteType, bytes: Buffer.byteLength(content, 'utf8'),
      created: !this.#claimable(path.join(this.dir, name)), content };
  }

  // The read half of an edit, over the profile as it is on disk: the merged result is what gets validated and
  // what the answer carries, so the file an edit would produce is the file the user is shown.
  checkEdit (edit = {}) {
    const { noteType, file } = this.#installed(edit.noteType, 'edit');
    const { profile, field, changes } = this.#edited(this.#raw(file), edit);
    const { content } = this.#validated(profile);
    return { name: file, noteType, field, changes, bytes: Buffer.byteLength(content, 'utf8'), content };
  }

  // A rename follows the note type, which is why it is a rename rather than an edit: the file moves to the
  // name the note type now has, and the one key that ties the body to its file changes with it. Nothing else
  // is touched — a rename is not the operation that rewrites a profile — and a target that is already taken
  // is refused, because the operation that tidies a name must never be the one that silently destroys one.
  checkRename (name, to) {
    const { noteType, file } = this.#installed(name, 'rename');
    const renamed = this.#noteType(to);
    if (renamed === noteType) fail(`a rename must change the note type: ${noteType} is already its name`);
    const content = this.#validated({ ...this.#raw(file), noteType: renamed }).content;
    const target = path.basename(this.pathFor(renamed));
    if (this.#claimable(path.join(this.dir, target))) {
      fail(`refusing to rename onto ${target}: that note type already has a profile`);
    }
    return { name: file, to: target, noteType, renamed, bytes: Buffer.byteLength(content, 'utf8'), content };
  }

  checkRemove (name) {
    const { noteType, file } = this.#installed(name, 'remove');
    return { name: file, noteType, bytes: Buffer.byteLength(this.#read(file), 'utf8') };
  }

  // The previous text is kept under `versions/` before it is replaced, so a change to a profile the user
  // wrote by hand is reversible, and the new text lands by rename so a failure leaves the old file in place.
  save (profile) {
    const { name, noteType, bytes, created, content } = this.check(profile);
    fs.mkdirSync(this.dir, { recursive: true });
    const backup = created ? '' : this.#version(name);
    this.#replace(name, content);
    this.refresh();
    return { name, noteType, bytes, created, backup };
  }

  // An edit always replaces a file that exists, so it always keeps the text it replaced.
  edit (edit) {
    const { name, noteType, field, changes, bytes, content } = this.checkEdit(edit);
    const backup = this.#version(name);
    this.#replace(name, content);
    this.refresh();
    return { name, noteType, field, changes, bytes, backup };
  }

  // The file lands under its new name before the old one leaves, so a failure here leaves the profile exactly
  // where the user could still read it — and the text is kept either way.
  rename (name, to) {
    const { name: from, to: target, noteType, renamed, content } = this.checkRename(name, to);
    const backup = this.#version(from);
    this.#replace(target, content);
    fs.rmSync(path.join(this.dir, from));
    this.refresh();
    return { name: from, to: target, noteType, renamed, backup };
  }

  // The backup comes first, so a removal is as recoverable as a replacement.
  remove (name) {
    const { name: file, noteType } = this.checkRemove(name);
    const backup = this.#version(file);
    fs.rmSync(path.join(this.dir, file));
    this.refresh();
    return { name: file, noteType, backup };
  }

  // One operation in, one file out, so the vocabulary of what can be done to this directory lives here rather
  // than in the agent that happens to ask for it. A caller that only saves a profile omits `op`.
  apply (operation = {}) {
    const op = operation.op || WRITE;
    if (op === EDIT) return this.edit(operation);
    if (op === RENAME) return this.rename(operation.name ?? operation.noteType, operation.to);
    if (op === REMOVE) return this.remove(operation.name ?? operation.noteType);
    if (op !== WRITE) fail(`unknown card profile operation: ${op}`);
    return this.save(operation.profile ?? operation);
  }

  // The one place a profile is judged before it can reach the disk. A profile that does not check out is
  // answered with the grammar's own sentences rather than half-written, and the compile after them is the
  // proof that what was checked is also what this app can run.
  #validated (profile) {
    if (!isObject(profile)) fail('a profile is the profile object itself, never a JSON string');
    const errors = checkProfile(profile);
    if (errors.length) fail(errors.join('; '));
    compileProfile(profile);
    return { noteType: String(profile.noteType).trim(), content: serialize(profile) };
  }

  // A note type the user already has, addressed by its name or by the file that holds it. A name nothing
  // describes is the same answer an unresolvable skill name gets: what was asked for, and nothing written.
  #installed (name, doing) {
    const requested = String(name ?? '').trim().replace(new RegExp(`${EXTENSION}$`, 'i'), '');
    const contract = this.profiles.get(requested);
    if (!contract) fail(`no card profile for the ${requested || 'named'} note type, so there is none to ${doing}`, 404);
    return { noteType: contract.noteType, file: this.sources.get(requested) };
  }

  #noteType (name) {
    const value = String(name ?? '').trim().replace(/[/\\:]/g, '-');
    if (!value) fail('a rename needs the note type it renames to');
    return value;
  }

  // A write lands in the file that already describes this note type when there is one, so a profile keeps the
  // name its user gave it, and in the name the note type gives it otherwise.
  #target (noteType) {
    const file = this.sources.get(noteType);
    return file ? path.join(this.dir, file) : this.pathFor(noteType);
  }

  #read (file) {
    return fs.readFileSync(path.join(this.dir, file), 'utf8');
  }

  #raw (file) {
    return JSON.parse(this.#read(file));
  }

  // One location, one merge. Without a field the profile itself is the location; with one, that field is
  // added or merged, `remove` deletes it, and the storage that holds it follows — an entry holding only it
  // leaves, and one holding several keeps the others. Everything else is left exactly as the user wrote it.
  #edited (profile, edit) {
    const field = typeof edit.field === 'string' ? edit.field.trim() : '';
    const set = isObject(edit.set) ? edit.set : {};
    const unset = asParts(edit.unset).map(String).filter(Boolean);
    const remove = edit.remove === true;
    const storage = isObject(edit.storage) ? edit.storage : null;

    if (remove && !field) fail('an edit that removes must name the field it removes');
    if (remove && (Object.keys(set).length || unset.length || storage)) {
      fail(`an edit that removes the ${field} field cannot also set, unset or store it`);
    }
    if (!remove && !Object.keys(set).length && !unset.length && !storage) {
      fail('an edit must set, unset or store at least one key');
    }
    if (storage && !field) fail('storage belongs to a field: name the field it stores');
    if (field && set.name !== undefined && set.name !== field) {
      fail(`a field is named by the key that addresses it: ${field}, not ${set.name}`);
    }
    if (!field) {
      const merged = { ...profile, ...set };
      unset.forEach(key => delete merged[key]);
      return { profile: merged, field: '', changes: changedKeys('', Object.keys(set), unset) };
    }

    const fields = asParts(profile.fields);
    const position = fields.findIndex(entry => isObject(entry) && entry.name === field);
    if (remove) {
      if (position < 0) fail(`the ${profile.noteType} profile has no field named ${field}`);
      return {
        profile: {
          ...profile,
          fields: fields.filter((entry, index) => index !== position),
          ...(profile.storage === undefined ? {} : { storage: asParts(profile.storage)
            .map(entry => (holdsField(entry, field) ? withoutPart(entry, field) : entry))
            .filter(Boolean) }),
        },
        field,
        changes: [`removed ${field}`],
      };
    }

    // A field that is not there yet is added, so one edit is how a note type grows a field: the keys it
    // carries are its own, and its name is the key that addressed it.
    const merged = position < 0 ? { name: field, ...set } : { ...fields[position], ...set };
    unset.forEach(key => delete merged[key]);
    const next = { ...profile, fields: position < 0 ? [...fields, merged]
      : fields.map((entry, index) => (index === position ? merged : entry)) };
    if (storage) {
      const entries = asParts(profile.storage);
      next.storage = entries.some(entry => holdsField(entry, field))
        ? entries.map(entry => (holdsField(entry, field) ? storage : entry))
        : [...entries, storage];
    }
    return { profile: next, field,
      changes: changedKeys(`${field}.`, Object.keys(set), unset).concat(storage ? [`stored ${field}`] : []) };
  }

  // The text a change replaces is kept under `versions/`, which the library never reads back because it
  // holds no top-level `.json`. Names are stamped and then de-duplicated, so two changes in the same
  // millisecond stay two copies, and the oldest beyond the cap is dropped.
  #version (file) {
    const root = path.join(this.dir, VERSION_DIR);
    fs.mkdirSync(root, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backup = path.join(root, `${file}.${stamp}`);
    for (let index = 1; fs.existsSync(backup); index++) backup = path.join(root, `${file}.${stamp}-${index}`);
    fs.writeFileSync(backup, fs.readFileSync(path.join(this.dir, file)));
    const mine = fs.readdirSync(root).filter(entry => entry.startsWith(`${file}.`)).sort();
    mine.slice(0, -VERSION_KEEP).forEach(stale => fs.rmSync(path.join(root, stale), { force: true }));
    return path.relative(this.dir, backup);
  }

  // A temporary name inside the same directory keeps the rename on one filesystem, which is what makes it
  // atomic, and its leading dot keeps a leftover from a crash out of the library.
  #replace (file, text) {
    const temp = path.join(this.dir, `.${file}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, text, { flag: 'wx' });
      fs.renameSync(temp, path.join(this.dir, file));
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  // `#files()` reads only regular files, so anything else at the target is something the library cannot see.
  // Writing over it would quietly turn it into a profile, and following a symlink would make the backup read
  // a file from outside the directory — so both are refused rather than followed.
  #claimable (target) {
    try {
      const stats = fs.lstatSync(target);
      if (stats.isFile()) return true;
      fail(stats.isSymbolicLink()
        ? `refusing to write over the symlink ${target}`
        : `refusing to write over something that is not a file: ${target}`);
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
}

const withoutPart = (entry, field) => (entry.of = asParts(entry.of).filter(name => name !== field)).length
  ? entry : null;

module.exports = { CardProfileLibrary, VERSION_KEEP };
