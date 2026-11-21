'use strict';
// Git collector: discovers repos + linked worktrees inside configured roots and samples them read-only.
const fs = require('fs');
const path = require('path');
const { git, log, nowIso, normPath, key, isInside } = require('./util');
const { addEvent } = require('./db');

// --- porcelain v2 -z parser ---
function parseStatus(buf) {
  const parts = buf.toString('utf8').split('\0');
  const st = { oid: null, head: null, upstream: null, ahead: null, behind: null, entries: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [, k, ...rest] = p.split(' ');
      const v = rest.join(' ');
      if (k === 'branch.oid') st.oid = v === '(initial)' ? null : v;
      else if (k === 'branch.head') st.head = v;
      else if (k === 'branch.upstream') st.upstream = v;
      else if (k === 'branch.ab') { const m = v.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
      continue;
    }
    const t = p[0];
    if (t === '1') { const f = p.split(' '); st.entries.push({ xy: f[1], path: f.slice(8).join(' ') }); }
    else if (t === '2') { const f = p.split(' '); st.entries.push({ xy: f[1], path: f.slice(9).join(' '), orig: parts[++i], rename: f[8] }); }
    else if (t === 'u') { const f = p.split(' '); st.entries.push({ xy: f[1], path: f.slice(10).join(' '), conflict: true }); }
    else if (t === '?') st.entries.push({ xy: '??', path: p.slice(2) });
  }
  return st;
}
function classify(e) {
  if (e.xy === '??') return { untracked: true };
  const X = e.xy[0], Y = e.xy[1];
  return { staged: X !== '.' ? X : null, unstaged: Y !== '.' ? Y : null };
}

class GitWatch {
  constructor(db, cfg) {
    this.db = db; this.cfg = cfg;
    this.pending = new Set(); this.running = new Set();
    this.outsideWorktrees = [];
  }

  // Find .git dirs/files within roots; expand to every worktree git knows about, keep those inside roots.
  async discover() {
    const found = new Map();
    for (const root of this.cfg.watch_roots) {
      if (!fs.existsSync(root.path)) { log('WARN', `root unavailable: ${root.path}`); continue; }
      const depth = root.kind === 'discovery' ? (root.scan_depth || 3) : 0;
      const cands = [];
      const walk = (dir, d) => {
        if (fs.existsSync(path.join(dir, '.git'))) cands.push(dir);
        if (d >= depth) return;
        let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of es) {
          if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
          if (this.cfg.exclude_dir_prefixes.some((p) => e.name.toLowerCase().startsWith(p.toLowerCase()))) continue;
          walk(path.join(dir, e.name), d + 1);
        }
      };
      walk(root.path, 0);
      for (const c of cands) {
        try {
          const top = normPath((await git(c, ['rev-parse', '--show-toplevel'])).toString().trim());
          const common = normPath(path.resolve(top, (await git(c, ['rev-parse', '--git-common-dir'])).toString().trim()));
          const wl = (await git(c, ['worktree', 'list', '--porcelain', '-z'])).toString().split('\0');
          for (const line of wl) {
            if (!line.startsWith('worktree ')) continue;
            const wp = normPath(line.slice(9));
            const inRoot = this.cfg.watch_roots.find((r) => isInside(wp, r.path));
            const excluded = wp.split('\\').some((s) => this.cfg.exclude_dir_prefixes.some((p) => s.toLowerCase().startsWith(p.toLowerCase())));
            if (inRoot && !excluded && fs.existsSync(wp)) found.set(key(wp), { path: wp, root_id: inRoot.id, common });
            else if (!inRoot) this.outsideWorktrees.push(wp);
          }
          if (!found.has(key(top))) { const r = this.cfg.watch_roots.find((x) => isInside(top, x.path)); if (r) found.set(key(top), { path: top, root_id: r.id, common }); }
        } catch (e) { log('WARN', `discover ${c}: ${e.message}`); }
      }
    }
    this.outsideWorktrees = [...new Set(this.outsideWorktrees.map(key))];
    for (const w of found.values()) {
      const name = path.basename(w.common.toLowerCase().endsWith('\\.git') ? path.dirname(w.common) : w.common).replace(/\.git$/i, '');
      this.db.q(`INSERT INTO worktrees(path,root_id,common_dir,repo_name,first_seen_utc,state) VALUES(?,?,?,?,?,'new')
        ON CONFLICT(path) DO UPDATE SET root_id=excluded.root_id, common_dir=excluded.common_dir, repo_name=excluded.repo_name`).run(w.path, w.root_id, w.common, name, nowIso());
    }
    // Worktrees removed from disk are marked unavailable, never treated as mass deletion.
    for (const w of this.db.q('SELECT id,path FROM worktrees').all()) {
      if (!found.has(key(w.path))) this.db.q("UPDATE worktrees SET state='unavailable', error='not found at last discovery' WHERE id=?").run(w.id);
    }
    log('INFO', `git discovery: ${found.size} worktree(s) watched; ${this.outsideWorktrees.length} linked worktree(s) outside roots not watched`);
    return found.size;
  }

  worktreeFor(p) {
    let best = null;
    for (const w of this.db.q("SELECT id,path,root_id FROM worktrees WHERE state!='unavailable'").all()) {
      if (isInside(p, w.path) && (!best || w.path.length > best.path.length)) best = w;
    }
    return best;
  }

  request(id) { this.pending.add(id); }

  async tickAll() {
    const rows = this.db.q("SELECT id FROM worktrees WHERE state!='unavailable'").all();
    for (const r of rows) this.pending.add(r.id);
    await this.drain();
  }
  async drain() {
    const ids = [...this.pending]; this.pending.clear();
    await Promise.all(ids.map((id) => this.scan(id)));
  }

  async scan(id) {
    if (this.running.has(id)) { this.pending.add(id); return; }
    this.running.add(id);
    const wt = this.db.q('SELECT * FROM worktrees WHERE id=?').get(id);
    const now = nowIso();
    try {
      if (!fs.existsSync(wt.path)) throw new Error('path unavailable');
      const st = parseStatus(await git(wt.path, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']));
      const prev = wt.status_json ? JSON.parse(wt.status_json) : null;
      const branch = st.head === '(detached)' ? null : st.head;
      const map = Object.fromEntries(st.entries.map((e) => [e.path, { ...classify(e), orig: e.orig || null, conflict: !!e.conflict }]));
      this.db.tx(() => {
        if (!prev) {
          addEvent(this.db, { utc: now, worktree_id: id, root_id: wt.root_id, source: 'git', kind: 'baseline_established', after_ref: st.oid, detail: { branch, dirty: st.entries.length }, evidence: 'git_observed', dedupe: `base:${id}` });
        }
      });
      if (prev) await this.diffState(wt, prev, { ...st, branch, map }, now);
      this.db.q(`UPDATE worktrees SET branch=?, head=?, upstream=?, ahead=?, behind=?, status_json=?, last_scan_utc=?, last_ok_utc=?, state='ok', error=NULL WHERE id=?`)
        .run(branch, st.oid, st.upstream, st.ahead, st.behind, JSON.stringify({ oid: st.oid, branch, map }), now, now, id);
    } catch (e) {
      const state = /unavailable/.test(e.message) ? 'unavailable' : 'degraded';
      this.db.q('UPDATE worktrees SET last_scan_utc=?, state=?, error=? WHERE id=?').run(now, state, (e.stderrText || e.message).slice(0, 300), id);
      log('WARN', `git scan ${wt.path}: ${e.message}`);
    } finally { this.running.delete(id); }
  }

  async diffState(wt, prev, cur, now) {
    const id = wt.id;
    const ev = (o) => addEvent(this.db, { utc: now, worktree_id: id, root_id: wt.root_id, source: 'git', evidence: 'git_observed', ...o });
    if (prev.branch !== cur.branch) {
      ev({ kind: cur.branch ? (prev.branch ? 'branch_switch' : 'attached_head') : 'detached_head', before_ref: prev.branch, after_ref: cur.branch, detail: { from_head: prev.oid, to_head: cur.oid }, dedupe: `br:${id}:${now}` });
    }
    if (prev.oid !== cur.oid && cur.oid) {
      let ff = false;
      if (prev.oid) { try { await git(wt.path, ['merge-base', '--is-ancestor', prev.oid, cur.oid]); ff = true; } catch { ff = false; } }
      const range = ff ? `${prev.oid}..${cur.oid}` : cur.oid;
      const commits = await this.readCommits(wt, range, ff ? 200 : 1);
      for (const c of commits) {
        const known = this.db.q('SELECT 1 FROM commits WHERE worktree_id=? AND sha=?').get(id, c.sha);
        this.db.q(`INSERT OR IGNORE INTO commits(worktree_id,sha,observed_utc,author,author_utc,subject,files_json,added,deleted) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(id, c.sha, now, c.author, c.date, c.subject, JSON.stringify(c.files.slice(0, 500)), c.added, c.deleted);
        if (!known && ff) ev({ kind: 'commit_observed', after_ref: c.sha, detail: { subject: c.subject, author: c.author, author_utc: c.date, files: c.files.length, added: c.added, deleted: c.deleted, branch: cur.branch }, dedupe: `c:${id}:${c.sha}` });
      }
      if (!ff) ev({ kind: prev.branch === cur.branch ? 'head_rewritten' : 'head_moved', before_ref: prev.oid, after_ref: cur.oid, detail: { branch: cur.branch, note: 'HEAD moved without fast-forward (reset, rebase, checkout or amend)' }, dedupe: `hm:${id}:${prev.oid}:${cur.oid}:${now}` });
    }
    // Working-tree transitions by path.
    const all = new Set([...Object.keys(prev.map || {}), ...Object.keys(cur.map)]);
    for (const p of all) {
      const a = (prev.map || {})[p], b = cur.map[p];
      const sig = (s) => (s ? `${s.untracked ? 'U' : ''}${s.staged || '-'}${s.unstaged || '-'}` : 'clean');
      if (sig(a) === sig(b)) continue;
      const full = path.join(wt.path, p);
      ev({ kind: 'worktree_state', path: full, before_ref: sig(a), after_ref: sig(b), detail: { rel: p, from: a || null, to: b || null }, dedupe: `ws:${id}:${p}:${now}` });
    }
  }

  async readCommits(wt, range, limit) {
    const out = (await git(wt.path, ['log', '--no-ext-diff', '--no-textconv', '-M', '--numstat', `-n${limit}`, '--format=%x1e%H%x1f%an%x1f%aI%x1f%s', range])).toString('utf8');
    const res = [];
    for (const rec of out.split('\x1e').slice(1)) {
      const [head, ...lines] = rec.split('\n');
      const [sha, author, date, subject] = head.split('\x1f');
      const files = []; let added = 0, deleted = 0;
      for (const l of lines) {
        const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/); if (!m) continue;
        files.push({ path: m[3], added: m[1] === '-' ? null : +m[1], deleted: m[2] === '-' ? null : +m[2] });
        if (m[1] !== '-') added += +m[1]; if (m[2] !== '-') deleted += +m[2];
      }
      res.push({ sha, author, date, subject, files, added, deleted });
    }
    return res.reverse();
  }

  // On-demand bounded diffs (validated ids/paths only).
  async commitDiff(wtId, sha) {
    const wt = this.db.q('SELECT path FROM worktrees WHERE id=?').get(wtId);
    if (!wt || !/^[0-9a-f]{40}$/.test(sha)) return null;
    if (!this.db.q('SELECT 1 FROM commits WHERE worktree_id=? AND sha=?').get(wtId, sha)) return null;
    const buf = await git(wt.path, ['show', '--no-ext-diff', '--no-textconv', '--format=%H%n%an <%ae>%n%aI%n%n%B', '-M', '--stat', '-p', sha], { maxBuffer: 4 * 1024 * 1024 }).catch((e) => Buffer.from('(diff unavailable: ' + e.message + ')'));
    return buf.toString('utf8');
  }
  async workingDiff(wtId, rel, staged) {
    const wt = this.db.q('SELECT path,status_json FROM worktrees WHERE id=?').get(wtId);
    if (!wt) return null;
    const map = JSON.parse(wt.status_json || '{}').map || {};
    if (!map[rel]) return null; // only paths git currently reports as changed
    if (map[rel].untracked) return '(untracked file: Git has no prior version; see captured snapshots if any)';
    const args = ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', rel];
    return (await git(wt.path, args, { maxBuffer: 4 * 1024 * 1024 }).catch((e) => Buffer.from('(diff unavailable: ' + e.message + ')'))).toString('utf8');
  }
  // Index blob ids of tracked files (rel path -> git blob sha), read-only.
  async indexBlobs(wt) {
    const out = (await git(wt.path, ['ls-files', '-s', '-z'], { maxBuffer: 256 * 1024 * 1024 })).toString('utf8').split('\0');
    const m = new Map();
    for (const l of out) { const t = l.indexOf('\t'); if (t < 0) continue; const f = l.slice(0, t).split(' '); m.set(l.slice(t + 1), f[1]); }
    return m;
  }
  async blobContent(wt, sha) { return git(wt.path, ['cat-file', 'blob', sha], { maxBuffer: 2 * 1024 * 1024 }); }
  // HEAD copy of a tracked, clean file (used as the exact "before" of its first observed edit).
  async headContent(wt, rel) {
    return git(wt.path, ['show', `HEAD:${rel.replace(/\\/g, '/')}`], { maxBuffer: 2 * 1024 * 1024 });
  }
}

module.exports = { GitWatch, parseStatus };
