'use strict';
// Two loopback HTTP surfaces from one process:
//  - admin  (127.0.0.1:admin_port): report UI + config/log views. Still read-only: no mutating routes exist.
//  - remote (127.0.0.1:remote_port): the ONLY port Tailscale Serve forwards. GET/HEAD only, ID-based lookups,
//    redacted + bounded output, no config/log/transcript content.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { APP_DIR, CONFIG_PATH, recentErrors, nowIso } = require('./util');
const store = require('./store');
const reports = require('./reports');

const MAX_DIFF = 512 * 1024;
const PUB = path.join(APP_DIR, 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'] };

function makeServer(ctx, surface) {
  const { db, cfg } = ctx;
  const port = surface === 'admin' ? cfg.local_admin.port : cfg.remote_report.port;
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(surface === 'remote' ? cfg.remote_report.allowed_hosts.flatMap((h) => [h, `${h}:443`]) : [])]);

  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(code, {
      'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin', ...extra,
    });
    res.end(res.req.method === 'HEAD' ? undefined : buf);
  };

  const routes = [
    ['/api/overview', overview],
    ['/api/projects', () => projects(ctx)],
    [/^\/api\/timeline$/, timeline],
    [/^\/api\/version\/(\d+)$/, (q, m) => version(ctx, +m[1], surface)],
    [/^\/api\/commit\/(\d+)\/([0-9a-f]{40})$/, async (q, m) => { const t = await ctx.gitw.commitDiff(+m[1], m[2]); return t == null ? null : { text: bound(store.redact(t)) }; }],
    [/^\/api\/workdiff\/(\d+)$/, async (q, m) => { const t = await ctx.gitw.workingDiff(+m[1], String(q.get('path') || ''), q.get('staged') === '1'); return t == null ? null : { text: bound(store.redact(t)) }; }],
    ['/api/sessions', () => sessions(ctx)],
    ['/api/reports', () => db.q('SELECT id,from_utc,to_utc,generated_utc FROM reports ORDER BY from_utc DESC LIMIT 500').all()],
    [/^\/api\/report\/(\d+)$/, (q, m) => { const r = db.q('SELECT json FROM reports WHERE id=?').get(+m[1]); return r ? JSON.parse(r.json) : null; }],
    ['/api/range', (q) => { const w = win(q); return w ? reports.build(db, cfg, w.from, w.to) : null; }],
    ['/api/export', exportRoute],
    ['/api/health', () => ctx.health()],
  ];
  if (surface === 'admin') {
    routes.push(['/api/admin/config', () => ({ path: CONFIG_PATH, config: JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) })]);
    routes.push(['/api/admin/log', () => ({ recent_warnings: recentErrors.slice(-100) })]);
  }

  function win(q) {
    let to = q.get('to') ? Date.parse(q.get('to')) : Date.now();
    let from = q.get('from') ? Date.parse(q.get('from')) : to - (Number(q.get('minutes')) || 60) * 60000;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 93 * 86400000) return null;
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  function overview(q) {
    const w = win(q); if (!w) return null;
    const rep = reports.build(db, cfg, w.from, w.to);
    return { now: nowIso(), window: w, report: rep, projects: projects(ctx), health: ctx.health() };
  }
  function timeline(q) {
    const w = win(q); if (!w) return null;
    const wt = Number(q.get('wt')) || null;
    const rows = wt
      ? db.q('SELECT id,utc,worktree_id,root_id,source,kind,path,before_ref,after_ref,detail_json,evidence,version_id FROM events WHERE worktree_id=? AND utc>=? AND utc<? ORDER BY utc DESC LIMIT 1500').all(wt, w.from, w.to)
      : db.q("SELECT id,utc,worktree_id,root_id,source,kind,path,before_ref,after_ref,detail_json,evidence,version_id FROM events WHERE utc>=? AND utc<? AND kind NOT IN ('baseline_established','seen_during_first_pass','ignored_folder_noise') ORDER BY utc DESC LIMIT 1500").all(w.from, w.to);
    return rows.map((r) => ({ ...r, detail: r.detail_json ? JSON.parse(r.detail_json) : null, detail_json: undefined }));
  }
  function exportRoute(q) {
    const w = win(q); const fmt = ['md', 'json', 'html'].includes(q.get('fmt')) ? q.get('fmt') : 'md';
    if (!w) return null;
    const { body } = reports.exportReport(cfg, reports.build(db, cfg, w.from, w.to), fmt);
    return { __raw: true, body, type: fmt === 'json' ? 'application/json; charset=utf-8' : fmt === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8', name: `flight-report.${fmt}` };
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!okHosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'host not allowed' });
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'read-only' }, undefined, { Allow: 'GET, HEAD' });
      const fetchSite = req.headers['sec-fetch-site'];
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith('/api/') && fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return send(res, 403, { error: 'cross-site request refused' });
      if (STATIC[u.pathname]) {
        const [f, type] = STATIC[u.pathname];
        let body = fs.readFileSync(path.join(PUB, f));
        if (f === 'index.html') body = Buffer.from(body.toString('utf8').replace('__SURFACE__', surface).replace('__TZ__', cfg.timezone));
        return send(res, 200, body, type);
      }
      for (const [pat, fn] of routes) {
        const m = typeof pat === 'string' ? (u.pathname === pat ? [pat] : null) : u.pathname.match(pat);
        if (!m) continue;
        const out = await fn(u.searchParams, m);
        if (out == null) return send(res, 404, { error: 'not found' });
        if (out.__raw) return send(res, 200, out.body, out.type, { 'Content-Disposition': `attachment; filename="${out.name}"` });
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { send(res, 500, { error: 'internal error' }); ctx.logErr(e); }
  });
  server.listen(port, '127.0.0.1');
  server.on('error', (e) => {
    ctx.logErr(e);
    // A second copy must never run against the same store: if our port is taken, exit.
    if (e.code === 'EADDRINUSE') process.exit(4);
  });
  return server;
}

const bound = (t) => (t.length > MAX_DIFF ? t.slice(0, MAX_DIFF) + `\n\n[output cut at ${MAX_DIFF} bytes; full diff not shown]` : t);

function projects(ctx) {
  const rows = ctx.db.q('SELECT id,path,root_id,repo_name,common_dir,branch,head,upstream,ahead,behind,status_json,last_ok_utc,last_scan_utc,state,error FROM worktrees ORDER BY repo_name, path').all();
  const out = new Map();
  for (const r of rows) {
    const map = r.status_json ? JSON.parse(r.status_json).map || {} : {};
    const vals = Object.entries(map);
    const last = ctx.db.q('SELECT MAX(utc) t FROM events WHERE worktree_id=? AND kind NOT IN (\'baseline_established\',\'seen_during_first_pass\',\'ignored_folder_noise\')').get(r.id).t;
    const lastCommit = ctx.db.q('SELECT sha,subject,author_utc FROM commits WHERE worktree_id=? ORDER BY observed_utc DESC LIMIT 1').get(r.id);
    const wt = { id: r.id, path: r.path, branch: r.branch, detached: !r.branch && !!r.head, head: r.head, upstream: r.upstream, ahead: r.ahead, behind: r.behind,
      staged: vals.filter(([, s]) => s.staged).length, unstaged: vals.filter(([, s]) => s.unstaged).length, untracked: vals.filter(([, s]) => s.untracked).length,
      changed: vals.slice(0, 300).map(([p, s]) => ({ path: p, ...s })), last_change_utc: last, last_ok_utc: r.last_ok_utc, state: r.state, error: r.error, last_commit: lastCommit || null };
    const k = r.common_dir;
    if (!out.has(k)) out.set(k, { key: k, name: r.repo_name, worktrees: [] });
    out.get(k).worktrees.push(wt);
  }
  const act = ctx.db.q("SELECT cwd, provider, state, last_utc FROM sessions WHERE last_utc > ?").all(new Date(Date.now() - 6 * 3600000).toISOString());
  for (const p of out.values()) {
    p.sessions = act.filter((s) => s.cwd && p.worktrees.some((w) => require('./util').isInside(s.cwd, w.path))).map((s) => ({ provider: s.provider, state: (s.state || '').split('|')[1], last_utc: s.last_utc }));
    p.last_change_utc = p.worktrees.map((w) => w.last_change_utc).filter(Boolean).sort().pop() || null;
  }
  return [...out.values()];
}

function version(ctx, id, surface) {
  const v = ctx.db.q('SELECT * FROM versions WHERE id=?').get(id);
  if (!v) return null;
  const chain = ctx.db.q('SELECT id,utc,status,size,reason,origin,sha FROM versions WHERE path=? ORDER BY utc DESC, id DESC LIMIT 200').all(v.path);
  const prior = v.prior_id ? ctx.db.q('SELECT * FROM versions WHERE id=?').get(v.prior_id) : null;
  const out = { version: { ...v, blob_sha: undefined }, prior: prior ? { id: prior.id, utc: prior.utc, status: prior.status, origin: prior.origin } : null, chain };
  const readable = (x) => x && x.blob_sha && ['captured', 'baseline', 'baseline_git_head'].includes(x.status);
  if (readable(v)) {
    const cur = ctx.store.getBlob(ctx.db, v.blob_sha);
    const before = readable(prior) ? ctx.store.getBlob(ctx.db, prior.blob_sha) : null;
    if (cur) {
      const d = store.lineDiff(before ? before.toString('utf8') : '', cur.toString('utf8'));
      out.diff = { against: before ? `version ${prior.id}` : 'nothing (no earlier captured content; whole file shown as added)', added: d.added, removed: d.removed, text: bound(store.redact(d.text)), truncated: d.truncated };
    } else out.diff = { unavailable: 'content no longer in store (retired by retention)' };
  } else out.diff = { unavailable: `metadata only: ${v.status}${v.reason ? ' — ' + v.reason : ''}` };
  if (surface === 'remote') out.version.path_display = v.path;
  return out;
}

function sessions(ctx) {
  return ctx.db.q('SELECT skey,provider,session_id,cwd,branch,first_utc,last_utc,model,state,tools_json,edits_json,tokens_json,token_kind,subagents,originator,parse_errors FROM sessions ORDER BY last_utc DESC LIMIT 300').all()
    .map((s) => {
      const tools = JSON.parse(s.tools_json || '{}'); const edits = JSON.parse(s.edits_json || '[]');
      return { skey: s.skey, provider: s.provider, session_id: s.session_id, workspace: s.cwd, branch: s.branch, first_utc: s.first_utc, last_utc: s.last_utc, model: s.model,
        state: (s.state || '').split('|')[1] || 'unknown', tool_calls: Object.values(tools).reduce((a, b) => a + b, 0), tools, edits: edits.slice(-50), edit_count: edits.length,
        tokens: JSON.parse(s.tokens_json || '{}'), token_kind: s.token_kind, subagents: s.subagents, originator: s.originator, parse_errors: s.parse_errors };
    });
}

module.exports = { makeServer };
