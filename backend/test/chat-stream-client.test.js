const test = require('node:test');
const assert = require('node:assert/strict');

const { collapseToolSteps, conversationParts, formatElapsed, groupSteps, operationJson, proposedPreviews, readEvents,
  stepDetail, stepTitle } = require('../../frontend/scripts/chat/chat-stream');

const streamOf = chunks => ({
  body: new ReadableStream({
    start (controller) {
      chunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)));
      controller.close();
    },
  }),
});

const message = record => ({ role: 'tool', content: JSON.stringify(record) });
const step = (operator, status, extra = {}) => ({ action: { name: operator, args: {} }, status, ...extra });

test('reads newline-delimited events across chunk boundaries', async () => {
  const received = [];
  await readEvents(streamOf([
    '{"type":"phase","phase":"thinking"}\n{"type":"to',
    'ol","operation":{"status":"pending"}}\n',
    '{"type":"result","payload":{"ok":true}}',
  ]), event => received.push(event));
  assert.deepEqual(received, [
    { type: 'phase', phase: 'thinking' },
    { type: 'tool', operation: { status: 'pending' } },
    { type: 'result', payload: { ok: true } },
  ]);
});

test('collapses a pending record into the result that already reports it', () => {
  const collapsed = collapseToolSteps([
    { role: 'user', content: 'create' },
    message(step('search_notes', 'pending')),
    message(step('search_notes', 'completed', { result: { total: 3 } })),
    message(step('create_notes', 'pending')),
    message(step('create_notes', 'failed', { error: 'boom' })),
    { role: 'assistant', content: 'done' },
  ]);
  assert.deepEqual(collapsed.map(entry => entry.role), ['user', 'tool', 'tool', 'assistant']);
  assert.deepEqual(collapsed.filter(entry => entry.role === 'tool').map(entry => JSON.parse(entry.content).status),
    ['completed', 'failed']);
});

test('keeps a pending record that never reported a result, relabelled as interrupted', () => {
  const collapsed = collapseToolSteps([message(step('create_notes', 'pending')), { role: 'assistant', content: 'disconnected' }]);
  const record = JSON.parse(collapsed[0].content);
  assert.equal(record.status, 'interrupted');
  assert.equal(stepTitle(record), 'Create notes · Interrupted');
  assert.match(stepDetail(record), /run ended before this step/);
});

test('keeps a pending record whose next tool record belongs to another call', () => {
  const messages = [message(step('search_notes', 'pending')), message(step('read_note', 'completed', { result: {} }))];
  assert.deepEqual(collapseToolSteps(messages).map(entry => JSON.parse(entry.content).status),
    ['interrupted', 'completed']);
});

test('carries the gap between a pending record and its result as the step duration', () => {
  const stamped = (record, at) => ({ ...message(record), created_at: at });
  const collapsed = collapseToolSteps([
    stamped(step('search_notes', 'pending'), '2026-09-17T00:00:00.000Z'),
    stamped(step('search_notes', 'completed', { result: {} }), '2026-09-17T00:00:02.500Z'),
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].durationMs, 2500);
  const unstamped = collapseToolSteps([message(step('list_decks', 'pending')), message(step('list_decks', 'completed'))]);
  assert.equal(unstamped[0].durationMs, 0);
});

test('names every step, including collection metadata tools', () => {
  assert.equal(stepTitle(step('search_notes', 'pending')), 'Search notes · Running…');
  assert.equal(stepTitle(step('list_decks', 'completed')), 'List decks · Completed');
  assert.equal(stepTitle(step('list_tags', 'completed')), 'List tags · Completed');
  assert.equal(stepTitle(step('read_card_profiles', 'completed')), 'Read card profiles · Completed');
  assert.equal(stepTitle(step('propose_card_profile', 'pending')), 'Propose card profile · Running…');
  assert.equal(stepTitle(step('apply_card_profile', 'completed')), 'Apply card profile · Completed');
  assert.equal(stepTitle(step('update_memory', 'completed')), 'Update memory · Completed');
  assert.equal(stepTitle(step('load_skill', 'completed')), 'Load skill · Completed');
  assert.equal(stepTitle(step('custom', 'failed')), 'custom · Failed');
});

// A conversation persisted before the tool names were namespaced must still read as a sentence, so the
// display layer maps the old names itself instead of showing them raw.
test('a step persisted with an old tool name still gets its label', () => {
  assert.equal(stepTitle(step('search', 'pending')), 'Search notes · Running…');
  assert.equal(stepTitle(step('update', 'completed')), 'Edit notes · Completed');
  assert.equal(stepTitle(step('read_card_profile', 'completed')), 'Read card profiles · Completed');
  assert.equal(stepDetail(step('skills', 'completed', { result: { name: 'card-audit' } })), 'Loaded card-audit');
});

test('describes a skill call while it runs and by what it loaded once done', () => {
  assert.equal(stepDetail(step('load_skill', 'pending', { action: { name: 'load_skill', args: { name: 'card-audit' } } })),
    'Loading skill card-audit…');
  assert.equal(stepDetail(step('load_skill', 'pending')), 'Listing skills…');
  assert.equal(stepDetail(step('load_skill', 'completed', { result: { name: 'card-audit' } })), 'Loaded card-audit');
  assert.equal(stepDetail(step('load_skill', 'completed',
    { result: { name: 'card-audit', file: 'field-contract.md' } })),
  'Loaded card-audit · references/field-contract.md');
  assert.equal(stepDetail(step('load_skill', 'completed', { result: { skills: [{ name: 'card-audit' }] } })),
    '1 skill installed');
  assert.equal(stepDetail(step('load_skill', 'completed',
    { result: { error: 'unknown skill: card-audti', skills: [] } })),
  'unknown skill: card-audti — the library was listed instead');
});

test('describes a search from its query while running and from its result once done', () => {
  assert.equal(stepDetail(step('search_notes', 'pending', { action: { name: 'search_notes', args: { query: 'deck:_Todo' } } })),
    'Query: deck:_Todo');
  assert.equal(stepDetail(step('search_notes', 'pending')), 'Query: (all notes)');
  assert.equal(stepDetail(step('search_notes', 'completed',
    { action: { name: 'search_notes', args: { query: 'is:due' } },
      result: { query: 'is:due', total: 1, hasMore: true } })),
  'Query: is:due — 1 match, more available');
  assert.equal(stepDetail(step('search_notes', 'completed', { result: { query: 'deck:_Todo', total: 982 } })),
    'Query: deck:_Todo — 982 matches');
});

test('describes decks, reads, creates, updates and deletes', () => {
  assert.equal(stepDetail(step('list_decks', 'completed', { result: { currentDeck: '_Todo', decks: ['_Todo'] } })),
    'Current deck: _Todo · 1 deck');
  assert.equal(stepDetail(step('list_decks', 'pending')), 'Reading Anki decks…');
  assert.equal(stepDetail(step('list_tags', 'pending')), 'Reading collection tags…');
  assert.equal(stepDetail(step('list_tags', 'completed', { result: { tags: ['domain::science'] } })), '1 tag');
  assert.equal(stepDetail(step('read_note', 'completed',
    { action: { name: 'read_note', args: { id: 12 } }, result: { noteId: 12 } }), id => `term ${id}`), 'Read term 12');
  assert.equal(stepDetail(step('create_notes', 'pending', { action: { name: 'create_notes', args: { cards: [{}, {}] } } })),
    'Creating 2 notes…');
  assert.equal(stepDetail(step('create_notes', 'completed',
    { result: { deck: 'English', noteIds: [1, null], rejected: 1 } })),
  'Deck: English · Created 1 note, rejected 1');
  // A call whose cards name their own note types and decks reports each one, so a mixed batch says what it
  // wrote instead of naming only the deck the call defaulted to.
  assert.equal(stepDetail(step('create_notes', 'completed',
    { result: { noteTypes: ['English Word', 'English Phrase'], decks: ['Eng::Word', 'Eng::Phrase'], noteIds: [1, 2] } })),
  'Note types: English Word, English Phrase · Deck: Eng::Word, Eng::Phrase · Created 2 notes');
  assert.equal(stepDetail(step('update_note', 'pending',
    { action: { name: 'update_note', args: { id: 12, fields: { Meaning: 'new' } } } }), () => 'n12'), 'Editing n12: Meaning');
  assert.equal(stepDetail(step('update_note', 'completed', {
    action: { name: 'update_note', args: { id: 12, fields: { Meaning: 'new' } } },
    result: { id: 12, before: { fields: { Meaning: { value: 'old' } } } },
  })), 'Meaning: old → new');
  assert.equal(stepDetail(step('delete_note', 'failed', { error: 'Read the target note before changing it' })),
    'Read the target note before changing it');
});

test('shows autonomous memory changes without treating them as a user proposal', () => {
  assert.equal(stepDetail(step('update_memory', 'pending', { action: { name: 'update_memory', args: {
    additions: [{}], updates: [{}], removals: [{}],
  } } })), 'Updating 3 memories…');
  const detail = stepDetail(step('update_memory', 'completed', { result: {
    updated: true,
    additions: [{ content: 'Use concise Traditional Chinese.' }],
    updates: [{ before: 'Old preference.', content: 'New preference.' }],
    removals: [{ content: 'Stale detail.' }],
  } }));
  assert.equal(detail, 'Remembered: Use concise Traditional Chinese.\nUpdated: Old preference. → New preference.'
    + '\nForgot: Stale detail.');
  assert.equal(stepDetail(step('update_memory', 'completed', { result: { updated: false,
    error: 'No such memory: missing' } })), 'No such memory: missing — memory unchanged');
});

// The batch tools say how many notes one call carries while it runs, and after it answers they read one line
// per note — a note the collection could not find is shown as the sentence it was answered with.
test('describes a batch of reads, edits and deletes', () => {
  assert.equal(stepDetail(step('read_notes', 'pending', { action: { name: 'read_notes', args: { ids: [12, 13] } } })),
    'Reading 2 notes…');
  assert.equal(stepDetail(step('read_notes', 'completed',
    { result: { notes: [{ noteId: 12 }, { noteId: 13, error: 'Note not found' }] } }), id => `term ${id}`),
  'Read term 12\nterm 13: Note not found');
  assert.equal(stepDetail(step('update_notes', 'pending',
    { action: { name: 'update_notes', args: { notes: [{ id: 12 }, { id: 13 }] } } })), 'Editing 2 notes…');
  assert.equal(stepDetail(step('update_notes', 'completed', {
    action: { name: 'update_notes', args: { notes: [{ id: 12, fields: { Meaning: 'new' } }, { id: 13, fields: { Meaning: 'x' } }] } },
    result: { notes: [
      { id: 12, before: { fields: { Meaning: { value: 'old' } } } },
      { id: 13, before: { fields: { Meaning: { value: 'older' } } } },
    ] },
  }), () => 'n'), 'n\nMeaning: old → new\nn\nMeaning: older → x');
  assert.equal(stepDetail(step('delete_notes', 'pending', { action: { name: 'delete_notes', args: { ids: [12, 13] } } })),
    'Deleting 2 notes…');
  assert.equal(stepDetail(step('delete_notes', 'completed', { result: { notes: [{ id: 12 }, { id: 13 }] } })),
    'Deleted 2 notes');
});

// A profile read is what an audit works from, so the step reports the shape it found rather than the raw
// description, and an uninstalled note type is shown as the sentence it was answered with. One call carries
// several note types, so it reads as one line each.
test('describes a card profile read while it runs and by what it holds once done', () => {
  assert.equal(stepDetail(step('read_card_profiles', 'pending')), 'Reading card profiles…');
  assert.equal(stepDetail(step('read_card_profiles', 'pending',
    { action: { name: 'read_card_profiles', args: { noteTypes: ['English'] } } })), 'Reading the English profile…');
  assert.equal(stepDetail(step('read_card_profiles', 'pending',
    { action: { name: 'read_card_profiles', args: { noteTypes: ['English', 'English Phrase'] } } })),
  'Reading English, English Phrase…');
  assert.equal(stepDetail(step('read_card_profiles', 'completed', { result: { profiles: [
    { noteType: 'English',
      fields: [{ name: 'term', required: true }, { name: 'phonetic' }],
      storage: [{ field: 'Meaning', of: ['meaning'] }] },
    { noteType: 'Japanese', error: 'No card profile is installed for the Japanese note type.',
      noteTypes: ['English'] },
  ] } })), 'English: 2 fields, 1 required, 1 stored in Anki'
    + '\nNo card profile is installed for the Japanese note type. — 1 profile installed');
  assert.equal(stepDetail(step('read_card_profiles', 'completed', { result: { noteTypes: ['English'] } })),
    '1 profile installed');
});

// A proposal is the step the user answers in words, so it reports what the change would touch and says
// nothing about having written it.
test('describes a proposed instruction file by what an apply would do', () => {
  assert.equal(stepDetail(step('propose_instructions', 'pending',
    { action: { name: 'propose_instructions', args: { files: [{}, {}] } } })), 'Proposing 2 files…');
  assert.equal(stepDetail(step('propose_instructions', 'pending',
    { action: { name: 'propose_instructions', args: { files: [{}] } } })), 'Proposing 1 file…');
  assert.equal(stepDetail(step('propose_instructions', 'completed', { result: { proposed: true, written: false,
    files: [{ name: 'card-style.md', bytes: 120, exists: false },
      { name: 'reply.md', bytes: 40, exists: true }] } })),
  'card-style.md · new file · 120 bytes\nreply.md · replaces an existing file · 40 bytes');
  // One call carries the whole change, so the step counts it by verb while it runs and lists it by verb once
  // the library has answered: a rename and a removal are as visible as a write.
  assert.equal(stepDetail(step('propose_instructions', 'pending',
    { action: { name: 'propose_instructions', args: { files: [{}], renames: [{}, {}], removals: [{}] } } })),
  'Proposing 1 file, 2 renames, 1 removal…');
  assert.equal(stepDetail(step('propose_instructions', 'completed', { result: { proposed: true, written: false,
    files: [], renames: [{ name: 'language.md', to: 'reply-language.md', bytes: 40 }],
    removals: [{ name: 'old.md', bytes: 12 }] } })),
  'language.md → reply-language.md · renamed · 40 bytes\nold.md · removes the file · 12 bytes');
  // A refused file is the model's own mistake, answered so it retries: the step reports the sentence and
  // makes clear that no file came of it, and it is a completed step rather than a failed one.
  assert.equal(stepDetail(step('propose_instructions', 'completed', { result: { proposed: false, written: false,
    files: [], error: 'instruction name must end in .md: agent-workflow' } })),
  'instruction name must end in .md: agent-workflow — nothing was proposed');
});

// A skill is a folder, so its step names the folder once and lists what it would arrive with — and the other
// two things a change can be are named the same way, one line per skill rather than one per file.
test('describes a proposed skill as the folder an apply would write', () => {
  assert.equal(stepDetail(step('propose_skills', 'pending',
    { action: { name: 'propose_skills', args: { name: 'card-audit', files: [] } } })),
  'Proposing the skill card-audit…');
  assert.equal(stepDetail(step('propose_skills', 'pending',
    { action: { name: 'propose_skills', args: { renames: [{}, {}], removals: [{}] } } })),
  'Proposing 2 renames and 1 removal…');
  assert.equal(stepDetail(step('propose_skills', 'pending',
    { action: { name: 'propose_skills', args: {} } })), 'Proposing a skill change…');
  assert.equal(stepDetail(step('propose_skills', 'completed', { result: { proposed: true, written: false,
    skill: 'card-audit', created: true, files: [{ path: 'SKILL.md', bytes: 300, exists: false },
      { path: 'references/format.md', bytes: 90, exists: true }] } })),
  'Skill card-audit (new)\nSKILL.md · new · 300 bytes\nreferences/format.md · replaced · 90 bytes');
  assert.equal(stepDetail(step('propose_skills', 'completed', { result: { proposed: true, written: false,
    skill: 'card-audit', created: false, files: [{ path: 'SKILL.md', bytes: 300, exists: true }] } })),
  'Skill card-audit (replaces the installed one)\nSKILL.md · replaced · 300 bytes');
  assert.equal(stepDetail(step('propose_skills', 'completed', { result: { proposed: true, written: false,
    files: [], renames: [{ name: 'deck-tidy', to: 'deck-cleanup', bytes: 400 }],
    removals: [{ name: 'card-audit', bytes: 260 }] } })),
  'Skill deck-tidy → deck-cleanup · renamed\nSkill card-audit · retires the folder · 260 bytes');
  assert.equal(stepDetail(step('propose_skills', 'completed', { result: { proposed: false, written: false,
    files: [], error: 'SKILL.md is required: it is what makes the folder a skill' } })),
  'SKILL.md is required: it is what makes the folder a skill — nothing was proposed');
});

// The apply is the step that writes, so it reports what really landed, file by file, including the copy of
// every text it replaced — which is what makes the change visibly reversible.
test('describes an applied instruction change from what landed', () => {
  assert.equal(stepDetail(step('apply_instructions', 'pending',
    { action: { name: 'apply_instructions', args: { files: [{}], renames: [{}], removals: [{}] } } })),
  'Applying 1 file, 1 rename, 1 removal…');
  assert.equal(stepDetail(step('apply_instructions', 'completed', { result: { applied: true, renames: [], removals: [],
    files: [{ name: 'card-style.md', bytes: 120, created: true, backup: '' },
      { name: 'reply.md', bytes: 40, created: false, backup: 'versions/reply.md.2026' }] } })),
  'card-style.md · new file · 120 bytes\nreply.md · replaced, kept at versions/reply.md.2026 · 40 bytes');
  assert.equal(stepDetail(step('apply_instructions', 'completed', { result: { applied: true, files: [],
    renames: [{ name: 'language.md', to: 'reply-language.md', bytes: 40 }],
    removals: [{ name: 'old.md', bytes: 12, backup: 'versions/old.md.2026' }] } })),
  'language.md → reply-language.md · renamed\nold.md · retired, kept at versions/old.md.2026');
  // A refusal part-way through is the one answer that has to name what already landed, so the step says
  // which side of the write the failure fell on.
  assert.equal(stepDetail(step('apply_instructions', 'completed', { result: { applied: false, renames: [], removals: [],
    files: [{ name: 'style.md', bytes: 9, created: true, backup: '' }], error: 'no such instruction: missing.md' } })),
  'no such instruction: missing.md — the changes above are written');
  assert.equal(stepDetail(step('apply_instructions', 'completed', { result: { applied: false, files: [],
    renames: [], removals: [], error: 'no such instruction: missing.md' } })),
  'no such instruction: missing.md — nothing was written');
});

// An applied folder reports the same two facts a proposal does — whether the skill is new, and what happened
// to each file — from the write rather than from the plan.
test('describes an applied skill folder from what landed', () => {
  assert.equal(stepDetail(step('apply_skills', 'pending',
    { action: { name: 'apply_skills', args: { name: 'card-audit', files: [{}] } } })),
  'Applying the skill card-audit…');
  assert.equal(stepDetail(step('apply_skills', 'pending',
    { action: { name: 'apply_skills', args: { renames: [{ name: 'a', to: 'b' }], removals: [] } } })),
  'Applying 1 rename…');
  assert.equal(stepDetail(step('apply_skills', 'completed', { result: { applied: true, skill: 'card-review',
    created: true, files: [{ path: 'SKILL.md', bytes: 300, created: true, backup: '' },
      { path: 'references/format.md', bytes: 90, created: false,
        backup: 'versions/card-review/references/format.md.2026' }] } })),
  'Skill card-review (new)\nSKILL.md · new · 300 bytes\nreferences/format.md · replaced, kept at'
    + ' versions/card-review/references/format.md.2026 · 90 bytes');
  // A move and a retirement are reported from the copies they left behind, which is what makes them
  // reversible in the user's hands as well as in the library's.
  assert.equal(stepDetail(step('apply_skills', 'completed', { result: { applied: true, files: [], renames: [
    { name: 'deck-tidy', to: 'deck-cleanup', backup: 'versions/deck-tidy' }],
    removals: [{ name: 'card-audit', backup: 'versions/card-audit' }] } })),
  'Skill deck-tidy → deck-cleanup · renamed, kept at versions/deck-tidy\n'
    + 'Skill card-audit · retired, kept at versions/card-audit');
  assert.equal(stepDetail(step('apply_skills', 'completed', { result: { applied: false, files: [],
    error: 'frontmatter name "card-audit" does not match folder "card-review"' } })),
  'frontmatter name "card-audit" does not match folder "card-review" — nothing was written');
  // A rename that landed before a removal was refused is the same half-applied answer an instruction gets:
  // the sentence has to say that what the result lists is already on disk.
  assert.equal(stepDetail(step('apply_skills', 'completed', { result: { applied: false, files: [],
    renames: [{ name: 'card-audit', to: 'card-review', backup: 'versions/card-audit' }], removals: [],
    error: 'unknown skill: missing' } })),
  'unknown skill: missing — the changes above are written');
});

// A profile change is the step a reader has the least ability to judge unaided, so the step names the file and
// either what an edit would touch or whether the profile is new — and a refusal says no file came of it.
test('describes a proposed profile change from what an apply would do', () => {
  assert.equal(stepDetail(step('propose_card_profile', 'pending',
    { action: { name: 'propose_card_profile', args: { profiles: [{}, {}] } } })), 'Proposing 2 profiles…');
  assert.equal(stepDetail(step('propose_card_profile', 'pending',
    { action: { name: 'propose_card_profile', args: { renames: [{}], removals: [{}] } } })),
  'Proposing 1 rename, 1 removal…');
  assert.equal(stepDetail(step('propose_card_profile', 'completed', { result: { proposed: true, written: false,
    profiles: [{ name: 'Japanese.json', noteType: 'Japanese', bytes: 300, exists: false }],
    renames: [], removals: [] } })), 'Japanese.json · new profile · 300 bytes');
  // An edit names one location rather than restating the file, so the step is what tells a reader which part of
  // the profile is about to change.
  assert.equal(stepDetail(step('propose_card_profile', 'completed', { result: { proposed: true, written: false,
    profiles: [{ name: 'English.json', noteType: 'English', bytes: 400, field: 'typeLabel',
      changes: ['set typeLabel.enum'] }], renames: [], removals: [] } })),
  'English.json · set typeLabel.enum · 400 bytes');
  assert.equal(stepDetail(step('propose_card_profile', 'completed', { result: { proposed: true, written: false,
    profiles: [], renames: [{ name: 'English.json', to: 'Vocab Card.json', noteType: 'English',
      renamed: 'Vocab Card', bytes: 400 }], removals: [{ name: 'Old.json', noteType: 'Old', bytes: 12 }] } })),
  'English → Vocab Card · renamed with its note type\nOld.json · retires the Old profile · 12 bytes');
  assert.equal(stepDetail(step('propose_card_profile', 'completed', { result: { proposed: false, written: false,
    profiles: [], error: 'field meaning is not stored' } })),
  'field meaning is not stored — nothing was proposed');
});

// The write half is reported from the library's own answer, including the copy of the profile it replaced — and
// a refusal that followed a write has to say that what the result lists is already on disk.
test('describes an applied profile change from what landed', () => {
  assert.equal(stepDetail(step('apply_card_profile', 'pending',
    { action: { name: 'apply_card_profile', args: { profiles: [{}] } } })), 'Applying 1 profile…');
  assert.equal(stepDetail(step('apply_card_profile', 'completed', { result: { applied: true,
    profiles: [{ name: 'Japanese.json', noteType: 'Japanese', bytes: 300, created: true, backup: '' }],
    renames: [], removals: [] } })), 'Japanese.json · new profile');
  assert.equal(stepDetail(step('apply_card_profile', 'completed', { result: { applied: true,
    profiles: [{ name: 'English.json', noteType: 'English', created: false,
      backup: 'versions/English.json.2026', changes: ['set typeLabel.enum'] }], renames: [], removals: [] } })),
  'English.json · replaced, kept at versions/English.json.2026 · set typeLabel.enum');
  assert.equal(stepDetail(step('apply_card_profile', 'completed', { result: { applied: true, profiles: [], renames: [
    { name: 'English.json', to: 'Vocab Card.json', renamed: 'Vocab Card', backup: 'versions/English.json.2026' }],
    removals: [{ name: 'Old.json', backup: 'versions/Old.json.2026' }] } })),
  'English.json → Vocab Card.json · renamed, kept at versions/English.json.2026\n'
    + 'Old.json · retired, kept at versions/Old.json.2026');
  assert.equal(stepDetail(step('apply_card_profile', 'completed', { result: { applied: false,
    profiles: [{ name: 'Japanese.json', noteType: 'Japanese', bytes: 300, created: true, backup: '' }], renames: [],
    removals: [], error: 'no card profile for the Missing note type, so there is none to remove',
    instruction: 'The changes this result lists are written; do not apply them again.' } })),
  'no card profile for the Missing note type, so there is none to remove — the changes above are written');
  assert.equal(stepDetail(step('apply_card_profile', 'completed', { result: { applied: false, profiles: [],
    renames: [], removals: [], error: 'field meaning is not stored' } })),
  'field meaning is not stored — nothing was written');
});

// The preview under a reply shows exactly what the library agreed to write: the body from the call, keyed by
// the file its result named, so a preview can only ever describe a change the library itself accepted.
test('previews one entry per proposed file, body and name paired', () => {
  const proposal = { action: { name: 'propose_instructions', args: { files: [
    { name: 'card-style.md', content: 'Use simple English.' },
    { name: 'reply.md', content: 'Be terse.' },
  ] } }, status: 'completed', result: { proposed: true, written: false, files: [
    { name: 'card-style.md', bytes: 20, exists: false },
    { name: 'reply.md', bytes: 10, exists: true },
    // A result naming a file the call never carried has no body to write, so it is dropped.
    { name: 'ghost.md', bytes: 5, exists: false },
  ] } };
  assert.deepEqual(proposedPreviews([proposal]), [
    { kind: 'instruction', op: 'write', name: 'card-style.md', content: 'Use simple English.' },
    { kind: 'instruction', op: 'write', name: 'reply.md', content: 'Be terse.' },
  ]);
});

// A rename and a removal change a file that is already there, so their entries carry no body: they name the
// file the library itself read, and the operation is part of the entry's identity so a write and a rename of
// the same name are never taken for each other.
test('previews a rename and a removal as entries of their own', () => {
  const proposal = { action: { name: 'propose_instructions', args: {
    files: [{ name: 'card-style.md', content: 'Use simple English.' }],
    renames: [{ name: 'language.md', to: 'reply-language.md' }],
    removals: ['old.md'],
  } }, status: 'completed', result: { proposed: true, written: false,
    files: [{ name: 'card-style.md', bytes: 20, exists: false }],
    renames: [{ name: 'language.md', to: 'reply-language.md', bytes: 40 }],
    removals: [{ name: 'old.md', bytes: 12 }] } };
  assert.deepEqual(proposedPreviews([proposal]), [
    { kind: 'instruction', op: 'write', name: 'card-style.md', content: 'Use simple English.' },
    { kind: 'instruction', op: 'rename', name: 'language.md', to: 'reply-language.md' },
    { kind: 'instruction', op: 'remove', name: 'old.md' },
  ]);
  // The entry carries the library's own target, so a preview can only describe a move it agreed to.
  const tampered = { ...proposal, result: { ...proposal.result,
    renames: [{ name: 'language.md', to: 'other.md', bytes: 40 }] } };
  assert.deepEqual(proposedPreviews([tampered]).at(1),
    { kind: 'instruction', op: 'rename', name: 'language.md', to: 'other.md' });
  // A result naming a file the call never mentioned is dropped, like a file with no body is.
  const ghost = { ...proposal, result: { ...proposal.result,
    removals: [{ name: 'ghost.md', bytes: 1 }], renames: [{ name: 'ghost.md', to: 'x.md', bytes: 1 }] } };
  assert.deepEqual(proposedPreviews([ghost]).map(entry => entry.name), ['card-style.md']);
});

// A skill is a folder, so one preview carries its whole contents: the body and every reference the result
// named, paired with the call the same way an instruction file is.
test('previews one entry per proposed skill, carrying its whole folder', () => {
  const proposal = { action: { name: 'propose_skills', args: { name: 'card-audit', files: [
    { path: 'SKILL.md', content: '# Card audit' },
    { path: 'references/format.md', content: 'Rules.' },
  ] } }, status: 'completed', result: { proposed: true, written: false, skill: 'card-audit', created: false,
    files: [{ path: 'SKILL.md', bytes: 12, exists: true },
      { path: 'references/format.md', bytes: 6, exists: false },
      { path: 'references/ghost.md', bytes: 1, exists: false }] } };
  assert.deepEqual(proposedPreviews([proposal]), [{ kind: 'skill', op: 'write', name: 'card-audit',
    files: [{ path: 'SKILL.md', content: '# Card audit' },
      { path: 'references/format.md', content: 'Rules.' }] }]);
});

// A skill that only moves or leaves has no text of its own to show, so its entry names the change and is
// keyed by the operation — a write and a removal of the same folder are two different things to agree to.
test('previews a skill rename and a skill removal as entries of their own', () => {
  const proposal = { action: { name: 'propose_skills', args: {
    renames: [{ name: 'deck-tidy', to: 'deck-cleanup' }], removals: ['card-audit'] } },
  status: 'completed', result: { proposed: true, written: false, files: [],
    renames: [{ name: 'deck-tidy', to: 'deck-cleanup', bytes: 400 }],
    removals: [{ name: 'card-audit', bytes: 260 }] } };
  assert.deepEqual(proposedPreviews([proposal]), [
    { kind: 'skill', op: 'rename', name: 'deck-tidy', to: 'deck-cleanup' },
    { kind: 'skill', op: 'remove', name: 'card-audit' },
  ]);
  // The entry carries the library's own target, so a preview can only describe a move it agreed to.
  const tampered = { ...proposal, result: { ...proposal.result,
    renames: [{ name: 'deck-tidy', to: 'other', bytes: 400 }] } };
  assert.deepEqual(proposedPreviews([tampered]).at(0),
    { kind: 'skill', op: 'rename', name: 'deck-tidy', to: 'other' });
});

// A profile is shown from the library's own answer rather than from the call, because an edit names no file at
// all: the text in the window is the profile the edit would produce, which is the only thing a reader can
// judge it by. A move and a retirement name the note type, which is what the user knows the profile by.
test('previews a proposed profile as the file it would write, and a change of name as itself', () => {
  const proposal = { action: { name: 'propose_card_profile', args: { profiles: [
    { noteType: 'Japanese', profile: { profile: 1, noteType: 'Japanese' } },
    { noteType: 'English', edit: { field: 'typeLabel', set: { enum: ['C'] } } },
  ] } }, status: 'completed', result: { proposed: true, written: false, renames: [], removals: [], profiles: [
    { name: 'Japanese.json', noteType: 'Japanese', bytes: 300, content: '{ "noteType": "Japanese" }', exists: false },
    { name: 'English.json', noteType: 'English', bytes: 400, field: 'typeLabel', changes: ['set typeLabel.enum'],
      content: '{ "noteType": "English", "version": "1.7" }' },
    // An entry with no text has nothing to draw, so it is dropped rather than shown as an empty window.
    { name: 'Ghost.json', noteType: 'Ghost', bytes: 1, exists: false },
  ] } };
  assert.deepEqual(proposedPreviews([proposal]), [
    { kind: 'profile', op: 'write', name: 'Japanese.json', content: '{ "noteType": "Japanese" }' },
    { kind: 'profile', op: 'write', name: 'English.json', content: '{ "noteType": "English", "version": "1.7" }' },
  ]);
  const moved = { ...proposal, result: { ...proposal.result, profiles: [],
    renames: [{ name: 'English.json', to: 'Vocab Card.json', noteType: 'English', renamed: 'Vocab Card', bytes: 400 }],
    removals: [{ name: 'Old.json', noteType: 'Old', bytes: 12 }] } };
  assert.deepEqual(proposedPreviews([moved]), [
    { kind: 'profile', op: 'rename', name: 'English', to: 'Vocab Card' },
    { kind: 'profile', op: 'remove', name: 'Old' },
  ]);
});

// A refused, unfinished, or unrelated call contributes nothing: a refusal carries no files, a call still
// running has no result yet, and a step that is not a proposal was never one.
test('previews nothing for a refused, unfinished, or unrelated proposal', () => {
  assert.deepEqual(proposedPreviews([
    { action: { name: 'propose_instructions', args: { files: [{ name: 'a.md', content: 'x' }] } },
      status: 'completed', result: { proposed: false, written: false, files: [], error: 'refused' } },
    { action: { name: 'propose_skills', args: { name: 'card-audit', files: [{ path: 'SKILL.md', content: 'x' }] } },
      status: 'completed', result: { proposed: false, written: false, files: [], error: 'refused' } },
    { action: { name: 'propose_card_profile', args: { profiles: [{ noteType: 'Japanese' }] } },
      status: 'completed', result: { proposed: false, written: false, profiles: [], error: 'refused' } },
    { action: { name: 'propose_card_profile', args: { profiles: [{ noteType: 'Japanese' }] } },
      status: 'pending' },
    { action: { name: 'propose_skills', args: { name: 'card-audit', files: [{ path: 'SKILL.md', content: 'x' }] } },
      status: 'pending' },
    step('search_notes', 'completed', { result: { total: 0 } }),
  ]), []);
});

// A model that corrects itself restates the file, so the reply shows the correction once instead of two
// windows that describe the same path.
test('previews a name proposed twice once, the later call winning', () => {
  const proposing = content => ({ action: { name: 'propose_instructions', args: { files: [
    { name: 'tone.md', content }] } }, status: 'completed', result: { files: [
    { name: 'tone.md', bytes: 4, exists: false }] } });
  assert.deepEqual(proposedPreviews([proposing('old'), proposing('new')]),
    [{ kind: 'instruction', op: 'write', name: 'tone.md', content: 'new' }]);
});

// The operation is part of an entry's identity: a file that is renamed is not the file that is written, so the
// two never take each other's place — only the same verb on the same name collapses to its last call.
test('keys a preview by kind, operation and name', () => {
  const write = { action: { name: 'propose_instructions', args: { files: [{ name: 'tone.md', content: 'Be terse.' }] } },
    status: 'completed', result: { files: [{ name: 'tone.md', bytes: 10, exists: false }] } };
  const rename = { action: { name: 'propose_instructions',
    args: { renames: [{ name: 'tone.md', to: 'tone-style.md' }] } },
  status: 'completed', result: { renames: [{ name: 'tone.md', to: 'tone-style.md', bytes: 10 }] } };
  assert.deepEqual(proposedPreviews([write, rename]).map(({ op, name }) => `${op}:${name}`),
    ['write:tone.md', 'rename:tone.md']);
});

// The preview belongs to the reply, not to the step: a step is persisted before the answer it led to, so a
// window rendered from the step would sit above the explanation that earns it.
test('puts a reply\'s previews after the reply, not after the step it came from', () => {
  const proposal = { action: { name: 'propose_instructions', args: { files: [
    { name: 'card-style.md', content: 'Use simple English.' }] } }, status: 'completed',
  result: { files: [{ name: 'card-style.md', bytes: 20, exists: false }] } };
  const parts = conversationParts([
    { role: 'user', content: 'remember this' },
    message(proposal),
    { role: 'assistant', content: 'One file.' },
    { role: 'user', content: 'anything else?' },
    { role: 'assistant', content: 'Nothing to show here.' },
  ]);
  assert.deepEqual(parts.map(part => part.previews ? 'preview' : part.message.role),
    ['user', 'tool', 'assistant', 'preview', 'user', 'assistant']);
  assert.deepEqual(parts[3].previews.map(entry => entry.name), ['card-style.md']);
});

test('shows the previews of a proposal whose run never replied, where its answer would have been', () => {
  const parts = conversationParts([
    { role: 'user', content: 'remember this' },
    message({ action: { name: 'propose_instructions', args: { files: [
      { name: 'tone.md', content: 'Be terse.' }] } }, status: 'completed',
    result: { files: [{ name: 'tone.md', bytes: 10, exists: false }] } }),
  ]);
  assert.deepEqual(parts.map(part => part.previews ? 'preview' : part.message.role), ['user', 'tool', 'preview']);
});

test('formats the elapsed run time', () => {
  assert.equal(formatElapsed(3240), '3s');
  assert.equal(formatElapsed(0), '0s');
});

// A run's steps are one window, so the parts a conversation renders from are regrouped after the previews
// have been placed: every run of adjacent steps becomes one entry, and nothing else about the order moves.
test('groups a run of adjacent steps into one window and leaves every other part alone', () => {
  const parts = conversationParts([
    { role: 'user', content: 'do it' },
    message(step('search_notes', 'completed')),
    message(step('create_notes', 'completed')),
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'again' },
    message(step('list_decks', 'completed')),
  ]);
  const grouped = groupSteps(parts);
  assert.deepEqual(grouped.map(part => part.steps ? `steps:${part.steps.length}` : part.message.role),
    ['user', 'steps:2', 'assistant', 'user', 'steps:1']);
  assert.deepEqual(grouped[1].steps.map(entry => JSON.parse(entry.content).action.name),
    ['search_notes', 'create_notes']);
});

// A proposal's previews are a part between the steps of one run and the steps of the next, so the window is
// closed by it rather than quietly swallowing the next run's calls.
test('a preview part separates two runs instead of merging them', () => {
  const proposal = { action: { name: 'propose_instructions', args: { files: [
    { name: 'tone.md', content: 'Be terse.' }] } }, status: 'completed',
  result: { files: [{ name: 'tone.md', bytes: 10, exists: false }] } };
  const grouped = groupSteps(conversationParts([
    { role: 'user', content: 'remember this' },
    message(proposal),
    { role: 'assistant', content: 'One file.' },
    { role: 'user', content: 'and check it' },
    message(step('search_notes', 'completed')),
  ]));
  assert.deepEqual(grouped.map(part => part.steps ? 'steps'
    : part.previews ? 'preview' : part.message.role),
  ['user', 'steps', 'assistant', 'preview', 'user', 'steps']);
});

test('groups nothing when a conversation holds no steps', () => {
  const parts = conversationParts([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.deepEqual(groupSteps(parts), parts);
  assert.deepEqual(groupSteps([]), []);
});

// A stopped run's steps all ran to their end, so the steps themselves cannot say the run was stopped: the
// window is marked by the reply that closes it, whose own payload is where the backend records the stop.
test('marks the window of a run the user stopped from the reply that closes it', () => {
  const reply = (payload, content) => ({ role: 'assistant', content, payload_json: JSON.stringify(payload) });
  const stopped = groupSteps(conversationParts([
    { role: 'user', content: 'go' },
    message(step('search_notes', 'completed')),
    reply({ cancelled: true }, 'Stopped by you.'),
  ]));
  assert.deepEqual(stopped.map(part => part.steps ? { steps: part.steps.length, stopped: part.stopped } : part.message.role),
    ['user', { steps: 1, stopped: true }, 'assistant']);
  const completed = groupSteps(conversationParts([
    { role: 'user', content: 'go' },
    message(step('search_notes', 'completed')),
    reply(null, 'done'),
  ]));
  assert.equal(completed[1].stopped, false);
  // A window nothing closes — the run died mid-step — is not a stop either.
  assert.equal(groupSteps(conversationParts([message(step('search_notes', 'completed'))]))[0].stopped, false);
});

// The previews a proposal left behind belong to the reply that closes the run, so they sit between the steps
// and the payload that says the run was stopped.
test('reads a stop through the previews that sit between the steps and the reply', () => {
  const proposal = { action: { name: 'propose_instructions', args: { files: [
    { name: 'tone.md', content: 'Be terse.' }] } }, status: 'completed',
  result: { files: [{ name: 'tone.md', bytes: 10, exists: false }] } };
  const grouped = groupSteps(conversationParts([
    { role: 'user', content: 'remember this' },
    message(proposal),
    { role: 'assistant', content: 'Stopped by you.', payload_json: JSON.stringify({ cancelled: true }) },
  ]));
  assert.deepEqual(grouped.map(part => part.steps ? `steps stopped=${part.stopped}`
    : part.previews ? 'preview' : part.message.role),
  ['user', 'steps stopped=true', 'assistant', 'preview']);
});
test('serializes the raw record of a step with its persisted timing', () => {
  assert.deepEqual(JSON.parse(operationJson(
    step('search_notes', 'completed', { result: { total: 3 } }),
    { created_at: '2026-09-17T00:00:01.000Z', durationMs: 1500 },
  )), {
    status: 'completed',
    action: { name: 'search_notes', args: {} },
    result: { total: 3 },
    recordedAt: '2026-09-17T00:00:01.000Z',
    durationMs: 1500,
  });
  assert.deepEqual(JSON.parse(operationJson(step('read_note', 'failed', { error: 'boom' }))), {
    status: 'failed',
    action: { name: 'read_note', args: {} },
    error: 'boom',
  });
});
