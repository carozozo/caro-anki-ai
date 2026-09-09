const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server-process');

test('library routes list and edit entries', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-skills-api-'));
  const dir = path.join(root, 'skills');
  const instructions = path.join(root, 'instructions');
  const memories = path.join(root, 'memories');
  const { port, stop } = await startServer({
    CARO_INSTRUCTIONS_DIR: instructions, CARO_MEMORIES_DIR: memories, CARO_SKILLS_DIR: dir,
  });
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true, force: true }); });

  const api = async (route, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body && JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  };

  const first = await api('/api/skills');
  assert.equal(first.status, 200);
  assert.equal(first.payload.ok, true);
  assert.deepEqual(first.payload.errors, []);
  assert.deepEqual(first.payload.skills.filter(skill => skill.seeded).map(skill => skill.name),
    ['instruction', 'skill']);

  const createdInstruction = await api('/api/instructions', 'POST', { name: 'style.md', content: 'Rule one.' });
  assert.equal(createdInstruction.status, 201);
  const createdMemory = await api('/api/memories', 'POST', { name: 'reply-style.md', content: '記憶一。' });
  assert.equal(createdMemory.status, 201);
  const createdSkill = await api('/api/skills', 'POST', {
    name: 'card-review', description: 'Check one card.', body: 'Read the card.',
  });
  assert.equal(createdSkill.status, 201);
  assert.equal(fs.readFileSync(path.join(instructions, 'style.md'), 'utf8'), 'Rule one.\n');
  assert.equal(fs.readFileSync(path.join(memories, 'reply-style.md'), 'utf8'), '記憶一。\n');
  assert.match(fs.readFileSync(path.join(dir, 'card-review', 'SKILL.md'), 'utf8'), /Read the card\./);
  assert.equal((await api('/api/instructions', 'POST', { name: 'style.md', content: 'Overwrite.' })).status, 409);
  assert.equal((await api('/api/skills', 'POST', {
    name: 'card-review', description: 'Overwrite.', body: 'Overwrite.',
  })).status, 409);
  assert.equal((await api('/api/skills', 'POST', {
    name: 'instruction', description: 'Overwrite seed.', body: 'Overwrite.',
  })).status, 409);
  assert.equal(fs.readFileSync(path.join(instructions, 'style.md'), 'utf8'), 'Rule one.\n');

  const updatedInstruction = await api('/api/instructions/style.md', 'PUT', { content: 'Rule two.' });
  const updatedMemory = await api('/api/memories/reply-style.md', 'PUT', { content: '記憶二。' });
  const updatedSkill = await api('/api/skills/card-review', 'PUT', { body: 'Read and report.' });
  assert.equal(updatedInstruction.status, 200);
  assert.equal(updatedMemory.status, 200);
  assert.equal(updatedSkill.status, 200);
  const skillFile = fs.readFileSync(path.join(dir, 'card-review', 'SKILL.md'), 'utf8');
  assert.match(skillFile, /description: Check one card\./);
  assert.match(skillFile, /Read and report\./);

  fs.mkdirSync(path.join(dir, 'card-review', 'references'));
  fs.writeFileSync(path.join(dir, 'card-review', 'references', 'format.md'), 'One rule.\n');
  const renamedInstruction = await api('/api/instructions/style.md', 'PATCH', { to: 'card-style.md' });
  const renamedMemory = await api('/api/memories/reply-style.md', 'PATCH', { to: 'reply-language.md' });
  const renamedSkill = await api('/api/skills/card-review', 'PATCH', { to: 'card-check' });
  assert.equal(renamedInstruction.status, 200);
  assert.equal(renamedInstruction.payload.instruction.to, 'card-style.md');
  assert.equal(renamedMemory.payload.memory.to, 'reply-language.md');
  assert.equal(renamedSkill.status, 200);
  assert.equal(renamedSkill.payload.skill.to, 'card-check');
  assert.equal(fs.existsSync(path.join(instructions, 'style.md')), false);
  assert.equal(fs.readFileSync(path.join(instructions, 'card-style.md'), 'utf8'), 'Rule two.\n');
  assert.equal(fs.readFileSync(path.join(memories, 'reply-language.md'), 'utf8'), '記憶二。\n');
  assert.equal(fs.existsSync(path.join(dir, 'card-review')), false);
  assert.match(fs.readFileSync(path.join(dir, 'card-check', 'SKILL.md'), 'utf8'), /name: card-check/);
  assert.equal(fs.readFileSync(path.join(dir, 'card-check', 'references', 'format.md'), 'utf8'), 'One rule.\n');

  await api('/api/instructions', 'POST', { name: 'tone.md', content: 'Brief.' });
  const takenName = await api('/api/instructions/card-style.md', 'PATCH', { to: 'tone.md' });
  const invalidSkillName = await api('/api/skills/card-check', 'PATCH', { to: 'Card Check' });
  assert.equal(takenName.status, 400);
  assert.match(takenName.payload.error, /refusing to rename onto tone\.md/);
  assert.equal(invalidSkillName.status, 400);
  assert.match(invalidSkillName.payload.error, /must be a lowercase name/);

  // A folder the loader cannot read is reported beside the list instead of hiding it.
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'SKILL.md'), 'no frontmatter at all\n');
  const failed = await api('/api/skills');
  assert.deepEqual(failed.payload.errors.map(error => error.name), ['broken']);
  assert.equal(failed.payload.skills.some(skill => skill.name === 'card-check'), true);

  assert.equal((await api('/api/instructions/card-style.md', 'DELETE')).status, 200);
  assert.equal((await api('/api/memories/reply-language.md', 'DELETE')).status, 200);
  assert.equal((await api('/api/instructions/tone.md', 'DELETE')).status, 200);
  assert.equal((await api('/api/skills/card-check', 'DELETE')).status, 200);
  assert.equal(fs.existsSync(path.join(instructions, 'card-style.md')), false);
  assert.equal(fs.existsSync(path.join(memories, 'reply-language.md')), false);
  assert.equal(fs.existsSync(path.join(dir, 'card-check')), false);
});
