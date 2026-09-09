const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_SUGGESTIONS, acceptSkill, clearSkill, filterSkills, pinnedSkill, skillCommand, skillToken } =
  require('../../frontend/scripts/chat/skill-menu');

const skill = (name, description = '', extra = {}) => ({ name, description, ...extra });

test('reads a command that is still being typed, and only at the start of the message', () => {
  assert.equal(skillToken('/card-audit'), 'card-audit');
  assert.equal(skillToken('/Card-Audit'), 'card-audit');
  assert.equal(skillToken('/'), '');
  assert.equal(skillToken('  /card-audit'), null);
  assert.equal(skillToken('check /card-audit'), null);
  assert.equal(skillToken('card-audit'), null);
  assert.equal(skillToken(''), null);
  assert.equal(skillToken(undefined), null);
});

test('stops offering once the command is ended by whitespace', () => {
  assert.equal(skillToken('/card-audit check all cards'), null);
  assert.equal(skillToken('/card-audit\ncheck'), null);
  assert.equal(skillToken('/card-audit '), null);
});

test('offers only user-invocable skills, alphabetically', () => {
  const skills = [skill('zeta'), skill('alpha'), skill('model-only', '', { userInvocable: false })];
  assert.deepEqual(filterSkills(skills, '').map(entry => entry.name), ['alpha', 'zeta']);
});

test('ranks name prefix, then name, then description, and keeps each group alphabetical', () => {
  const skills = [
    skill('deck-tidy', 'Audit the collection for duplicates'),
    skill('card-audit', 'Check notes against the card contract'),
    skill('audit-extra', 'Another audit helper'),
  ];
  assert.deepEqual(filterSkills(skills, 'audit').map(entry => entry.name),
    ['audit-extra', 'card-audit', 'deck-tidy']);
  assert.deepEqual(filterSkills(skills, 'aud').map(entry => entry.name),
    ['audit-extra', 'card-audit', 'deck-tidy']);
  assert.deepEqual(filterSkills(skills, 'card').map(entry => entry.name), ['card-audit']);
});

test('matches a description case-insensitively and caps the list', () => {
  const many = [...'abcdefghijkl'].map(letter => skill(`skill-${letter}`, 'Cleanup helper'));
  assert.deepEqual(filterSkills(many, 'cleanup').map(entry => entry.name),
    ['skill-a', 'skill-b', 'skill-c', 'skill-d', 'skill-e', 'skill-f', 'skill-g', 'skill-h']);
  assert.equal(filterSkills(many, '').length, MAX_SUGGESTIONS);
  assert.equal(filterSkills(many, 'CLEANUP').length, MAX_SUGGESTIONS);
});

test('answers a query nothing matches with an empty list', () => {
  assert.deepEqual(filterSkills([skill('card-audit', 'Check notes')], 'zzz'), []);
  assert.deepEqual(filterSkills(null, ''), []);
});

test('accepting a suggestion rewrites the command and keeps a typed argument', () => {
  assert.equal(acceptSkill('/aud', 'card-audit'), '/card-audit ');
  assert.equal(acceptSkill('/aud check all cards', 'card-audit'), '/card-audit check all cards');
  assert.equal(acceptSkill('/aud  check', 'card-audit'), '/card-audit check');
  assert.equal(acceptSkill('/', 'card-audit'), '/card-audit ');
});

test('reads the finished command a message carries, and only at its start', () => {
  assert.equal(skillCommand('/card-audit'), 'card-audit');
  assert.equal(skillCommand('/Card-Audit check all cards'), 'card-audit');
  assert.equal(skillCommand('  /card-audit check'), 'card-audit');
  assert.equal(skillCommand('/card-audit\ncheck'), 'card-audit');
  assert.equal(skillCommand('\n/card-audit\ncheck'), 'card-audit');
  assert.equal(skillCommand('/'), '');
  assert.equal(skillCommand('/card-auditcheck'), 'card-auditcheck');
  assert.equal(skillCommand('check /card-audit'), null);
  assert.equal(skillCommand('card-audit'), null);
  assert.equal(skillCommand(''), null);
  assert.equal(skillCommand(undefined), null);
});

test('pins the installed skill a command names, and nothing else', () => {
  const skills = [skill('card-audit', 'Check notes'), skill('model-only', '', { userInvocable: false })];
  assert.equal(pinnedSkill('/card-audit check', skills).name, 'card-audit');
  assert.equal(pinnedSkill('/Card-Audit', skills).name, 'card-audit');
  assert.equal(pinnedSkill('/card', skills), null);
  assert.equal(pinnedSkill('/card-audit-extra', skills), null);
  assert.equal(pinnedSkill('/model-only', skills), null);
  assert.equal(pinnedSkill('use /card-audit', skills), null);
  assert.equal(pinnedSkill('', skills), null);
  assert.equal(pinnedSkill('/card-audit', null), null);
});

test('clearing a pinned command keeps the argument', () => {
  assert.equal(clearSkill('/card-audit check all cards'), 'check all cards');
  assert.equal(clearSkill('/card-audit'), '');
  assert.equal(clearSkill('/card-audit\ncheck'), 'check');
  assert.equal(clearSkill('check all cards'), 'check all cards');
  assert.equal(clearSkill(''), '');
  assert.equal(clearSkill(undefined), '');
});
