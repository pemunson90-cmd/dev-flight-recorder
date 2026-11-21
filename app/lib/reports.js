'use strict';
// Deterministic reports over stored evidence. Hourly windows are materialized; other ranges are live queries.
const fs = require('fs');
const path = require('path');
const { nowIso, isInside, category, log } = require('./util');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function projectLabel(db, cfg) {
  const wts = db.q('SELECT id,path,root_id,repo_name,common_dir FROM worktrees').all();
  return {
    wts,
    forPath(p) {
      let best = null; for (const w of wts) if (isInside(p, w.path) && (!best || w.path.length > best.path.length)) best = w;
      return best;
    },
    rootName(id) { const r = cfg.watch_roots.find((x) => x.id === id); return r ? path.basename(r.path) : 'unknown root'; },
  };
}

function build(db, cfg, fromUtc, toUtc) {
  const L = projectLabel(db, cfg);
  const totalMin = Math.max(1, Math.round((Date.parse(toUtc) - Date.parse(fromUtc)) / 60000));
  const obsMin = db.q('SELECT COUNT(*) n FROM heartbeats WHERE minute >= ? AND minute < ?').get(fromUtc.slice(0, 16), toUtc.slice(0, 16)).n;
  const ratio = obsMin / totalMin;
  const coverage = { minutes_observed: obsMin, minutes_total: totalMin, status: ratio >= 0.95 ? 'complete' : ratio > 0 ? 'degraded' : 'unavailable' };
  const events = db.q("SELECT * FROM events WHERE utc >= ? AND utc < ? AND kind NOT IN ('baseline_established','seen_during_first_pass','ignored_folder_noise') ORDER BY utc").all(fromUtc, toUtc);
  const projects = new Map();
  const proj = (e) => {
    const w = e.worktree_id ? L.wts.find((x) => x.id === e.worktree_id) : (e.path ? L.forPath(e.path) : null);
    const k = w ? `repo:${w.common_dir}` : `root:${e.root_id}`;
    if (!projects.has(k)) projects.set(k, { key: k, name: w ? w.repo_name : `${L.rootName(e.root_id)} (outside Git)`, worktrees: new Set(), commits: [], branch_events: [], paths: new Map(), git_state_changes: 0, snapshots: 0, sessions: [] });
    const p = projects.get(k); if (w) p.worktrees.add(w.path); return p;
  };
  for (const e of events) {
    const p = proj(e);
    const d = e.detail_json ? JSON.parse(e.detail_json) : {};
    if (e.kind === 'commit_observed') p.commits.push({ sha: e.after_ref, worktree_id: e.worktree_id, subject: d.subject, author: d.author, author_utc: d.author_utc, files: d.files, added: d.added, deleted: d.deleted, branch: d.branch, observed_utc: e.utc });
    else if (['branch_switch', 'detached_head', 'attached_head', 'head_moved', 'head_rewritten'].includes(e.kind)) p.branch_events.push({ kind: e.kind, from: e.before_ref, to: e.after_ref, utc: e.utc, worktree_id: e.worktree_id });
    else if (e.kind === 'worktree_state') p.git_state_changes++;
    else if (e.source.startsWith('fs')) {
      const cur = p.paths.get(e.path) || { path: e.path, kinds: new Set(), category: category(e.path), versions: [], after_restart: false };
      cur.kinds.add(e.kind); if (e.version_id) cur.versions.push(e.version_id); if (e.source === 'fs_reconcile') cur.after_restart = true;
      p.paths.set(e.path, cur);
    }
  }
  const caps = db.q("SELECT path FROM versions WHERE utc >= ? AND utc < ? AND status='captured'").all(fromUtc, toUtc);
  for (const c of caps) { const w = L.forPath(c.path); const k = w ? `repo:${w.common_dir}` : null; if (k && projects.has(k)) projects.get(k).snapshots++; }

  // Sessions (hour buckets) overlapping the window.
  const hFrom = fromUtc.slice(0, 13) + ':00:00Z';
  const srows = db.q(`SELECT h.skey, SUM(h.tools) tools, SUM(h.edits) edits, SUM(h.messages) messages, s.provider, s.cwd, s.model, s.state
    FROM session_hours h JOIN sessions s ON s.skey=h.skey WHERE h.hour_utc >= ? AND h.hour_utc < ? GROUP BY h.skey`).all(hFrom, toUtc);
  const sessions = srows.map((s) => {
    const w = s.cwd ? L.forPath(s.cwd) : null;
    const k = w ? `repo:${w.common_dir}` : null;
    if (k && projects.has(k)) projects.get(k).sessions.push(s.skey);
    return { skey: s.skey, provider: s.provider, workspace: s.cwd, project: w ? w.repo_name : 'not a watched project', model: s.model, tools: s.tools, edits: s.edits, messages: s.messages, state: (s.state || '').split('|')[1] || 'unknown' };
  });
  const gaps = db.q('SELECT source,start_utc,end_utc,reason,detail FROM gaps WHERE start_utc >= ? AND start_utc < ? ORDER BY start_utc LIMIT 200').all(fromUtc, toUtc);

  const plist = [...projects.values()].map((p) => {
    const paths = [...p.paths.values()].map((x) => ({ ...x, kinds: [...x.kinds] }));
    const cats = {}; for (const x of paths) cats[x.category] = (cats[x.category] || 0) + 1;
    return { name: p.name, worktrees: [...p.worktrees], commits: p.commits, branch_events: p.branch_events, git_state_changes: p.git_state_changes, snapshots_captured: p.snapshots,
      edited: paths.filter((x) => x.kinds.includes('modified') && !x.kinds.includes('created')).length,
      created: paths.filter((x) => x.kinds.includes('created')).length,
      deleted: paths.filter((x) => x.kinds.includes('deleted') && !x.kinds.includes('created')).length,
      renamed: paths.filter((x) => x.kinds.includes('renamed')).length,
      categories: cats, paths: paths.slice(0, 400), paths_truncated: paths.length > 400 ? paths.length : 0, sessions: p.sessions,
      correlation: p.sessions.length && (paths.length || p.commits.length) ? 'possibly associated: agent session(s) active in this workspace during the same hour(s); authorship not verified' : null };
  }).sort((a, b) => (b.commits.length + b.edited + b.created) - (a.commits.length + a.edited + a.created));

  const T = (f) => plist.reduce((n, p) => n + f(p), 0);
  const totals = {
    commits: T((p) => p.commits.length), files_edited: T((p) => p.edited), files_created: T((p) => p.created), files_deleted: T((p) => p.deleted), files_renamed: T((p) => p.renamed),
    branch_or_head_transitions: T((p) => p.branch_events.length), snapshots_captured: T((p) => p.snapshots_captured),
    reported_tool_calls: sessions.reduce((n, s) => n + s.tools, 0), reported_edits: sessions.reduce((n, s) => n + s.edits, 0), sessions_active: sessions.length,
  };
  const rep = { from_utc: fromUtc, to_utc: toUtc, generated_utc: nowIso(), coverage, totals, projects: plist, sessions, gaps, narrative: narrative(coverage, totals, plist, sessions) };
  return rep;
}

function narrative(cov, t, plist, sessions) {
  if (cov.status === 'unavailable') return 'Unknown: the recorder was not running for this window, so no activity can be reported.';
  const parts = [];
  const active = plist.filter((p) => p.commits.length || p.edited || p.created || p.deleted);
  if (!active.length && !t.commits) parts.push('No commits or file changes were observed in watched projects.');
  else {
    parts.push(`${t.commits} commit(s) observed${t.commits ? ' (' + plist.filter((p) => p.commits.length).map((p) => `${p.name}: ${p.commits.length}`).join(', ') + ')' : ''}.`);
    const byCat = {}; for (const p of plist) for (const [c, n] of Object.entries(p.categories)) byCat[c] = (byCat[c] || 0) + n;
    parts.push(`${t.files_edited} file(s) edited, ${t.files_created} created, ${t.files_deleted} deleted across ${active.length} project(s)` + (Object.keys(byCat).length ? ` (by path type: ${Object.entries(byCat).map(([c, n]) => `${n} ${c}`).join(', ')}).` : '.'));
  }
  if (t.branch_or_head_transitions) parts.push(`${t.branch_or_head_transitions} branch/HEAD transition(s).`);
  const byProv = {}; for (const s of sessions) byProv[s.provider] = (byProv[s.provider] || 0) + 1;
  parts.push(sessions.length ? `Agent sessions with recorded activity: ${Object.entries(byProv).map(([p, n]) => `${n} ${p}`).join(', ')}; they reported ${t.reported_tool_calls} tool call(s) and ${t.reported_edits} edit(s).` : 'No agent session activity was recorded.');
  parts.push('No process-to-change authorship was verified.');
  if (cov.status === 'degraded') parts.push(`Coverage incomplete: recorder observed ${cov.minutes_observed} of ${cov.minutes_total} minutes; counts may be low.`);
  return parts.join(' ');
}

// Materialize every closed hour since the recorder first ran.
function materialize(db, cfg) {
  const first = db.q('SELECT MIN(minute) m FROM heartbeats').get().m;
  if (!first) return 0;
  const hour = 3600000;
  let t = Math.floor(Date.parse(first + ':00Z') / hour) * hour;
  const end = Math.floor(Date.now() / hour) * hour;
  let n = 0;
  for (; t < end; t += hour) {
    const f = new Date(t).toISOString(), to = new Date(t + hour).toISOString();
    if (db.q('SELECT 1 FROM reports WHERE from_utc=? AND to_utc=?').get(f, to)) continue;
    const r = build(db, cfg, f, to);
    db.q('INSERT OR IGNORE INTO reports(from_utc,to_utc,generated_utc,json) VALUES(?,?,?,?)').run(f, to, r.generated_utc, JSON.stringify(r));
    n++;
  }
  if (n) log('INFO', `materialized ${n} hourly report(s)`);
  return n;
}

function toMarkdown(r, tz) {
  const fmt = (u) => new Date(u).toLocaleString('en-US', { timeZone: tz });
  const L = [`# Development Flight Recorder report`, ``, `Window: ${fmt(r.from_utc)} – ${fmt(r.to_utc)} (${tz})  `, `Coverage: ${r.coverage.status} (${r.coverage.minutes_observed}/${r.coverage.minutes_total} min observed)  `, `Generated: ${fmt(r.generated_utc)}`, ``, r.narrative, ``, `## Totals`, ''];
  for (const [k, v] of Object.entries(r.totals)) L.push(`- ${k.replace(/_/g, ' ')}: ${v}`);
  for (const p of r.projects) {
    L.push('', `## ${p.name}`, `Edited ${p.edited}, created ${p.created}, deleted ${p.deleted}, Git state changes ${p.git_state_changes}, snapshots ${p.snapshots_captured}`);
    if (p.correlation) L.push(`_${p.correlation}_`);
    for (const c of p.commits) L.push(`- commit \`${c.sha.slice(0, 10)}\` ${c.subject} (${c.files} files, +${c.added}/-${c.deleted})`);
    for (const b of p.branch_events) L.push(`- ${b.kind}: ${b.from || '?'} → ${b.to || '?'}`);
    for (const x of p.paths.slice(0, 100)) L.push(`- ${x.kinds.join('/')} \`${x.path}\` [${x.category}]${x.after_restart ? ' (seen at reconciliation)' : ''}`);
  }
  if (r.sessions.length) { L.push('', '## Agent sessions (reported activity)'); for (const s of r.sessions) L.push(`- ${s.provider} ${s.skey.split(':')[1].slice(0, 8)} in ${s.project}: ${s.tools} tool calls, ${s.edits} edits, state ${s.state}`); }
  if (r.gaps.length) { L.push('', '## Monitoring gaps'); for (const g of r.gaps) L.push(`- ${g.start_utc} ${g.source} ${g.reason}: ${g.detail}`); }
  return L.join('\n') + '\n';
}
function toHtml(r, tz) {
  const md = toMarkdown(r, tz);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Flight Recorder report</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:16px auto;padding:0 16px;background:#fff;color:#111}pre{white-space:pre-wrap}</style><pre>${esc(md)}</pre>`;
}
function exportReport(cfg, r, fmt) {
  const dir = path.join(cfg.data_dir, 'exports'); fs.mkdirSync(dir, { recursive: true });
  const base = `report_${r.from_utc.replace(/[:]/g, '').slice(0, 15)}_${r.to_utc.replace(/[:]/g, '').slice(0, 15)}`;
  const body = fmt === 'md' ? toMarkdown(r, cfg.timezone) : fmt === 'html' ? toHtml(r, cfg.timezone) : JSON.stringify(r, null, 2);
  const file = path.join(dir, `${base}.${fmt}`); fs.writeFileSync(file, body);
  return { file, body };
}

module.exports = { build, materialize, exportReport, toMarkdown, esc };
