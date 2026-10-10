import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE posts (
    post_id TEXT PRIMARY KEY,
    url TEXT, author_handle TEXT, author_name TEXT, text TEXT, posted_at TEXT,
    genre TEXT NOT NULL DEFAULT 'unknown', genre_hint TEXT, lang TEXT,
    matched_keywords TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    merged_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
    is_sample INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE metric_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    views INTEGER, likes INTEGER, reposts INTEGER, replies INTEGER, bookmarks INTEGER,
    fetched_at TEXT NOT NULL
  );
  CREATE INDEX idx_snap_post ON metric_snapshots(post_id, fetched_at);
  CREATE TABLE dismissals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL, value TEXT NOT NULL,
    reason_code TEXT NOT NULL DEFAULT 'other', reason_note TEXT NOT NULL DEFAULT '',
    effect TEXT NOT NULL DEFAULT 'hide',
    created_at TEXT NOT NULL, revoked_at TEXT
  );
  CREATE TABLE digests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
    created_at TEXT NOT NULL, summary_by TEXT NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL, summary_text TEXT NOT NULL DEFAULT '', sections TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job TEXT NOT NULL, slot TEXT,
    started_at TEXT NOT NULL, finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running', message TEXT NOT NULL DEFAULT '',
    counts TEXT NOT NULL DEFAULT '{}'
  );
  CREATE UNIQUE INDEX idx_runs_slot ON runs(job, slot) WHERE slot IS NOT NULL;
  `,
];

export function openDb(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'x-trend.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db) {
  let v = db.prepare('PRAGMA user_version').get().user_version;
  while (v < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      v += 1;
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function createMeta(db) {
  const g = db.prepare('SELECT value FROM meta WHERE key = ?');
  const s = db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const d = db.prepare('DELETE FROM meta WHERE key = ?');
  return {
    get: (key) => g.get(key)?.value ?? null,
    set: (key, value) => void s.run(key, String(value)),
    delete: (key) => void d.run(key),
  };
}
