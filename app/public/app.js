'use strict';
(() => {
  const TZ = document.body.dataset.tz || 'America/New_York';
  const SURFACE = document.body.dataset.surface;
  const $view = document.getElementById('view');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (u) => (u ? new Date(u).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
  // Collapse repeats of the same gap (same source, reason, detail) into one line with a count and time span.
  const gapLines = (gs, withSource) => {
    const groups = [];
    for (const g of gs) {
      const last = groups[groups.length - 1];
      if (last && last.source === g.source && last.reason === g.reason && last.detail === g.detail) { last.n++; if (g.start_utc < last.lo) last.lo = g.start_utc; if (g.start_utc > last.hi) last.hi = g.start_utc; }
      else groups.push({ ...g, n: 1, lo: g.start_utc, hi: g.start_utc });
    }
    return groups.map((g) => {
      const when = fmt(g.lo) === fmt(g.hi) ? fmt(g.lo) : fmt(g.lo) + ' – ' + fmt(g.hi);
      return '<div class="small">' + when + ' ' + (withSource ? esc(g.source) + ' ' : '') + esc(g.reason) + (g.n > 1 ? ' ×' + g.n : '') + ': ' + esc(g.detail) + '</div>';
    }).join('');
  };
  const ago = (u) => { if (!u) return 'never'; const s = (Date.now() - Date.parse(u)) / 1000; if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`; if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`; };
  const short = (p) => { const parts = String(p || '').split(/[\\/]/); return parts.slice(-3).join('/'); };
  let timer = null, current = '', lastOk = null;
  const state = { minutes: Number(localStore('minutes')) || 60 };
  function localStore(k, v) { try { if (v === undefined) return localStorage.getItem('dfr_' + k); localStorage.setItem('dfr_' + k, v); } catch { return null; } }

  async function api(p) {
    const r = await fetch(p, { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    lastOk = new Date(); document.getElementById('updated').textContent = 'Updated ' + fmt(lastOk.toISOString());
    return r.json();
  }
  function setPill(h) { const el = document.getElementById('health-pill'); el.className = 'pill ' + h.state; el.textContent = h.state === 'healthy' ? 'Monitor healthy' : 'Monitor degraded'; }
  function offline(e) {
    const el = document.getElementById('health-pill'); el.className = 'pill offline'; el.textContent = 'PC unreachable';
    $view.insertAdjacentHTML('afterbegin', `<div class="banner bad">Cannot reach the recorder (${esc(e.message)}). The PC may be asleep, off, offline, or Tailscale is disconnected. This is not "no activity". Last successful update: ${lastOk ? fmt(lastOk.toISOString()) : 'none this visit'}.</div>`);
  }
  document.getElementById('surface').textContent = SURFACE === 'remote' ? 'Read-only phone view' : 'Local admin view (this PC only)';

  const routes = [
    [/^#?\/?$/, overview], [/^#\/project\/(\d+)$/, project], [/^#\/version\/(\d+)$/, version], [/^#\/commit\/(\d+)\/([0-9a-f]{40})$/, commit],
    [/^#\/workdiff\/(\d+)\/(staged|unstaged)\/(.+)$/, workdiff], [/^#\/sessions$/, sessions], [/^#\/reports$/, reportList], [/^#\/report\/(\d+)$/, reportOne],
    [/^#\/range\/(.+)\/(.+)$/, rangeView], [/^#\/health$/, health],
  ];
  async function route() {
    clearInterval(timer);
    const h = location.hash || '#/';
    current = h;
    document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === h || (h.startsWith('#/project') && a.getAttribute('href') === '#/')));
    for (const [re, fn] of routes) { const m = h.match(re); if (m) { try { await fn(...m.slice(1).map(decodeURIComponent)); } catch (e) { offline(e); } return; } }
    $view.innerHTML = '<p>Not found.</p>';
  }
  window.addEventListener('hashchange', route);

  function windowButtons() {
    const opts = [[15, '15 min'], [60, '1 hour'], [120, '2 hours'], [1440, '24 hours']];
    return `<div class="seg" id="win">${opts.map(([m, l]) => `<button data-m="${m}" class="${state.minutes === m ? 'on' : ''}">${l}</button>`).join('')}<button data-custom="1">Custom…</button></div>`;
  }
  function bindWindow(rerender) {
    document.querySelectorAll('#win button').forEach((b) => b.onclick = () => {
      if (b.dataset.custom) { location.hash = `#/range/${encodeURIComponent(new Date(Date.now() - 6 * 3600000).toISOString())}/${encodeURIComponent(new Date().toISOString())}`; return; }
      state.minutes = Number(b.dataset.m); localStore('minutes', state.minutes); rerender();
    });
  }

  function totalsTiles(t, cov) {
    const unk = cov.status === 'unavailable';
    const v = (n) => (unk ? '?' : n);
    const tiles = [['commits', 'Commits'], ['files_edited', 'Files edited'], ['files_created', 'New files'], ['files_deleted', 'Deleted'], ['files_renamed', 'Renamed'], ['branch_or_head_transitions', 'Branch/HEAD moves'], ['snapshots_captured', 'Versions saved'], ['reported_tool_calls', 'Agent tool calls (reported)'], ['sessions_active', 'Agent sessions active']];
    return `<div class="tiles">${tiles.map(([k, l]) => `<div class="tile${!unk && !t[k] ? ' zero' : ''}"><b>${v(t[k])}</b><span>${l}</span></div>`).join('')}</div>`;
  }
  // Compact number: 24401242 -> 24.4M
  const num = (n) => { n = Number(n) || 0; if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K'; return n.toLocaleString(); };
  // Re-render without collapsing whatever the viewer has opened.
  function paint(html) {
    const open = new Set([...$view.querySelectorAll('details[data-k][open]')].map((d) => d.dataset.k));
    $view.innerHTML = html;
    $view.querySelectorAll('details[data-k]').forEach((d) => { if (open.has(d.dataset.k)) d.open = true; });
  }
  function wtRow(w) {
    const chips = [
      w.branch ? `<span class="chip br" title="branch">⎇ ${esc(w.branch)}</span>` : '<span class="chip det">detached HEAD</span>',
      w.staged ? `<span class="chip staged">${w.staged} staged</span>` : '',
      w.unstaged ? `<span class="chip unstaged">${w.unstaged} changed</span>` : '',
      w.untracked ? `<span class="chip untracked">${w.untracked} untracked</span>` : '',
      w.upstream && (w.ahead || w.behind) ? `<span class="chip sync" title="vs ${esc(w.upstream)} (last fetched copy)">↑${w.ahead ?? '?'} ↓${w.behind ?? '?'}</span>` : '',
      w.state !== 'ok' ? '<span class="chip warn">observation problem</span>' : '',
      w.last_change_utc ? `<span class="when">changed ${ago(w.last_change_utc)}</span>` : '',
    ].join('');
    return `<div class="wt"><a class="wt-name" href="#/project/${w.id}">${esc(short(w.path))}</a><div class="chips">${chips}</div></div>`;
  }
  function actChips(rp) {
    if (!rp) return '';
    return [rp.commits.length ? `<span class="chip act commit">${rp.commits.length} commit${rp.commits.length > 1 ? 's' : ''}</span>` : '',
      rp.edited ? `<span class="chip act">${rp.edited} edited</span>` : '', rp.created ? `<span class="chip act">${rp.created} new</span>` : '',
      rp.deleted ? `<span class="chip act">${rp.deleted} deleted</span>` : ''].join('');
  }
  // Group changed paths by their first folder below the shared prefix.
  function folderGroups(paths) {
    if (!paths.length) return [];
    const split = paths.map((x) => x.path.split(/[\\/]/));
    let pre = split[0].length - 1;
    for (const s of split) { let i = 0; while (i < pre && s[i] === split[0][i]) i++; pre = i; }
    const g = new Map();
    for (const x of paths) { const s = x.path.split(/[\\/]/); const k = s.length - 1 > pre ? s[pre] : '(top level)'; const e = g.get(k) || { name: k, n: 0, items: [] }; e.n++; e.items.push(x); g.set(k, e); }
    return [...g.values()].sort((a, b) => b.n - a.n);
  }
  function coverageBanner(cov) {
    if (cov.status === 'complete') return '';
    if (cov.status === 'unavailable') return `<div class="banner bad">Unknown: the recorder was not running during this window. Missing data is not "no activity".</div>`;
    return `<div class="banner">Partial coverage: recorder observed ${cov.minutes_observed} of ${cov.minutes_total} minutes. Counts may be incomplete.</div>`;
  }

  async function overview() {
    const render = async () => {
      const d = await api(`/api/overview?minutes=${state.minutes}`);
      if (current !== (location.hash || '#/')) return;
      setPill(d.health);
      const r = d.report;
      const byName = new Map(r.projects.map((p) => [p.name, p]));
      const busy = (rp) => rp && (rp.commits.length || rp.edited || rp.created || rp.deleted);
      const recent = (w) => w.last_change_utc && Date.parse(w.last_change_utc) > Date.parse(r.from_utc);
      const active = [], quiet = [];
      for (const p of d.projects) (busy(byName.get(p.name)) ? active : quiet).push(p);
      const score = (p) => { const rp = byName.get(p.name); return rp ? rp.commits.length * 10 + rp.edited * 3 + rp.created + rp.deleted : 0; };
      active.sort((a, b) => score(b) - score(a));
      const activeCard = (p) => {
        const rp = byName.get(p.name);
        const wts = p.worktrees.slice().sort((a, b) => (b.last_change_utc || '').localeCompare(a.last_change_utc || ''));
        const show = wts.filter((w) => recent(w) || w.staged || w.unstaged).slice(0, 4);
        const list = show.length ? show : wts.slice(0, 1);
        return `<div class="card"><div class="proj-head"><b>${esc(p.name)}</b>${actChips(rp)}${p.sessions.length ? `<span class="chip">${p.sessions.length} agent session${p.sessions.length > 1 ? 's' : ''}</span>` : ''}</div>
          ${list.map(wtRow).join('')}
          ${rp && rp.correlation ? `<div class="small muted mt"><i>${esc(rp.correlation)}</i></div>` : ''}
          <a class="more" href="#/project/${(list[0] || p.worktrees[0]).id}">See actual changes →</a>${p.worktrees.length > list.length ? `<span class="small muted"> · ${p.worktrees.length} worktrees in all</span>` : ''}</div>`;
      };
      const outside = r.projects.filter((p) => p.name.endsWith('(outside Git)') && (p.edited || p.created || p.deleted));
      paint(`<h1>What changed</h1>${windowButtons()}
        ${coverageBanner(r.coverage)}
        <div class="card summary"><div class="range">${fmt(r.from_utc)} – ${fmt(r.to_utc)}</div>${esc(r.narrative)}</div>
        ${totalsTiles(r.totals, r.coverage)}
        <h2>Active projects <span class="count">${active.length + outside.length}</span></h2>
        ${active.length || outside.length ? '' : '<div class="card muted">Nothing changed in this window.</div>'}
        <div class="grid">${active.map(activeCard).join('')}
        ${outside.map((p) => `<div class="card"><div class="proj-head"><b>${esc(p.name)}</b>${actChips({ commits: [], edited: p.edited, created: p.created, deleted: p.deleted })}</div>
          ${folderGroups(p.paths).slice(0, 8).map((g, i) => `<details data-k="out-${esc(p.name)}-${i}"><summary class="folder"><span class="mono">${esc(g.name)}</span><span class="n">${g.n} file${g.n > 1 ? 's' : ''}</span></summary>
            ${g.items.slice(0, 30).map((x) => `<div class="small mono">${esc(x.kinds.join('/'))} ${x.versions.length ? `<a href="#/version/${x.versions[x.versions.length - 1]}">${esc(short(x.path))}</a>` : esc(short(x.path))}</div>`).join('')}</details>`).join('')}</div>`).join('')}</div>
        ${quiet.length ? `<details class="fold" data-k="quiet"><summary>Quiet projects <span class="count small muted">${quiet.length} · no changes in this window</span></summary><div class="inner">
          ${quiet.map((p) => { const w = p.worktrees[0]; return `<div class="qrow"><a href="#/project/${w.id}"><b>${esc(p.name)}</b></a>${w.branch ? `<span class="chip br">⎇ ${esc(w.branch)}</span>` : '<span class="chip det">detached</span>'}${w.unstaged ? `<span class="chip unstaged">${w.unstaged} changed</span>` : ''}${w.untracked ? `<span class="chip untracked">${w.untracked} untracked</span>` : ''}${p.worktrees.length > 1 ? `<span class="when">${p.worktrees.length} worktrees</span>` : ''}</div>`; }).join('')}
        </div></details>` : ''}
        <p class="small muted">Export this window: <a href="/api/export?minutes=${state.minutes}&fmt=md">Markdown</a> · <a href="/api/export?minutes=${state.minutes}&fmt=html">HTML</a> · <a href="/api/export?minutes=${state.minutes}&fmt=json">JSON</a></p>`);
      bindWindow(render);
    };
    await render();
    timer = setInterval(() => render().catch(offline), 15000);
  }

  function evLine(e, wtId) {
    const d = e.detail || {};
    let what = '', link = '';
    if (e.kind === 'commit_observed') { what = `commit <span class="mono">${esc(e.after_ref.slice(0, 10))}</span> ${esc(d.subject)} <span class="muted">(${d.files} files, +${d.added}/-${d.deleted}, author ${esc(d.author)})</span>`; link = `#/commit/${e.worktree_id}/${e.after_ref}`; }
    else if (e.kind === 'worktree_state') what = `Git state <span class="mono">${esc(d.rel)}</span>: ${esc(e.before_ref)} → ${esc(e.after_ref)}`;
    else if (/branch|head/.test(e.kind)) what = `${esc(e.kind.replace(/_/g, ' '))}: ${esc(e.before_ref || '?')} → ${esc(e.after_ref || '?')}`;
    else what = `${esc(e.kind)} <span class="mono">${esc(short(e.path))}</span>${d.from ? ` from ${esc(short(d.from))}` : ''}${d.observed_after_restart ? ' <span class="tag warn">seen at reconciliation; exact time unknown</span>' : ''}`;
    if (e.version_id) link = `#/version/${e.version_id}`;
    const tag = e.source.startsWith('git') ? 'git' : 'fs';
    return `<div class="ev"><div class="small muted">${fmt(e.utc)} <span class="tag ${tag}">${esc(e.evidence)}</span></div><div>${link ? `<a href="${link}">${what}</a>` : what}</div></div>`;
  }

  async function project(id) {
    const render = async () => {
      const [projs, evs] = await Promise.all([api('/api/projects'), api(`/api/timeline?wt=${id}&minutes=${Math.max(state.minutes, 60)}`)]);
      const p = projs.find((x) => x.worktrees.some((w) => String(w.id) === id));
      if (!p) { $view.innerHTML = '<p>Unknown worktree.</p>'; return; }
      const w = p.worktrees.find((x) => String(x.id) === id);
      $view.innerHTML = `<p class="small"><a href="#/">← Overview</a></p><h1>${esc(p.name)}</h1>
        <div class="seg">${p.worktrees.map((x) => `<button class="${x === w ? 'on' : ''}" data-wt="${x.id}">${esc(short(x.path))}${x.branch ? ' · ' + esc(x.branch) : ' · detached'}</button>`).join('')}</div>
        <div class="card"><div class="mono">${esc(w.path)}</div>
          <div class="row small"><span>${w.branch ? 'Branch <b>' + esc(w.branch) + '</b>' : '<b>Detached HEAD</b>'}</span><span>HEAD <span class="mono">${esc((w.head || '').slice(0, 10))}</span></span>
          <span>${w.upstream ? `vs ${esc(w.upstream)} (last fetched copy, not live GitHub): ahead ${w.ahead}, behind ${w.behind}` : 'No upstream configured'}</span><span>Scan: ${esc(w.state)} ${ago(w.last_ok_utc)}</span></div>
          ${w.error ? `<div class="banner">${esc(w.error)}</div>` : ''}
          ${w.last_commit ? `<div class="small">Latest observed commit: <a href="#/commit/${w.id}/${w.last_commit.sha}">${esc(w.last_commit.subject)}</a></div>` : ''}</div>
        <h2>Uncommitted right now (${w.staged} staged · ${w.unstaged} unstaged · ${w.untracked} untracked)</h2>
        <div class="card scroll">${w.changed.length ? `<table><tr><th>Path</th><th>State</th><th>Diff</th></tr>${w.changed.map((c) => `<tr><td class="mono">${esc(c.path)}</td><td>${c.untracked ? 'untracked' : [c.staged ? 'staged ' + c.staged : '', c.unstaged ? 'unstaged ' + c.unstaged : ''].filter(Boolean).join(', ')}${c.orig ? ' (from ' + esc(c.orig) + ')' : ''}</td><td>${c.staged ? `<a href="#/workdiff/${w.id}/staged/${encodeURIComponent(c.path)}">staged</a> ` : ''}${c.unstaged ? `<a href="#/workdiff/${w.id}/unstaged/${encodeURIComponent(c.path)}">unstaged</a>` : ''}${c.untracked ? '<span class="muted">no Git diff</span>' : ''}</td></tr>`).join('')}</table>` : '<span class="muted">Working tree clean.</span>'}</div>
        <h2>Timeline</h2>${windowButtons()}
        <div class="card">${evs.length ? evs.map((e) => evLine(e, id)).join('') : '<span class="muted">No events recorded for this worktree in this window.</span>'}</div>`;
      document.querySelectorAll('[data-wt]').forEach((b) => b.onclick = () => { location.hash = `#/project/${b.dataset.wt}`; });
      bindWindow(render);
    };
    await render();
    timer = setInterval(() => render().catch(offline), 30000);
  }

  function diffHtml(t) {
    return `<pre class="diff">${esc(t).split('\n').map((l) => l.startsWith('+') && !l.startsWith('+++') ? `<span class="a">${l}</span>` : l.startsWith('-') && !l.startsWith('---') ? `<span class="d">${l}</span>` : l.startsWith('@@') ? `<span class="h">${l}</span>` : l).join('\n')}</pre>`;
  }
  async function version(id) {
    const d = await api(`/api/version/${id}`);
    const v = d.version;
    $view.innerHTML = `<p class="small"><a href="#/" data-back="1">← Back</a></p><h1>Saved version of ${esc(short(v.path))}</h1>
      <div class="card"><div class="mono">${esc(v.path)}</div><div class="row small"><span>${fmt(v.utc)}</span><span>status <b>${esc(v.status)}</b></span><span>${v.size ?? '?'} bytes</span><span>source: ${esc(v.origin)}</span></div>
      ${d.prior ? `<div class="small">Compared with <a href="#/version/${d.prior.id}">version ${d.prior.id}</a> (${fmt(d.prior.utc)}, ${esc(d.prior.status)})</div>` : ''}</div>
      ${d.diff.text != null ? `<div class="small muted">Against ${esc(d.diff.against)} · +${d.diff.added ?? '?'} / -${d.diff.removed ?? '?'} lines · secrets redacted</div>${diffHtml(d.diff.text)}` : `<div class="banner">${esc(d.diff.unavailable)}</div>`}
      <h2>All recorded versions of this file</h2><div class="card scroll"><table><tr><th>When</th><th>Status</th><th>Size</th></tr>${d.chain.map((c) => `<tr><td><a href="#/version/${c.id}">${fmt(c.utc)}</a>${String(c.id) === id ? ' ◀' : ''}</td><td>${esc(c.status)}${c.reason ? ' <span class="muted small">' + esc(c.reason) + '</span>' : ''}</td><td>${c.size ?? ''}</td></tr>`).join('')}</table></div>`;
  }
  async function commit(wt, sha) {
    const d = await api(`/api/commit/${wt}/${sha}`);
    $view.innerHTML = `<p class="small"><a href="#/" data-back="1">← Back</a></p><h1>Commit <span class="mono">${esc(sha.slice(0, 10))}</span></h1><div class="small muted">From Git (git_observed). Author fields are Git metadata, not proof of which agent wrote it. Secrets redacted.</div>${diffHtml(d.text)}`;
  }
  async function workdiff(wt, kind, rel) {
    const d = await api(`/api/workdiff/${wt}?path=${encodeURIComponent(rel)}&staged=${kind === 'staged' ? 1 : 0}`);
    $view.innerHTML = `<p class="small"><a href="#/" data-back="1">← Back</a></p><h1>${esc(kind)} diff</h1><div class="mono small">${esc(rel)}</div>${diffHtml(d.text || '(no difference)')}`;
  }

  async function sessions() {
    const list = await api('/api/sessions');
    const tok = (s) => { const t = s.tokens || {}; if (s.token_kind !== 'measured') return '<span class="muted">unavailable</span>'; return `${(t.output || 0).toLocaleString()} out · ${(t.input || 0).toLocaleString()} in${t.cache_read != null ? ` · ${(t.cache_read || 0).toLocaleString()} cache read` : ''}${t.total != null ? ` · ${t.total.toLocaleString()} total` : ''}`; };
    const tk = (s) => { const t = s.tokens || {}; if (s.token_kind !== 'measured') return ''; const parts = [`<span><b>${num(t.output)}</b> out</span>`, `<span><b>${num(t.input)}</b> in</span>`]; if (t.cache_read != null) parts.push(`<span><b>${num(t.cache_read)}</b> cache</span>`); return parts.join(''); };
    const card = (s) => {
      const proj = String(s.workspace || '').split(/[\\/]/).filter(Boolean).pop() || 'workspace unknown';
      const st = String(s.state || 'unknown');
      return `<div class="card"><div class="agent-head"><span class="who ${esc(s.provider)}">${esc(s.provider)}</span><span class="state ${esc(st)}">${esc(st)}</span><span class="agent-proj">${esc(proj)}</span><span class="when">${ago(s.last_utc)}</span></div>
        <div class="stats"><span>${esc(s.model || 'model unknown')}</span><span><b>${num(s.tool_calls)}</b> tool calls</span><span><b>${num(s.edit_count)}</b> edits reported</span>${s.subagents ? `<span><b>${s.subagents}</b> subagents</span>` : ''}${tk(s)}</div>
        <div class="path">${esc(s.workspace || '')}${s.branch && s.branch !== 'HEAD' ? ' · ' + esc(s.branch) : ''} · ${fmt(s.first_utc)} → ${fmt(s.last_utc)}</div>
        ${s.edit_count ? `<details data-k="e-${esc(s.session_id)}"><summary class="small">Files it reported editing (${s.edits.length})</summary>${s.edits.slice().reverse().map((e) => `<div class="small mono">${fmt(e.t)} ${esc(e.tool)} ${esc(short(e.path))}</div>`).join('')}</details>` : ''}
        <details data-k="t-${esc(s.session_id)}"><summary class="small">Tools used</summary><div class="small">${Object.entries(s.tools).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'none'}</div></details></div>`;
    };
    const day = Date.now() - 86400000;
    const groups = [['Working now', list.filter((s) => s.state === 'working')], ['Waiting', list.filter((s) => s.state === 'waiting')],
      ['Earlier today', list.filter((s) => !['working', 'waiting'].includes(s.state) && Date.parse(s.last_utc) >= day)]];
    const older = list.filter((s) => !['working', 'waiting'].includes(s.state) && !(Date.parse(s.last_utc) >= day));
    paint(`<h1>Agent sessions</h1><p class="small muted">Read from existing Claude Code and Codex history (no hooks). This is what agents <i>reported</i>; real file changes are proven separately by Git and file evidence. Grok and Copilot: no readable history on this PC.</p>
      ${groups.filter(([, g]) => g.length).map(([t, g]) => `<h2>${t} <span class="count">${g.length}</span></h2><div class="grid">${g.map(card).join('')}</div>`).join('')}
      ${older.length ? `<details class="fold" data-k="older"><summary>Older sessions <span class="count small muted">${older.length}</span></summary><div class="inner"><div class="grid">${older.map(card).join('')}</div></div></details>` : ''}`);
  }

  async function reportList() {
    const list = await api('/api/reports');
    const now = Date.now();
    const twoH = `#/range/${encodeURIComponent(new Date(Math.floor(now / 7200000) * 7200000 - 7200000).toISOString())}/${encodeURIComponent(new Date(Math.floor(now / 7200000) * 7200000).toISOString())}`;
    $view.innerHTML = `<h1>Reports</h1><div class="card"><div class="row"><a class="btn" href="${twoH}">Last full 2-hour block</a>
      <label class="small">From <input type="datetime-local" id="f"></label><label class="small">To <input type="datetime-local" id="t"></label><button class="btn" id="go">Custom range</button></div></div>
      <h2>Hourly (stored)</h2><div class="card">${list.length ? list.map((r) => `<div class="ev"><a href="#/report/${r.id}">${fmt(r.from_utc)} – ${fmt(r.to_utc)}</a></div>`).join('') : '<span class="muted">The first hourly report is written after the first full hour.</span>'}</div>`;
    document.getElementById('go').onclick = () => { const f = document.getElementById('f').value, t = document.getElementById('t').value; if (f && t) location.hash = `#/range/${encodeURIComponent(new Date(f).toISOString())}/${encodeURIComponent(new Date(t).toISOString())}`; };
  }
  function reportHtml(r, q) {
    return `${coverageBanner(r.coverage)}<div class="card"><div class="small muted">${fmt(r.from_utc)} – ${fmt(r.to_utc)} · generated ${fmt(r.generated_utc)}</div><p>${esc(r.narrative)}</p>
      <div class="small"><a href="/api/export?${q}&fmt=md">Markdown</a> · <a href="/api/export?${q}&fmt=html">HTML</a> · <a href="/api/export?${q}&fmt=json">JSON</a></div></div>${totalsTiles(r.totals, r.coverage)}
      ${r.projects.map((p) => `<div class="card"><b>${esc(p.name)}</b><div class="small">${p.commits.length} commits · ${p.edited} edited · ${p.created} new · ${p.deleted} deleted · ${p.git_state_changes} Git state changes · ${p.snapshots_captured} versions saved</div>
        ${p.correlation ? `<div class="small"><i>${esc(p.correlation)}</i></div>` : ''}
        ${p.commits.map((c) => `<div class="small"><a href="#/commit/${c.worktree_id}/${c.sha}">commit ${esc(c.sha.slice(0, 8))}</a> ${esc(c.subject)}</div>`).join('')}
        ${p.branch_events.map((b) => `<div class="small">${esc(b.kind)}: ${esc(b.from || '?')} → ${esc(b.to || '?')}</div>`).join('')}
        <details><summary class="small">Changed paths (${p.paths.length}${p.paths_truncated ? ' of ' + p.paths_truncated : ''})</summary>${p.paths.map((x) => `<div class="small mono">${esc(x.kinds.join('/'))} [${esc(x.category)}] ${x.versions.length ? `<a href="#/version/${x.versions[x.versions.length - 1]}">${esc(short(x.path))}</a>` : esc(short(x.path))}</div>`).join('')}</details></div>`).join('')}
      ${r.sessions.length ? `<h2>Agent sessions (reported)</h2><div class="card scroll"><table><tr><th>Agent</th><th>Project</th><th>Tools</th><th>Edits</th></tr>${r.sessions.map((s) => `<tr><td>${esc(s.provider)} <span class="mono small">${esc(s.skey.split(':')[1].slice(0, 8))}</span></td><td>${esc(s.project)}</td><td>${s.tools}</td><td>${s.edits}</td></tr>`).join('')}</table></div>` : ''}
      ${r.gaps.length ? `<h2>Monitoring gaps</h2><div class="card">${gapLines(r.gaps, false)}</div>` : ''}`;
  }
  async function reportOne(id) { const r = await api(`/api/report/${id}`); $view.innerHTML = `<p class="small"><a href="#/reports">← Reports</a></p><h1>Hourly report</h1>${reportHtml(r, `from=${encodeURIComponent(r.from_utc)}&to=${encodeURIComponent(r.to_utc)}`)}`; }
  async function rangeView(f, t) { const q = `from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`; const r = await api(`/api/range?${q}`); $view.innerHTML = `<p class="small"><a href="#/reports">← Reports</a></p><h1>Report for chosen range</h1>${reportHtml(r, q)}`; }

  async function health() {
    const render = async () => {
      const h = await api('/api/health'); setPill(h);
      const ok = Object.values(h.transcript_readers).filter((p) => p.available && !p.note).length;
      paint(`<h1>Monitor health: ${esc(h.state)}</h1>${h.problems.length ? `<div class="banner">${h.problems.map(esc).join('<br>')}</div>` : ''}
        <div class="card kv"><div><span>Running since</span><b>${fmt(h.started_utc)}</b></div><div><span>Last Git scan</span><b>${ago(h.last_git_scan_utc)}</b></div>
        <div><span>Folders watched</span><b>${h.watch_roots.filter((r) => r.watcher).length} of ${h.watch_roots.length}</b></div><div><span>Agent readers</span><b>${ok} connected</b></div>
        <div><span>Saved versions</span><b>${(h.storage.snapshot_store_bytes / 1048576).toFixed(0)} MB of ${(h.storage.snapshot_quota_bytes / 1073741824).toFixed(0)} GB</b></div><div><span>Next hourly report</span><b>${fmt(h.next_report_boundary_utc)}</b></div></div>
        <details class="fold" data-k="details"><summary>Details</summary><div class="inner">
        <div class="card small"><div>Running since ${fmt(h.started_utc)} as ${esc(h.run_as)} (pid ${h.pid})</div><div>Last Git scan ${ago(h.last_git_scan_utc)} · last full reconciliation ${ago(h.last_reconcile_utc)} · next hourly report ${fmt(h.next_report_boundary_utc)} · ${h.reports_stored} reports stored</div>
        <div>Startup phases: Git ${esc(h.phase.git)}, files ${esc(h.phase.fs)}, agent history ${esc(h.phase.sessions)}</div>
        <div>File events ${h.fs.events} · watcher overflows ${h.fs.overflows} · watcher errors ${h.fs.errors}</div>
        <div>Storage: database ${(h.storage.db_bytes / 1048576).toFixed(1)} MB · saved versions ${(h.storage.snapshot_store_bytes / 1048576).toFixed(1)} MB of ${(h.storage.snapshot_quota_bytes / 1073741824).toFixed(0)} GB, kept ${h.storage.retention_days} days${h.storage.capture_paused_since ? ' · <b>capture paused (full)</b>' : ''}</div>
        <div class="mono">${esc(h.storage.data_dir)}</div></div></div></details>
        <h2>Watched folders</h2><div class="card scroll"><table><tr><th>Folder</th><th>Kind</th><th>Watching</th><th>Versions</th></tr>${h.watch_roots.map((r) => `<tr><td class="mono">${esc(r.path)}</td><td>${esc(r.kind)}</td><td>${r.present ? (r.watcher ? 'yes' : '<b>no</b>') : '<b>folder missing</b>'}</td><td>${r.snapshots ? 'on' : 'off'}</td></tr>`).join('')}</table>
        <div class="small muted">${h.linked_worktrees_outside_roots} linked worktree(s) of these repos live outside the watched folders (archive/scrap) and are not watched.</div></div>
        <h2>Agent history readers</h2><div class="card scroll"><table><tr><th>Agent</th><th>Status</th><th>Files (last ${'60'} days)</th><th>Last read</th></tr>${Object.entries(h.transcript_readers).map(([k, p]) => `<tr><td>${esc(k)}</td><td>${p.available ? (p.note ? 'folder found; ' + esc(p.note) : 'connected') : 'not found on this PC'}${p.error ? ' · ' + esc(p.error) : ''}</td><td>${p.files ?? '—'}</td><td>${ago(p.last_scan)}</td></tr>`).join('')}</table></div>
        <h2>Process sampler</h2><div class="card small">Last sample ${ago(h.process_sampler.last_sample_utc)} · ${Object.entries(h.process_sampler.counts || {}).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'no agent processes seen'} <span class="muted">(sampled every 30 s; short processes can be missed)</span></div>
        ${h.failed_paths.length ? `<h2>Problem paths</h2><div class="card">${h.failed_paths.map((f) => `<div class="small mono">${esc(f.path)}: ${esc(f.state)} ${esc(f.error || '')}</div>`).join('')}</div>` : ''}
        <h2>Recent gaps</h2><div class="card">${h.recent_gaps.length ? gapLines(h.recent_gaps, true) : '<span class="muted small">None recorded.</span>'}</div>`);
    };
    await render(); timer = setInterval(() => render().catch(offline), 15000);
  }

  document.addEventListener('click', (e) => { const a = e.target.closest('[data-back]'); if (a && history.length > 1) { e.preventDefault(); history.back(); } });
  api('/api/health').then(setPill).catch(() => {});
  route();
})();
