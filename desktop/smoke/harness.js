const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, describe = null, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for desktop state${describe ? `: ${await describe()}` : ''}`);
};

const createHarness = ({ window, root, profileRoot }) => {
  const touch = relative => {
    const file = path.join(root, relative);
    const now = new Date();
    fs.utimesSync(file, now, now);
  };
  const evaluate = expression => window.webContents.executeJavaScript(expression)
    .catch(error => { throw new Error(`${error.message}\n  script: ${expression.trim().slice(0, 600)}`); });
  const reloadedAfter = async (stamp, statusSelector) => {
    try {
      await until(async () => await evaluate('performance.timeOrigin') !== stamp);
    } catch {
      throw new Error(`The page did not reload. ${statusSelector}: `
        + await evaluate(`document.querySelector('${statusSelector}').textContent`));
    }
  };
  const listReady = async () => until(async () => await evaluate(`(() => {
    const status = document.querySelector('#ankiBrowserStatus').textContent.trim();
    return Boolean(status) && !status.startsWith('Loading');
  })()`));
  const rowFieldGaps = async () => await evaluate(`(() => {
    const rows = [...document.querySelectorAll(
      '.anki-picker-row, .anki-entity-section-head, .anki-inline-control')]
      .filter(row => row.offsetParent !== null);
    const height = element => Math.round(element.getBoundingClientRect().height);
    return rows.map(row => {
      const field = [...row.querySelectorAll('.field')].find(item => item.offsetParent !== null);
      const button = row.querySelector('.button-icon');
      return field && button ? height(field) - height(button) : null;
    }).filter(gap => gap !== null);
  })()`);
  const assertAppShell = async () => {
    assert.equal(await evaluate('typeof require'), 'undefined');
    assert.equal(await evaluate('document.title'), 'Caro Anki Dev');
    assert.ok(await evaluate('document.body.innerText.length > 0'));
  };

  return {
    assert, delay, evaluate, fs, listReady, path, profileRoot, reloadedAfter, root, rowFieldGaps, touch, until, window,
    assertAppShell,
  };
};

const fs = require('node:fs');
const path = require('node:path');

module.exports = { createHarness, until };
