const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// `security` blocks on a locked Keychain or on a prompt nobody answers, and nothing above it carries a
// deadline, so every call does: the route that needed the secret fails with a reason instead of waiting.
const CALL_TIMEOUT_MS = 10000;

const exec = promisify(execFile);

// A timeout is a failure, not an empty secret: it is reported as its own error so `get`'s missing-entry
// handling (exit code 44/45 and ENOENT) can never mistake it for "no password stored".
const execWithTimeout = ({ timeoutMs = CALL_TIMEOUT_MS } = {}) => async (command, args) => {
  try {
    return await exec(command, args, { timeout: timeoutMs });
  } catch (error) {
    if (!error.killed) throw error;
    throw Object.assign(new Error(`${command} timed out after ${timeoutMs}ms`), { cause: error });
  }
};

class KeychainStore {
  constructor ({ service = 'com.caro.anki.agent', runner = execWithTimeout() } = {}) {
    Object.assign(this, { service, runner });
  }

  async get (account) {
    try {
      const { stdout } = await this.runner('security',
        ['find-generic-password', '-s', this.service, '-a', account, '-w']);
      return stdout.replace(/\r?\n$/, '');
    } catch (error) {
      if (error.code === 44 || error.code === 45 || error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async set (account, secret) {
    await this.runner('security',
      ['add-generic-password', '-U', '-s', this.service, '-a', account, '-w', secret]);
  }

  async delete (account) {
    try {
      await this.runner('security', ['delete-generic-password', '-s', this.service, '-a', account]);
    } catch (error) {
      if (error.code !== 44 && error.code !== 45 && error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { KeychainStore, execWithTimeout };
