const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const roots = ['backend', 'frontend', 'sqlite', 'desktop', 'scripts'];

const collect = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return collect(full);
  return entry.name.endsWith('.js') ? [full] : [];
});

const files = roots.flatMap(name => collect(path.join(root, name))).sort();
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

console.log(`Syntax OK: ${files.length} files`);
