'use strict';
// Development Flight Recorder — passive, read-only observer. Entry point (run under supervisor.js).
const fs = require('fs');
const path = require('path');
const util = require('./lib/util');
const { log, nowIso, loadConfig } = util;
const dbm = require('./lib/db');
const store = require('./lib/store');
const { GitWatch } = require('./lib/gitwatch');
const { FsWatch } = require('./lib/fswatch');
const { Sessions } = require('./lib/sessions');
const { Procs } = require('./lib/procs');
const reports = require('./lib/reports');
const { makeServer } = require('./lib/http');

const STARTED = nowIso();
const cfg = loadConfig();
if (cfg.watch_roots.some((r) => util.isInside(cfg.data_dir, r.path))) { console.error('data_dir must not be inside a watched folder'); process.exit(3); }
fs.mkdirSync(cfg.data_dir, { recursive: true });
util.initLog(cfg.data_dir);
store.lockDownAcl(cfg.data_dir);
store.initKey(cfg.data_dir);
const db = dbm.open(cfg.data_dir);
log('INFO', `recorder starting pid=${process.pid} user=${process.env.USERNAME} data=${cfg.data_dir}`);

// Downtime since the last heartbeat is recorded as an explicit gap ("monitor offline"), never as zero activity.
const lastBeat = db.q('SELECT MAX(minute) m FROM heartbeats').get().m;
if (lastBeat) {
  const gapMin = (Date.now() - Date.parse(lastBeat + ':00Z')) / 60000;
  if (gapMin > 2) db.q('INSERT INTO gaps(source,start_utc,end_utc,reason,detail) VALUES(?,?,?,?,?)').run('monitor', lastBeat + ':00.000Z', STARTED, 'monitor_offline', `recorder not running for ~${Math.round(gapMin)} min`);
}
// One-time repair (2026-11-21): before a folder's first inventory finished, the inventory's own reads were
// logged as "created". Relabel those (never delete) so they no longer count as new files.
if (!db.meta('fix_first_pass_creates_v1')) {
  let n = 0;
  for (const r of cfg.watch_roots) {
    const done = db.q("SELECT MIN(utc) u FROM events WHERE root_id=? AND kind='baseline_established' AND source='fs'").get(r.id).u;
    const cut = done || '9999';
    n += db.q("UPDATE events SET kind='seen_during_first_pass' WHERE root_id=? AND source='fs' AND kind='created' AND utc<=?").run(r.id, cut).changes;
  }
  db.meta('fix_first_pass_creates_v1', nowIso());
  log('INFO', `relabelled ${n} first-pass event(s) as seen_during_first_pass`);
}
// One-time repair (2026-11-21): files inside ignored folders (e.g. __pycache__, _scrap*) slipped in when a whole
// folder changed at once. Relabel (never delete) so they stop counting.
if (!db.meta('fix_ignored_folder_events_v1')) {
  let n = 0;
  const upd = db.q("UPDATE events SET kind='ignored_folder_noise' WHERE id=?");
  for (const r of cfg.watch_roots) {
    for (const e of db.q("SELECT id,path FROM events WHERE root_id=? AND source IN ('fs','fs_reconcile') AND kind IN ('created','modified','deleted','renamed')").all(r.id)) {
      if (util.excludedDirSegment(cfg, path.relative(r.path, e.path))) { upd.run(e.id); n++; }
    }
  }
  db.meta('fix_ignored_folder_events_v1', nowIso());
  log('INFO', `relabelled ${n} event(s) inside ignored folders`);
}
const beat = () => db.q('INSERT OR IGNORE INTO heartbeats(minute) VALUES(?)').run(new Date().toISOString().slice(0, 16));
beat();

const gitw = new GitWatch(db, cfg);
const fsw = new FsWatch(db, cfg, gitw);
const sess = new Sessions(db, cfg);
const procs = new Procs(db, cfg);
const phase = { git: 'pending', fs: 'pending', sessions: 'pending' };

function health() {
  const wts = db.q('SELECT state, COUNT(*) n FROM worktrees GROUP BY state').all();
  const failed = db.q("SELECT path, state, error, last_scan_utc FROM worktrees WHERE state IN ('degraded','unavailable')").all();
  const dbFile = path.join(cfg.data_dir, 'recorder.sqlite');
  const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
  const nextBoundary = new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString();
  const lastGit = db.q('SELECT MAX(last_ok_utc) t FROM worktrees').get().t;
  const recentGaps = db.q('SELECT source,start_utc,end_utc,reason,detail FROM gaps ORDER BY id DESC LIMIT 30').all();
  const paused = db.meta('capture_paused_quota');
  const problems = [];
  if (failed.length) problems.push(`${failed.length} worktree(s) degraded/unavailable`);
  if (!lastGit || Date.now() - Date.parse(lastGit) > cfg.git_scan_seconds * 3000) problems.push('git sampling stale');
  if (fsw.watchers.size < cfg.watch_roots.filter((r) => fs.existsSync(r.path)).length) problems.push('a filesystem watcher is not running');
  if (paused) problems.push('snapshot capture paused (store quota)');
  if (procs.error) problems.push('process sampler: ' + procs.error);
  return {
    state: problems.length ? 'degraded' : 'healthy', problems, started_utc: STARTED, now_utc: nowIso(), pid: process.pid, run_as: process.env.USERNAME, phase,
    watch_roots: cfg.watch_roots.map((r) => ({ id: r.id, path: r.path, kind: r.kind, snapshots: !!r.snapshots, present: fs.existsSync(r.path), watcher: fsw.watchers.has(r.id), baseline_utc: db.meta(`fs_baseline:${util.key(r.path)}`) })),
    worktrees_by_state: wts, failed_paths: failed, linked_worktrees_outside_roots: gitw.outsideWorktrees.length,
    last_git_scan_utc: lastGit, last_reconcile_utc: db.meta('last_reconcile_utc'), fs: fsw.stats,
    transcript_readers: sess.providers, process_sampler: { last_sample_utc: procs.last, counts: procs.lastCount, error: procs.error },
    storage: { data_dir: cfg.data_dir, db_bytes: size(dbFile) + size(dbFile + '-wal'), snapshot_store_bytes: store.storeBytes(db), snapshot_quota_bytes: cfg.snapshots.max_store_bytes, retention_days: cfg.snapshots.retention_days, capture_paused_since: paused || null },
    next_report_boundary_utc: nextBoundary, reports_stored: db.q('SELECT COUNT(*) n FROM reports').get().n, recent_gaps: recentGaps,
  };
}

const ctx = { db, cfg, gitw, store, health, logErr: (e) => log('ERROR', e.stack || String(e)) };
makeServer(ctx, 'admin');
makeServer(ctx, 'remote');
log('INFO', `admin http://127.0.0.1:${cfg.local_admin.port}/  remote-report http://127.0.0.1:${cfg.remote_report.port}/`);

const every = (ms, fn, name) => {
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { log('ERROR', `${name}: ${e.stack || e}`); } finally { busy = false; } }, ms);
};

(async () => {
  procs.start();
  phase.git = 'discovering';
  await gitw.discover();
  await gitw.tickAll();
  phase.git = 'running';
  fsw.start();                  // start watching before baseline so nothing is missed during the walk
  // Regular jobs start now, not after the (possibly long) first pass.
  every(60000, beat, 'heartbeat');
  every(cfg.git_scan_seconds * 1000, () => gitw.tickAll(), 'git');
  every(cfg.session_scan_seconds * 1000, () => sess.scan(), 'sessions');
  phase.fs = 'baseline/reconcile';
  sess.scan().then(() => { phase.sessions = 'running'; }).catch((e) => log('ERROR', 'sessions: ' + e.stack));
  fsw.reconciling = true;       // keep the periodic reconcile from overlapping the first pass
  try { await fsw.baselineOrReconcileUnlocked(); } finally { fsw.reconciling = false; }
  phase.fs = 'running';
  reports.materialize(db, cfg);
  every(cfg.fs_reconciliation_minutes * 60000, () => fsw.reconcile(), 'reconcile');
  every(6 * 3600000, () => gitw.discover(), 'discover');
  every(60000, () => reports.materialize(db, cfg), 'reports');
  every(6 * 3600000, () => store.retire(db, cfg, cfg.data_dir), 'retention');
  log('INFO', 'recorder fully running');
})().catch((e) => { log('ERROR', 'startup: ' + e.stack); process.exit(1); });

const shutdown = () => { log('INFO', 'recorder stopping'); fsw.stop(); procs.stop(); try { db.close(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { log('ERROR', 'uncaught: ' + (e.stack || e)); process.exit(2); });
