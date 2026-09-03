'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all().map((r) => r.filename)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    });
    runMigration();
    // eslint-disable-next-line no-console
    console.log(`[db] applied migration ${file}`);
  }
}

module.exports = { openDb, runMigrations };
