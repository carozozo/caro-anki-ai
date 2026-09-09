const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillLibrary } = require('../../skill-library');

// A real SkillLibrary over a throwaway directory, so a test exercises the code that runs in production
// rather than a stand-in for it.
function skillFixture (t, skills = [['card-audit', 'name: card-audit\ndescription: Audit notes.', 'Audit the target.']]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caro-skill-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, frontmatter, body] of skills) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  }
  const library = new SkillLibrary({ dir });
  library.initialize();
  return library;
}

module.exports = { skillFixture };
