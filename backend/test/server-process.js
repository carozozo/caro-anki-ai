// Starts the real backend for a test and owns its whole lifetime.
//
// Two things this has to get right, because both cost a debugging session otherwise: a piped stream nobody
// reads fills up and blocks the server, and a server that dies while starting has to hand over what it wrote
// instead of only its exit code. Every file that needs a server under test goes through here, so it exists
// once.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '../..');
const bridgePath = path.resolve(__dirname, 'fixtures/anki-bridge.js');
const profilePath = path.resolve(__dirname, 'fixtures/english-profile.json');
// The backend announces itself with this line, which is the only evidence that it is serving.
const LISTENING = 'caro-anki listening at';

// The port has to be free and it has to be known before the server starts, because the server cannot ask for
// a random one.
async function freePort () {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

const written = ({ stdout, stderr }) => {
  const text = `\n${stderr}\n${stdout}`.trim();
  return text ? `:\n${text}` : '';
};

// The defaults are what every test needs: no AI credentials, the fixture bridge instead of the bundled
// runtime, and a throwaway SQLite file plus collection. `env` overrides them.
async function startServer (env = {}) {
  const port = await freePort();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-anki-test-'));
  const overrides = typeof env === 'function' ? env({ tempDir }) : env;
  // The card profile is seeded from the fixture rather than read from the user's own library: without this a
  // test's card shape comes from whichever profiles happen to be installed on the machine running it.
  const cardProfilesDir = path.join(tempDir, 'card-profiles');
  fs.mkdirSync(cardProfilesDir);
  fs.copyFileSync(profilePath, path.join(cardProfilesDir, 'English.json'));
  // The server picks its Anki runtime from the environment: a helper when one is configured, otherwise the
  // bridge script under the python3 on the PATH. The fixture bridge is installed as that python3, so a test
  // runs the fallback a checkout with no built runtime uses — and it has to be a real executable, because the
  // server spawns it. ANKI_PROFILE_ROOT keeps the run inside tempDir: the whole point of a profile root is
  // that the collection is bootstrapped under it, and the real one would make a test read the user's own.
  const shimDir = path.join(tempDir, 'bin');
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, 'python3'), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  fs.chmodSync(path.join(shimDir, 'python3'), 0o755);
  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1',
      PATH: `${shimDir}:${process.env.PATH}`,
      SQLITE_PATH: path.join(tempDir, 'test.sqlite'), DEEPSEEK_API_KEY: '',
      CARO_SKILLS_DIR: path.join(tempDir, 'skills'),
      CARO_INSTRUCTIONS_DIR: path.join(tempDir, 'instructions'),
      'CARO_card-profiles_DIR': cardProfilesDir,
      ANKI_PROFILE_ROOT: path.join(tempDir, 'profiles'), ANKI_BRIDGE_PATH: bridgePath,
      ...overrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  const ready = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output.stdout += chunk;
      if (output.stdout.includes(LISTENING)) resolve();
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { output.stderr += chunk; });
    // `close`, not `exit`: the process can end with its stderr still buffered, and the reason it died is
    // exactly what this message is for.
    child.on('close', code => reject(new Error(`Server exited with ${code}${written(output)}`)));
  });
  // The exit path is the interesting one: a server that never got as far as listening leaves its reason on
  // stderr, and a test cannot be expected to pass without it.
  const stop = async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  try {
    await ready;
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, stop, tempDir };
}

module.exports = { startServer };
