const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function readMigrationNames (migrationsDir) {
  return fs.readdirSync(migrationsDir)
    .filter(fileName => /^\d+_.+\.sql$/.test(fileName))
    .sort();
}

function migrate (db, migrationsDir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(row => row.name));
  const insert = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  for (const name of readMigrationNames(migrationsDir)) {
    if (applied.has(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      insert.run(name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

function createDatabase ({ dbPath, migrationsDir }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, migrationsDir);
  return db;
}

module.exports = { createDatabase, migrate };
