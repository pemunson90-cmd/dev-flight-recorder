'use strict';
// Filesystem observer: native recursive watchers per root + periodic reconciliation,
// and bounded historical snapshot capture for eligible text files.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { log, nowIso, key, isInside, excludedDirSegment, sensitiveName } = require('./util');
const { addEvent } = require('./db');
const store = require('./store');

const BASELINE_BUDGET = 400 * 1024 * 1024; // stored bytes per root for initial dirty/untracked/non-Git baseline

class FsWatch {
  constructor(db, cfg, gitw) {
    this.db = db; this.cfg = cfg; this.gitw = gitw;
    this.watchers = new Map(); this.timers = new Map(); this.gitTimers = new Map();
    this.recentDeletes = new Map(); this.stats = { events: 0, overflows: 0, errors: 0 };
    this.reconciling = false; this.lastReconcile = null; this.inflight = new Map(); this.lsCache = new Map();
    this.baselining = new Set(cfg.watch_roots.filter((r) => !db.meta(`fs_baseline:${key(r.path)}`)).map((r) => r.id));
  }

  rootOf(p) { return this.cfg.watch_roots.find((r) => isInside(p, r.path)); }

  start() { for (const r of this.cfg.watch_roots) this.watchRoot(r); }
  watchRoot(r) {
    if (this.watchers.has(r.id)) return;
    if (!fs.existsSync(r.path)) {
      this.gap('fs', r, 'root_unavailable', 'watch root not present; will retry');
      setTimeout(() => this.watchRoot(r), 60000); return;
    }
    try {
      const w = fs.watch(r.path, { recursive: true, persistent: true }, (type, name) => this.onEvent(r, type, name));
      w.on('error', (e) => {
        this.stats.errors++;
        this.gap('fs', r, 'watcher_error', e.message);
        log('WARN', `watcher error ${r.path}: ${e.message}`);
        try { w.close(); } catch {}
        this.watchers.delete(r.id);
        setTimeout(() => { this.watchRoot(r); this.reconcile([r]).catch(() => {}); }, 5000);
      });
      this.watchers.set(r.id, w);
    } catch (e) { this.gap('fs', r, 'watcher_failed', e.message); setTimeout(() => this.watchRoot(r), 60000); }
  }
  stop() { for (const w of this.watchers.values()) try { w.close(); } catch {} this.watchers.clear(); }

  gap(source, r, reason, detail) {
    const now = nowIso();
    this.db.q('INSERT INTO gaps(source,start_utc,end_utc,reason,detail) VALUES(?,?,?,?,?)').run(source, now, now, reason, `${r ? r.path + ': ' : ''}${detail}`);
  }

  onEvent(r, type, name) {
    if (!name) { // Windows reports a null name when the change buffer overflowed.
      this.stats.overflows++;
      if (this.baselining.has(r.id)) return; // first inventory in progress; it covers this
      this.gap('fs', r, 'watcher_overflow', 'event buffer overflow; precise times lost, reconciling');
      clearTimeout(this.overflowTimer);
      this.overflowTimer = setTimeout(() => this.reconcile([r]).catch(() => {}), 10000);
      return;
    }
    const full = path.join(r.path, name);
    const segs = name.split(/[\\/]/);
    const gi = segs.findIndex((s) => s.toLowerCase() === '.git');
    if (gi >= 0) { // git metadata changed: ask the git sampler to rescan that repo soon
      const repoDir = path.join(r.path, ...segs.slice(0, gi));
      const wt = this.gitw.worktreeFor(repoDir);
      if (wt) {
        const common = this.db.q('SELECT common_dir FROM worktrees WHERE id=?').get(wt.id).common_dir;
        clearTimeout(this.gitTimers.get(common));
        this.gitTimers.set(common, setTimeout(() => {
          for (const w of this.db.q("SELECT id FROM worktrees WHERE common_dir=? AND state!='unavailable'").all(common)) this.gitw.request(w.id);
          this.gitw.drain().catch(() => {});
        }, 3000));
      }
      return;
    }
    if (excludedDirSegment(this.cfg, name)) return;
    // During a root's first inventory there is nothing to compare against, and the inventory's own reads raise
    // change notices. Ignore them; a reconcile right after the inventory catches real edits made meanwhile.
    if (this.baselining.has(r.id)) return;
    const k = key(full);
    clearTimeout(this.timers.get(k));
    this.timers.set(k, setTimeout(() => { this.timers.delete(k); this.settle(r, full).catch((e) => log('WARN', `settle ${full}: ${e.message}`)); }, 700));
  }

  // One settle per path at a time; a notice arriving mid-settle triggers one re-check afterwards.
  async settle(r, full, origin = 'watch') {
    const k = key(full);
    const slot = this.inflight.get(k);
    if (slot) { slot.again = origin; return; }
    const mine = { again: null }; this.inflight.set(k, mine);
    try { await this._settle(r, full, origin); } finally {
      this.inflight.delete(k);
      if (mine.again) await this.settle(r, full, mine.again);
    }
  }
  async _settle(r, full, origin) {
    let st;
    try { st = await fsp.lstat(full); } catch (e) {
      if (e.code === 'ENOENT') return this.markDeleted(r, full, origin);
      return this.recordEvent(r, full, 'unreadable', origin, { error: e.code });
    }
    if (st.isSymbolicLink()) return;
    const relp = path.relative(r.path, full);
    // Ignore-list check on the item itself (a directory notice like "task/__pycache__" names the excluded folder last).
    if (excludedDirSegment(this.cfg, st.isDirectory() ? relp + path.sep + 'x' : relp)) return;
    if (st.isDirectory()) { await this.walk(r, full, origin); return; }
    if (!st.isFile()) return;
    const row = this.db.q('SELECT * FROM files WHERE path_key=?').get(key(full));
    const isNew = !row || row.size === -1;
    if (!isNew && row.size === st.size && Math.abs(row.mtime - st.mtimeMs) < 1) return; // unchanged
    // Wait briefly for writers to finish (size stable).
    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 250));
      let s2; try { s2 = await fsp.stat(full); } catch { return this.markDeleted(r, full, origin); }
      if (s2.size === st.size && s2.mtimeMs === st.mtimeMs) break;
      st = s2;
    }
    const cap = await this.capture(r, full, st, row, origin);
    if (cap && cap.unchanged) return;
    let kind = isNew ? 'created' : 'modified';
    let detail = { size: st.size, origin };
    if (isNew && cap && cap.sha) {
      const d = this.recentDeletes.get(cap.sha);
      if (d && Date.now() - d.t < 5000) { kind = 'renamed'; detail = { ...detail, from: d.path, inferred: 'identical content within 5 s' }; this.recentDeletes.delete(cap.sha); }
    }
    this.recordEvent(r, full, kind, origin, detail, cap ? cap.version_id : null);
  }

  recordEvent(r, full, kind, origin, detail, version_id = null) {
    this.stats.events++;
    const wt = this.gitw.worktreeFor(full);
    const utc = nowIso();
    addEvent(this.db, { utc, worktree_id: wt ? wt.id : null, root_id: r.id, source: origin === 'watch' ? 'fs' : 'fs_reconcile', kind, path: full,
      detail: { ...detail, observed_after_restart: origin !== 'watch' || undefined }, evidence: 'fs_observed', version_id, dedupe: `fs:${key(full)}:${kind}:${utc}:${Math.random().toString(36).slice(2, 7)}` });
  }

  markDeleted(r, full, origin) {
    const k = key(full);
    const rows = this.db.q("SELECT path_key,path,sha FROM files WHERE (path_key=? OR path_key LIKE ? ESCAPE '!') AND size!=-1").all(k, k.replace(/[!%_]/g, '!$&') + '\\%');
    for (const row of rows) {
      this.db.q('UPDATE files SET size=-1, seen_utc=? WHERE path_key=?').run(nowIso(), row.path_key);
      if (row.sha) this.recentDeletes.set(row.sha, { path: row.path, t: Date.now() });
      const vr = this.db.q('INSERT INTO versions(path,root_id,utc,sha,prior_id,status,origin) VALUES(?,?,?,?,(SELECT version_id FROM files WHERE path_key=?),?,?)').run(row.path, r.id, nowIso(), null, row.path_key, 'deleted', origin);
      this.recordEvent(r, row.path, 'deleted', origin, {}, Number(vr.lastInsertRowid));
    }
  }

  eligible(r, full, size) {
    const rel = path.relative(r.path, full);
    if (excludedDirSegment(this.cfg, rel)) return 'excluded_path';
    if (sensitiveName(this.cfg, path.basename(full))) return 'excluded_sensitive';
    if (!r.snapshots) return 'snapshots_off';
    if (!this.cfg._eligibleExt.has(path.extname(full).toLowerCase())) return 'not_text_allowlisted';
    if (size > this.cfg.snapshots.max_file_bytes) return 'excluded_size';
    return null;
  }

  // Capture a version. Returns { version_id, sha } | { unchanged:true } | null (ineligible, no version).
  async capture(r, full, st, row, origin, baseline = false) {
    const pk = key(full);
    const upd = (sha, vid) => this.db.q(`INSERT INTO files(path_key,path,root_id,size,mtime,sha,version_id,seen_utc) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(path_key) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, sha=COALESCE(excluded.sha, files.sha), version_id=COALESCE(excluded.version_id, files.version_id), seen_utc=excluded.seen_utc`)
      .run(pk, full, r.id, st.size, st.mtimeMs, sha, vid, nowIso());
    const why = this.eligible(r, full, st.size);
    const metaVersion = (status, reason) => {
      if (baseline) { upd(null, null); return null; }
      const v = this.db.q('INSERT INTO versions(path,root_id,utc,status,size,reason,origin,prior_id) VALUES(?,?,?,?,?,?,?,?)').run(full, r.id, nowIso(), status, st.size, reason, origin, row ? row.version_id : null);
      const vid = Number(v.lastInsertRowid); upd(null, null); return { version_id: vid };
    };
    if (why === 'excluded_path' || why === 'not_text_allowlisted' || why === 'snapshots_off') { upd(null, null); return null; }
    if (why) return metaVersion(why, why === 'excluded_sensitive' ? 'sensitive file name; content never read' : `file ${st.size} B > ${this.cfg.snapshots.max_file_bytes} B`);
    let buf;
    try { buf = await fsp.readFile(full); } catch (e) { return metaVersion('unreadable', e.code || e.message); }
    if (buf.subarray(0, 8000).includes(0)) return metaVersion('excluded_binary', 'binary content');
    const sha = store.sha256(buf);
    if (row && row.sha === sha) { upd(sha, null); return { unchanged: true }; }
    const secret = store.findSecret(buf.toString('utf8'));
    if (secret) return metaVersion('excluded_sensitive', 'credential-like content detected; content not stored');

    let prior = row ? row.version_id : null;
    if (!prior && !baseline) prior = await this.gitHeadPrior(r, full, row);
    if (this.db.meta('capture_paused_quota')) return metaVersion('excluded_quota', 'snapshot store full; capture paused');
    const put = store.putBlob(this.db, this.cfg, buf);
    if (put.error) return metaVersion(put.error, put.detail);
    const v = this.db.q('INSERT INTO versions(path,root_id,utc,sha,prior_id,blob_sha,status,size,origin) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(full, r.id, nowIso(), sha, prior, sha, baseline ? 'baseline' : 'captured', buf.length, origin);
    const vid = Number(v.lastInsertRowid);
    upd(sha, vid);
    return { version_id: vid, sha, stored: put.size_stored };
  }

  // First observed edit of a tracked file that Git last saw as clean: its "before" is exactly HEAD's copy.
  async gitHeadPrior(r, full, row) {
    const wt = this.gitw.worktreeFor(full);
    if (!wt) return null;
    if (row && row.git_blob) { // exact content Git had for this file when watching began
      try {
        const buf = await this.gitw.blobContent(wt, row.git_blob);
        if (!buf.subarray(0, 8000).includes(0) && !store.findSecret(buf.toString('utf8'))) {
          const put = store.putBlob(this.db, this.cfg, buf);
          if (!put.error) {
            const v = this.db.q('INSERT INTO versions(path,root_id,utc,sha,blob_sha,status,size,origin,reason) VALUES(?,?,?,?,?,?,?,?,?)')
              .run(full, r.id, row.seen_utc || nowIso(), put.sha, put.sha, 'baseline_git_head', buf.length, 'git', 'content Git had recorded for this file when watching began');
            return Number(v.lastInsertRowid);
          }
        }
      } catch {}
    }
    const w = this.db.q('SELECT path,status_json,last_ok_utc FROM worktrees WHERE id=?').get(wt.id);
    const rel = path.relative(w.path, full).replace(/\\/g, '/');
    const map = JSON.parse(w.status_json || '{}').map || {};
    if (map[rel]) return null; // already dirty/untracked at last scan: HEAD is not the true before-state
    let buf;
    try { buf = await this.gitw.headContent(w, rel); } catch { return null; } // not tracked
    if (buf.subarray(0, 8000).includes(0) || store.findSecret(buf.toString('utf8'))) return null;
    const put = store.putBlob(this.db, this.cfg, buf);
    if (put.error) return null;
    const v = this.db.q('INSERT INTO versions(path,root_id,utc,sha,blob_sha,status,size,origin,reason) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(full, r.id, w.last_ok_utc || nowIso(), put.sha, put.sha, 'baseline_git_head', buf.length, 'git', 'committed HEAD copy; file was clean at last Git scan');
    return Number(v.lastInsertRowid);
  }

  // Async recursive walk used for baseline and reconciliation.
  async walk(r, dir, origin, baseline = false, budget = { left: BASELINE_BUDGET }) {
    const stack = [dir]; let n = 0;
    while (stack.length) {
      const d = stack.pop();
      let h; try { h = await fsp.opendir(d); } catch { continue; }
      for await (const e of h) {
        const full = path.join(d, e.name);
        const rel = path.relative(r.path, full);
        if (e.isDirectory()) { if (!excludedDirSegment(this.cfg, rel + path.sep + 'x')) stack.push(full); continue; }
        if (!e.isFile()) continue;
        n++;
        if (n % 500 === 0) await new Promise((res) => setImmediate(res));
        if (baseline) await this.baselineFile(r, full, budget);
        else await this.settleQuiet(r, full, origin);
      }
    }
    return n;
  }
  async settleQuiet(r, full, origin) {
    const row = this.db.q('SELECT size,mtime FROM files WHERE path_key=?').get(key(full));
    let st; try { st = await fsp.stat(full); } catch { return; }
    if (row && row.size === st.size && Math.abs(row.mtime - st.mtimeMs) < 1) return;
    await this.settle(r, full, origin);
  }
  async baselineFile(r, full, budget) {
    let st; try { st = await fsp.stat(full); } catch { return; }
    const wt = this.gitw.worktreeFor(full);
    let needContent = true, gitBlob = null;
    if (wt) { // clean tracked files: remember Git's blob id now (exact before-state); capture only dirty/untracked content
      const w = this.db.q('SELECT id,path,status_json FROM worktrees WHERE id=?').get(wt.id);
      const map = JSON.parse(w.status_json || '{}').map || {};
      const rel = path.relative(w.path, full).replace(/\\/g, '/');
      needContent = !!map[rel];
      if (!needContent) {
        if (!this.lsCache.has(w.id)) this.lsCache.set(w.id, await this.gitw.indexBlobs(w).catch(() => new Map()));
        gitBlob = this.lsCache.get(w.id).get(rel) || null;
        if (!gitBlob) needContent = true; // e.g. ignored file: not in Git, capture like non-Git content
      }
    }
    if (needContent && budget.left > 0) {
      const c = await this.capture(r, full, st, null, 'baseline', true);
      if (c && c.stored) budget.left -= c.stored;
    } else {
      this.db.q(`INSERT INTO files(path_key,path,root_id,size,mtime,seen_utc,git_blob) VALUES(?,?,?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, git_blob=excluded.git_blob`)
        .run(key(full), full, r.id, st.size, st.mtimeMs, nowIso(), gitBlob);
    }
  }

  async baselineOrReconcileUnlocked() {
    for (const r of this.cfg.watch_roots) {
      if (!fs.existsSync(r.path)) continue;
      const mk = `fs_baseline:${key(r.path)}`;
      const t0 = Date.now();
      if (!this.db.meta(mk)) {
        const n = await this.walk(r, r.path, 'baseline', true);
        this.db.meta(mk, nowIso());
        addEvent(this.db, { utc: nowIso(), root_id: r.id, source: 'fs', kind: 'baseline_established', path: r.path, detail: { files: n, ms: Date.now() - t0 }, evidence: 'fs_observed', dedupe: `fsbase:${r.id}:${mk}` });
        log('INFO', `fs baseline ${r.path}: ${n} files in ${Date.now() - t0} ms`);
        this.baselining.delete(r.id);
        await this._reconcile([r]); // catch edits made while the inventory was running
      } else {
        await this._reconcile([r]);
      }
    }
  }

  async reconcile(roots = this.cfg.watch_roots) {
    if (this.reconciling) return; this.reconciling = true;
    try { await this._reconcile(roots); } finally { this.reconciling = false; }
  }
  async _reconcile(roots) {
    {
      for (const r of roots) {
        if (!fs.existsSync(r.path)) { this.gap('fs', r, 'root_unavailable', 'skipped reconciliation; no deletions inferred'); continue; }
        const t0 = Date.now();
        const seen = new Set();
        const stack = [r.path];
        while (stack.length) {
          const d = stack.pop();
          let h; try { h = await fsp.opendir(d); } catch { continue; }
          for await (const e of h) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { if (!excludedDirSegment(this.cfg, path.relative(r.path, full) + path.sep + 'x')) stack.push(full); continue; }
            if (!e.isFile()) continue;
            seen.add(key(full));
            if (seen.size % 500 === 0) await new Promise((res) => setImmediate(res));
            await this.settleQuiet(r, full, 'reconcile');
          }
        }
        // Files we knew about that are gone (root itself present, so this is a real absence).
        for (const row of this.db.q('SELECT path_key,path FROM files WHERE root_id=? AND size!=-1').all(r.id)) {
          if (!seen.has(row.path_key) && !fs.existsSync(row.path)) this.markDeleted(r, row.path, 'reconcile');
        }
        log('INFO', `reconciled ${r.path}: ${seen.size} files in ${Date.now() - t0} ms`);
      }
      this.lastReconcile = nowIso();
      this.db.meta('last_reconcile_utc', this.lastReconcile);
    }
  }
}

module.exports = { FsWatch };
