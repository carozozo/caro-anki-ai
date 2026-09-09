const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDatabase } = require('../../sqlite/database');
const Repository = require('../../sqlite/repository');
const { AnkiAgent } = require('../anki-agent');
const { AgentMemory } = require('../agent-memory');

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-agent-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'memories') };
};

test('stores autonomous memories in editable Markdown files', t => {
  const { dir } = fixture(t);
  const memory = new AgentMemory({ dir });
  memory.initialize();
  assert.deepEqual(memory.list(), []);

  const saved = memory.update({ additions: [{
    name: 'concise-traditional-chinese.md', content: '使用者偏好精簡的繁體中文說明。',
  }] });
  assert.equal(saved.updated, true);
  const [entry] = memory.list();
  assert.equal(entry.id, 'concise-traditional-chinese.md');
  assert.equal(entry.content, '使用者偏好精簡的繁體中文說明。');
  assert.equal(fs.readFileSync(path.join(dir, entry.id), 'utf8'), '使用者偏好精簡的繁體中文說明。\n');
  assert.match(memory.prompt(), /user-editable Markdown files/);
  assert.match(memory.prompt(), new RegExp(entry.id));

  const corrected = memory.update({ updates: [{ id: entry.id, content: '使用者偏好有範例的繁體中文說明。' }] });
  assert.deepEqual(corrected.updates, [{ id: entry.id,
    before: '使用者偏好精簡的繁體中文說明。', content: '使用者偏好有範例的繁體中文說明。' }]);
  assert.equal(fs.readFileSync(path.join(dir, entry.id), 'utf8'), '使用者偏好有範例的繁體中文說明。\n');

  assert.equal(memory.update({ removals: [{ id: entry.id }] }).updated, true);
  assert.deepEqual(memory.list(), []);
});

test('requires a unique topic filename for every new memory', t => {
  const { dir } = fixture(t);
  const memory = new AgentMemory({ dir });
  memory.initialize();

  const missing = memory.update({ additions: [{ content: 'This must not be saved.' }] });
  assert.equal(missing.updated, false);
  assert.match(missing.error, /additions\[0\]\.name/);
  assert.deepEqual(memory.list(), []);

  const generated = memory.update({ additions: [{
    name: 'memory-03fc1233-ffe7-4a38-bf25-79676cd77af1.md', content: 'This must not be saved either.',
  }] });
  assert.equal(generated.updated, false);
  assert.match(generated.error, /must name the memory topic/);
  assert.deepEqual(memory.list(), []);

  memory.update({ additions: [{ name: 'reply-style.md', content: 'Use concise replies.' }] });
  const duplicate = memory.update({ additions: [{ name: 'reply-style.md', content: 'Use detailed replies.' }] });
  assert.equal(duplicate.updated, false);
  assert.match(duplicate.error, /name already exists/);
  assert.deepEqual(memory.list().map(({ id }) => id), ['reply-style.md']);
});

test('keeps legacy SQLite memories by exporting them before removing their rows', t => {
  const { root, dir } = fixture(t);
  const db = createDatabase({ dbPath: path.join(root, 'app.sqlite'),
    migrationsDir: path.resolve(__dirname, '../../sqlite/migrations') });
  t.after(() => db.close());
  const repository = new Repository(db);
  const profile = repository.ensureAnkiProfile({ name: 'First', collectionPath: path.join(root, 'first.anki2') }).profile;
  repository.applyAgentMemories(profile.id, {
    additions: [{ id: 'legacy-id', content: 'Keep this durable preference.' }], updates: [], removals: [],
  });

  const memory = new AgentMemory({ dir, repository });
  memory.initialize();
  assert.deepEqual(memory.list().map(({ content }) => content), ['Keep this durable preference.']);
  assert.deepEqual(repository.listAgentMemories(profile.id), []);
  assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.md')).length, 1);
});

test('refuses an invalid memory change before it writes any part of it', t => {
  const { dir } = fixture(t);
  const memory = new AgentMemory({ dir });
  memory.initialize();
  const refused = memory.update({
    additions: [{ name: 'write-test.md', content: 'This must not be saved.' }],
    updates: [{ id: 'missing.md', content: 'Impossible update.' }],
  });
  assert.equal(refused.updated, false);
  assert.match(refused.error, /No such memory/);
  assert.deepEqual(memory.list(), []);
});

test('offers an autonomous memory tool with saved context and the selected default language', async () => {
  const memory = {
    prompt: () => '## User memory\n\n### remembered.md\n使用簡潔的繁體中文。',
    update: change => ({ updated: true, additions: change.additions || [], updates: [], removals: [] }),
  };
  const offered = [];
  const records = [];
  const replies = [
    { toolCalls: [{ id: 'remember', name: 'update_memory', args: {
      additions: [{ name: 'examples-first.md', content: '使用者希望先給範例。' }],
    } }] },
    { content: '已記住。', toolCalls: [] },
  ];
  const agent = new AnkiAgent({
    browser: {}, client: {}, config: {}, memories: memory, language: 'zh-TW',
    provider: { completeWithTools: async options => {
      offered.push(options.tools.map(tool => tool.function.name));
      const prompt = options.messages.map(message => message.content).join('\n');
      assert.match(prompt, /使用簡潔的繁體中文/);
      assert.match(prompt, /selected default language is Traditional Chinese \(Taiwan\) \(zh-TW\)/);
      assert.match(prompt, /selected language unless the user requests another/);
      const memoryTool = options.tools.find(tool => tool.function.name === 'update_memory');
      assert.equal(memoryTool.function.parameters.properties.additions.items.required.includes('name'), true);
      return replies.shift();
    } },
  });
  const result = await agent.respond({ messages: [{ role: 'user', content: '以中文記住這件事' }],
    record: entry => records.push(entry) });
  assert.equal(result.content, '已記住。');
  assert.equal(offered[0].includes('update_memory'), true);
  assert.deepEqual(records.map(entry => entry.status), ['pending', 'completed']);
  assert.equal(records[1].result.updated, true);
});
