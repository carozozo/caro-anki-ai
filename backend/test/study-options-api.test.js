const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./server-process');

// The preset the fixture seeds is the one Anki hands a deck that names none, so its id is the only one a
// test can name up front; every other id is whatever Anki's clock produced.
const DEFAULT_PRESET_ID = 1;

test('HTTP study options API reads, writes, and assigns deck options', { timeout: 10000 }, async t => {
  const { port, stop } = await startServer();
  t.after(() => stop());

  const request = async (route, body, headers = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };
  const readOptions = async (query = '') => (await request(`anki/study-options${query}`, undefined, {}, 'GET')).payload;

  assert.equal((await request('anki/study-options', { name: 'Blocked' }, {
    Origin: 'https://untrusted.example',
  })).status, 403);
  assert.equal((await request(`anki/study-options/${DEFAULT_PRESET_ID}`, { name: 'Plain text' }, {
    'Content-Type': 'text/plain',
  }, 'PUT')).status, 415);
  assert.equal((await request('anki/study-options/Bogus', { name: 'Bad id' }, {}, 'PUT')).status, 400);

  // The picker and the settings of the preset it opens arrive together, and the schema travels with them
  // so the dialog never has to know a field's path.
  const opened = await readOptions(`?presetId=${DEFAULT_PRESET_ID}`);
  assert.deepEqual(opened.presets, [{
    id: DEFAULT_PRESET_ID, name: 'Default', decks: ['Default', '_Todo'], removable: false,
  }]);
  assert.deepEqual(opened.fields.map(group => group.title),
    ['NEW CARDS', 'REVIEWS', 'LAPSES', 'ORDER & TIMER', 'AUDIO', 'FSRS']);
  assert.deepEqual(opened.fields[0].fields[0],
    { key: 'newPerDay', label: 'New cards/day', kind: 'count', min: 0, max: 9999 });
  // The range is the one Anki's own deck options give a hard interval (0.5 to 1.3), so a preset that
  // already holds 60% is not refused by a limit Anki itself does not have.
  assert.deepEqual(opened.fields[1].fields[2],
    { key: 'hardInterval', label: 'Hard interval (%)', kind: 'percent', min: 50, max: 130, step: 5 });
  assert.equal(opened.preset.settings.newPerDay, 20);
  assert.equal(opened.preset.settings.learningSteps, '1m 10m');
  assert.equal(opened.preset.settings.startingEase, 250);
  assert.equal(opened.preset.settings.desiredRetention, 90);

  // A read names the parts of its answer, never a field of a preset.
  const narrowed = await readOptions('?select=presets,fields');
  assert.equal(narrowed.preset, undefined);
  assert.ok(narrowed.presets.length);
  assert.equal((await request('anki/study-options?select=decks', undefined, {}, 'GET')).status, 400);

  // A new preset starts from the one on screen, so the values the user just read are the ones it opens on.
  const created = await request('anki/study-options', { name: 'Fast', cloneFrom: DEFAULT_PRESET_ID });
  assert.equal(created.status, 201);
  assert.equal(created.payload.preset.name, 'Fast');
  assert.equal(created.payload.preset.removable, true);
  assert.deepEqual(created.payload.preset.decks, []);
  const presetId = created.payload.preset.id;
  assert.equal((await readOptions(`?presetId=${presetId}`)).preset.settings.reviewPerDay, 200);

  const assigned = await request('anki/decks/_Todo/study-options', { presetId }, {}, 'PUT');
  assert.deepEqual(assigned, { status: 200, payload: { ok: true, deck: '_Todo', presetId } });
  assert.deepEqual((await readOptions()).presets, [
    { id: DEFAULT_PRESET_ID, name: 'Default', decks: ['Default'], removable: false },
    { id: presetId, name: 'Fast', decks: ['_Todo'], removable: true },
  ]);
  assert.equal((await request('anki/decks/Nope/study-options', { presetId }, {}, 'PUT')).status, 500);

  const updated = await request(`anki/study-options/${presetId}`, {
    settings: { newPerDay: 5, learningSteps: '5m 30m 1h', buryNewSiblings: false, maximumInterval: 100 },
  }, {}, 'PUT');
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.preset.settings.newPerDay, 5);
  assert.equal(updated.payload.preset.settings.learningSteps, '5m 30m 1h');
  assert.equal(updated.payload.preset.settings.buryNewSiblings, false);
  assert.equal(updated.payload.preset.settings.maximumInterval, 100);
  assert.deepEqual((await readOptions(`?presetId=${presetId}`)).preset.decks, ['_Todo']);

  for (const settings of [{ nope: 1 }, { newPerDay: 100000 }, { leechAction: 7 }, { learningSteps: '1m bogus' }]) {
    const refused = await request(`anki/study-options/${presetId}`, { settings }, {}, 'PUT');
    assert.equal(refused.status, 400);
    assert.equal(refused.payload.ok, false);
  }

  // One option is one write: a value inside Anki's range lands, and the same option a step outside it is
  // refused with the sentence that names the option, so a bad option cannot take the others down with it.
  const writeOne = async settings => request(`anki/study-options/${presetId}`, { settings }, {}, 'PUT');
  assert.equal((await writeOne({ hardInterval: 60 })).payload.preset.settings.hardInterval, 60);
  assert.equal((await writeOne({ maximumAnswerSeconds: 7200 })).payload.preset.settings.maximumAnswerSeconds, 7200);
  const belowRange = await writeOne({ hardInterval: 40 });
  assert.equal(belowRange.status, 400);
  assert.match(belowRange.payload.error, /Hard interval \(%\) must be from 50 to 130/);
  assert.equal((await readOptions(`?presetId=${presetId}`)).preset.settings.hardInterval, 60);

  const renamed = await request(`anki/study-options/${presetId}`, { name: 'Steady' }, {}, 'PUT');
  assert.equal(renamed.payload.preset.name, 'Steady');
  const duplicated = await request(`anki/study-options/${presetId}`, { name: 'Default' }, {}, 'PUT');
  assert.equal(duplicated.status, 500);
  assert.match(duplicated.payload.error, /Study options already exist: Default/);

  // The preset Anki falls back to cannot go, and removing a preset a deck names hands that deck back to it.
  const protectedPreset = await request(`anki/study-options/${DEFAULT_PRESET_ID}`, undefined, {}, 'DELETE');
  assert.equal(protectedPreset.status, 500);
  assert.match(protectedPreset.payload.error, /cannot be deleted/);
  assert.equal((await request(`anki/study-options/${presetId}`, undefined, {
    Origin: 'https://untrusted.example',
  }, 'DELETE')).status, 403);
  const removed = await request(`anki/study-options/${presetId}`, undefined, {}, 'DELETE');
  assert.deepEqual(removed, { status: 200, payload: { ok: true, deleted: 'Steady' } });
  assert.deepEqual((await readOptions()).presets, [{
    id: DEFAULT_PRESET_ID, name: 'Default', decks: ['Default', '_Todo'], removable: false,
  }]);
  // The preset id the dialog was holding is gone, and Anki's own sentence is what the caller is told.
  const stale = await request(`anki/study-options?presetId=${presetId}`, undefined, {}, 'GET');
  assert.equal(stale.status, 500);
  assert.match(stale.payload.error, /Study options not found/);
});
