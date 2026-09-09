const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const appTitles = { production: 'Caro Anki', dev: 'Caro Anki Dev' };

function parseEnv (content) {
  return content.split(/\r?\n/).reduce((env, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#')) return env;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    env[match[1]] = value;
    return env;
  }, {});
}

function loadEnv () {
  try {
    return parseEnv(fs.readFileSync(envPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return {};
  }
}

function envValue (fileEnv, name, fallback = '', environment = process.env) {
  return environment[name] ?? fileEnv[name] ?? fallback;
}

function resolveProjectPath (value) {
  return path.resolve(projectRoot, value);
}

function resolveUserPath (value) {
  return path.resolve(value.replace(/^~(?=$|\/)/, os.homedir()));
}

function appConfig (fileEnv, environment = process.env) {
  const variant = envValue(fileEnv, 'CARO_APP_VARIANT', 'production', environment);
  const title = appTitles[variant];
  if (!title) throw new Error(`Invalid CARO_APP_VARIANT: ${variant}`);
  return { variant, title };
}

// The Anki runtime is a PyInstaller bundle built by `scripts/sh/build-anki-runtime.sh`. The Electron app
// passes its installed copy through ANKI_HELPER_PATH; a checkout without one falls back to the build
// output under `tmp/`, and finally to an external Python plus the checked-in bridge script.
//
// An explicitly configured ANKI_BRIDGE_PATH is treated as a deliberate override, so it always wins over a
// bundled helper: otherwise a built runtime would silently ignore it.
function ankiConfig (fileEnv, environment = process.env) {
  const isSet = name => environment[name] !== undefined || fileEnv[name] !== undefined;
  const value = (name, fallback) => envValue(fileEnv, name, fallback, environment);
  const configuredHelper = value('ANKI_HELPER_PATH');
  const bundledHelperPath = path.join(projectRoot, 'tmp', 'anki-runtime', 'anki-helper', 'anki-helper');
  const bridgeOverride = isSet('ANKI_BRIDGE_PATH');
  const bridgePath = resolveUserPath(value('ANKI_BRIDGE_PATH',
    path.join(projectRoot, 'backend', 'anki_bridge.py')));
  const helperPath = configuredHelper ? resolveUserPath(configuredHelper)
    : !bridgeOverride && fs.existsSync(bundledHelperPath) ? bundledHelperPath : null;
  const profileRoot = resolveUserPath(value('ANKI_PROFILE_ROOT', '~/Library/Application Support/Caro Anki'));

  return {
    // The profile a fresh install bootstraps, and only that: every later launch reads the active profile
    // from the database, which is what makes a collection path a profile's own rather than a setting.
    collectionPath: path.join(profileRoot, 'User 1', 'collection.anki2'),
    profileRoot,
    helperPath, bundledHelperPath, bridgePath,
    // The checked-in bridge is the no-helper fallback and runs under the python3 the PATH offers, because
    // asking which interpreter to use is exactly the setup step the bundled runtime exists to remove.
    pythonPath: 'python3',
    modelName: 'English',
    allowDuplicate: true,
  };
}

function loadConfig () {
  const fileEnv = loadEnv();
  const port = Number(envValue(fileEnv, 'PORT', '8788'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${port}`);

  return {
    projectRoot,
    app: appConfig(fileEnv),
    host: envValue(fileEnv, 'HOST', '127.0.0.1'),
    port,
    frontendDir: path.join(projectRoot, 'frontend'),
    sqlitePath: resolveProjectPath(envValue(fileEnv, 'SQLITE_PATH', './sqlite/data/anki-ai.sqlite')),
    migrationsDir: path.join(projectRoot, 'sqlite/migrations'),
    // User-authored skills live outside the checkout so they survive a rebuild. The seeds shipped with the
    // app are copied there once; `skillsSeedDir` is only ever read.
    skillsDir: resolveUserPath(envValue(fileEnv, 'CARO_SKILLS_DIR', '~/.caro-anki/skills')),
    skillsSeedDir: path.join(projectRoot, 'skills'),
    // Standing instructions are the user's own, so they live next to the skills rather than in the
    // checkout, and unlike a skill they are re-read on every request: there are no seeds and no
    // bootstrap marker, because the factory setting is the agent's own prompt.
    instructionsDir: resolveUserPath(envValue(fileEnv, 'CARO_INSTRUCTIONS_DIR', '~/.caro-anki/instructions')),
    // Card profiles are JSON contracts describing a user's own note types. They live in user storage
    // so personal card schemas, validation rules, and Anki field mappings survive updates. The directory is
    // named after what it holds — a profile per note type — because `cards` named the notes instead.
    cardProfilesDir: resolveUserPath(envValue(fileEnv, 'CARO_card-profiles_DIR', '~/.caro-anki/card-profiles')),
    // Secrets live in the macOS Keychain, keyed by service; the names are configurable so a test can
    // work against an isolated service instead of the user's real credentials.
    keychain: {
      agentService: envValue(fileEnv, 'AGENT_KEYCHAIN_SERVICE', 'com.caro.anki.agent'),
      syncService: envValue(fileEnv, 'ANKI_SYNC_KEYCHAIN_SERVICE', 'com.caro.anki.sync'),
    },
    anki: ankiConfig(fileEnv),
  };
}

module.exports = { ankiConfig, appConfig, loadConfig, projectRoot };
