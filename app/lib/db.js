'use strict';
// The recorder's own SQLite store. Lives only under data_dir; never inside a watched tree.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS worktrees (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, root_id INTEGER, common_dir TEXT, repo_name TEXT,
  branch TEXT, head TEXT, upstream TEXT, ahead INTEGER, behind INTEGER, status_json TEXT,
  first_seen_utc TEXT, last_scan_utc TEXT, last_ok_utc TEXT, state TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, utc TEXT NOT NULL, worktree_id INTEGER, root_id INTEGER, source TEXT NOT NULL,
  kind TEXT NOT NULL, path TEXT, before_ref TEXT, after_ref TEXT, detail_json TEXT, evidence TEXT NOT NULL,
  version_id INTEGER, dedupe TEXT NOT NULL UNIQUE);
CREATE INDEX IF NOT EXISTS ev_time ON events(utc);
CREATE INDEX IF NOT EXISTS ev_wt ON events(worktree_id, kind, utc);
CREATE INDEX IF NOT EXISTS ev_root ON events(root_id, utc);
CREATE TABLE IF NOT EXISTS commits (
  worktree_id INTEGER NOT NULL, sha TEXT NOT NULL, observed_utc TEXT, author TEXT, author_utc TEXT,
  subject TEXT, files_json TEXT, added INTEGER, deleted INTEGER, PRIMARY KEY (worktree_id, sha));
CREATE TABLE IF NOT EXISTS files (
  path_key TEXT PRIMARY KEY, path TEXT NOT NULL, root_id INTEGER, size INTEGER, mtime REAL,
  sha TEXT, version_id INTEGER, seen_utc TEXT);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL, root_id INTEGER, utc TEXT NOT NULL, sha TEXT, prior_id INTEGER,
  blob_sha TEXT, status TEXT NOT NULL, size INTEGER, reason TEXT, origin TEXT);
CREATE INDEX IF NOT EXISTS ver_path ON versions(path, utc);
CREATE INDEX IF NOT EXISTS ver_time ON versions(utc);
CREATE TABLE IF NOT EXISTS blobs (
  sha TEXT PRIMARY KEY, file TEXT NOT NULL, size_plain INTEGER, size_stored INTEGER, refcount INTEGER, utc TEXT, retired_utc TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  skey TEXT PRIMARY KEY, provider TEXT, session_id TEXT, file TEXT, offset INTEGER, file_mtime REAL,
  cwd TEXT, branch TEXT, first_utc TEXT, last_utc TEXT, model TEXT, state TEXT, tools_json TEXT, edits_json TEXT,
  tokens_json TEXT, token_kind TEXT, subagents INTEGER, title TEXT, originator TEXT, parse_errors INTEGER);
CREATE TABLE IF NOT EXISTS session_hours (
  skey TEXT, hour_utc TEXT, tools INTEGER, edits INTEGER, messages INTEGER, PRIMARY KEY (skey, hour_utc));
CREATE TABLE IF NOT EXISTS procs (
  pkey TEXT PRIMARY KEY, name TEXT, pid INTEGER, ppid INTEGER, created_utc TEXT, first_seen TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS heartbeats (minute TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY, source TEXT, start_utc TEXT, end_utc TEXT, reason TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, from_utc TEXT, to_utc TEXT, generated_utc TEXT, json TEXT, UNIQUE(from_utc, to_utc));
`;

function open(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'recorder.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  try { db.exec('ALTER TABLE files ADD COLUMN git_blob TEXT'); } catch {}
  const cache = new Map();
  db.q = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  db.tx = (fn) => { if (db.isTransaction) return fn(); db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  db.meta = (k, v) => {
    if (v === undefined) { const r = db.q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : null; }
    db.q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
  };
  return db;
}

// Insert an event once; dedupe key makes repeated watcher notifications/restarts idempotent.
function addEvent(db, e) {
  const r = db.q(`INSERT OR IGNORE INTO events(utc,worktree_id,root_id,source,kind,path,before_ref,after_ref,detail_json,evidence,version_id,dedupe)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.utc, e.worktree_id ?? null, e.root_id ?? null, e.source, e.kind, e.path ?? null,
    e.before_ref ?? null, e.after_ref ?? null, e.detail ? JSON.stringify(e.detail) : null, e.evidence, e.version_id ?? null, e.dedupe);
  return r.changes ? Number(r.lastInsertRowid) : null;
}

module.exports = { open, addEvent };
