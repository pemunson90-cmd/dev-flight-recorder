'use strict';
// Read-only, hook-free readers for Claude Code and Codex transcript files.
// Stores metadata only (ids, workspace, times, tool names/counts, reported edit paths, usage);
// no prompt or response text is copied into the recorder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { log, nowIso } = require('./util');

const CHUNK = 4 * 1024 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

class Sessions {
  constructor(db, cfg) {
    this.db = db; this.cfg = cfg;
    this.claudeRoot = path.join(cfg.user_profile, '.claude', 'projects');
    this.codexRoot = path.join(cfg.user_profile, '.codex', 'sessions');
    this.providers = {
      claude: { root: this.claudeRoot, available: false, files: 0, last_scan: null, error: null },
      codex: { root: this.codexRoot, available: false, files: 0, last_scan: null, error: null },
      grok: { root: path.join(cfg.user_profile, '.grok', 'sessions'), available: false, note: 'reader not implemented; folder checked only' },
      copilot: { root: path.join(cfg.user_profile, '.copilot'), available: false, note: 'reader not implemented; folder checked only' },
    };
    this.msgIds = new Map(); this.busy = false;
  }

  async listFiles(root) {
    const out = []; const cutoff = Date.now() - this.cfg.session_history_days * 86400000;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop(); let h;
      try { h = await fsp.opendir(d); } catch { continue; }
      for await (const e of h) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) stack.push(f);
        else if (e.name.endsWith('.jsonl')) { try { const st = await fsp.stat(f); if (st.mtimeMs >= cutoff) out.push([f, st]); } catch {} }
      }
    }
    return out;
  }

  async scan() {
    if (this.busy) return; this.busy = true;
    try {
      for (const [name, p] of Object.entries(this.providers)) {
        p.available = fs.existsSync(p.root);
        if (!p.available || !['claude', 'codex'].includes(name)) continue;
        try {
          const files = await this.listFiles(p.root);
          p.files = files.length;
          for (const [f, st] of files) await this.ingest(name, f, st);
          p.last_scan = nowIso(); p.error = null;
        } catch (e) { p.error = e.message; log('WARN', `session scan ${name}: ${e.message}`); }
      }
      this.refreshStates();
    } finally { this.busy = false; }
  }

  sessionKey(provider, f) {
    if (provider === 'claude') {
      const parts = f.split(path.sep); const i = parts.lastIndexOf('subagents');
      const id = i > 0 ? parts[i - 1] : path.basename(f, '.jsonl');
      return { skey: `claude:${id}`, id, sub: i > 0 };
    }
    const m = path.basename(f).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    const id = m ? m[1] : path.basename(f, '.jsonl');
    return { skey: `codex:${id}`, id, sub: false };
  }

  async ingest(provider, f, st) {
    const { skey, id, sub } = this.sessionKey(provider, f);
    const fkey = `${skey}|${f}`;
    let row = this.db.q('SELECT * FROM sessions WHERE skey=?').get(skey);
    const offs = row ? JSON.parse(row.file || '{}') : {};
    const off = offs[f] || 0;
    if (off >= st.size) return;
    const s = row ? {
      ...row, tools: JSON.parse(row.tools_json || '{}'), edits: JSON.parse(row.edits_json || '[]'), tokens: JSON.parse(row.tokens_json || '{}'), task: null,
    } : { skey, provider, session_id: id, cwd: null, branch: null, first_utc: null, last_utc: null, model: null, tools: {}, edits: [], tokens: {}, subagents: 0, originator: null, parse_errors: 0, task: null };
    if (sub && !off) s.subagents = (s.subagents || 0) + 1;
    const hours = new Map();
    const bump = (ts, k) => { if (!ts) return; const h = ts.slice(0, 13) + ':00:00Z'; const o = hours.get(h) || { tools: 0, edits: 0, messages: 0 }; o[k]++; hours.set(h, o); };
    const fd = await fsp.open(f, 'r');
    let pos = off, carry = Buffer.alloc(0);
    try {
      while (pos < st.size) {
        const len = Math.min(CHUNK, st.size - pos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fd.read(buf, 0, len, pos);
        pos += bytesRead;
        let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0, nl;
        while ((nl = data.indexOf(10, start)) !== -1) {
          const line = data.subarray(start, nl); start = nl + 1;
          if (line.length < 2) continue;
          let j; try { j = JSON.parse(line.toString('utf8')); } catch { s.parse_errors = (s.parse_errors || 0) + 1; continue; }
          (provider === 'claude' ? this.claudeLine : this.codexLine).call(this, s, j, bump);
        }
        carry = Buffer.from(data.subarray(start));
        if (carry.length > 64 * 1024 * 1024) { carry = Buffer.alloc(0); s.parse_errors++; }
        if (bytesRead === 0) break;
      }
    } finally { await fd.close(); }
    offs[f] = pos - carry.length; // incomplete trailing line is re-read next time
    s.edits = s.edits.slice(-300);
    this.db.tx(() => {
      this.db.q(`INSERT INTO sessions(skey,provider,session_id,file,offset,file_mtime,cwd,branch,first_utc,last_utc,model,state,tools_json,edits_json,tokens_json,token_kind,subagents,originator,parse_errors)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(skey) DO UPDATE SET file=excluded.file, offset=excluded.offset, file_mtime=MAX(sessions.file_mtime, excluded.file_mtime),
        cwd=excluded.cwd, branch=excluded.branch, first_utc=excluded.first_utc, last_utc=excluded.last_utc, model=excluded.model, state=COALESCE(excluded.state, sessions.state), tools_json=excluded.tools_json,
        edits_json=excluded.edits_json, tokens_json=excluded.tokens_json, token_kind=excluded.token_kind, subagents=excluded.subagents, originator=excluded.originator, parse_errors=excluded.parse_errors`)
        .run(skey, provider, s.session_id, JSON.stringify(offs), 0, Math.max(st.mtimeMs, row ? row.file_mtime || 0 : 0), s.cwd, s.branch, s.first_utc, s.last_utc, s.model, s.task,
          JSON.stringify(s.tools), JSON.stringify(s.edits), JSON.stringify(s.tokens), Object.keys(s.tokens).length ? 'measured' : 'unavailable', s.subagents || 0, s.originator, s.parse_errors || 0);
      for (const [h, o] of hours) {
        this.db.q(`INSERT INTO session_hours(skey,hour_utc,tools,edits,messages) VALUES(?,?,?,?,?) ON CONFLICT(skey,hour_utc) DO UPDATE SET tools=tools+excluded.tools, edits=edits+excluded.edits, messages=messages+excluded.messages`)
          .run(skey, h, o.tools, o.edits, o.messages);
      }
    });
  }

  touch(s, ts) { if (!ts) return; if (!s.first_utc || ts < s.first_utc) s.first_utc = ts; if (!s.last_utc || ts > s.last_utc) s.last_utc = ts; }

  claudeLine(s, j, bump) {
    const ts = j.timestamp;
    if (j.cwd) s.cwd = j.cwd;
    if (j.gitBranch) s.branch = j.gitBranch;
    if (j.entrypoint && !s.originator) s.originator = `claude-code (${j.entrypoint})`;
    if (j.type !== 'user' && j.type !== 'assistant') return;
    this.touch(s, ts); bump(ts, 'messages');
    const m = j.message; if (!m) return;
    if (j.type === 'assistant') {
      if (m.model && m.model !== '<synthetic>') s.model = m.model;
      if (m.usage && m.id) {
        let seen = this.msgIds.get(s.skey); if (!seen) { seen = new Set(); this.msgIds.set(s.skey, seen); }
        if (!seen.has(m.id)) {
          seen.add(m.id); if (seen.size > 5000) seen.clear();
          const u = m.usage, t = s.tokens;
          t.input = (t.input || 0) + (u.input_tokens || 0); t.output = (t.output || 0) + (u.output_tokens || 0);
          t.cache_write = (t.cache_write || 0) + (u.cache_creation_input_tokens || 0); t.cache_read = (t.cache_read || 0) + (u.cache_read_input_tokens || 0);
        }
      }
      if (Array.isArray(m.content)) for (const c of m.content) {
        if (c.type !== 'tool_use') continue;
        s.tools[c.name] = (s.tools[c.name] || 0) + 1; bump(ts, 'tools');
        if (EDIT_TOOLS.has(c.name) && c.input && (c.input.file_path || c.input.notebook_path)) {
          s.edits.push({ t: ts, tool: c.name, path: c.input.file_path || c.input.notebook_path }); bump(ts, 'edits');
        }
      }
    }
  }

  codexLine(s, j, bump) {
    const ts = j.timestamp, p = j.payload || {};
    if (j.type === 'session_meta') { s.cwd = p.cwd || s.cwd; s.originator = `${p.originator || 'codex'} ${p.cli_version || ''}`.trim(); if (p.git && p.git.branch) s.branch = p.git.branch; this.touch(s, p.timestamp || ts); return; }
    if (j.type === 'turn_context') { if (p.cwd) s.cwd = p.cwd; if (p.model) s.model = p.model; return; }
    if (j.type === 'event_msg') {
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        const u = p.info.total_token_usage;
        s.tokens = { input: u.input_tokens || 0, cached_input: u.cached_input_tokens || 0, output: u.output_tokens || 0, reasoning: u.reasoning_output_tokens || 0, total: u.total_tokens || 0 };
      } else if (p.type === 'task_started') { s.task = 'working'; this.touch(s, ts); }
      else if (p.type === 'task_complete') { s.task = 'turn_complete'; this.touch(s, ts); }
      else if (p.type === 'turn_aborted') { s.task = 'interrupted'; this.touch(s, ts); }
      else if (p.type === 'user_message' || p.type === 'agent_message') { this.touch(s, ts); bump(ts, 'messages'); }
      return;
    }
    if (j.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) {
      const name = p.name || p.type; s.tools[name] = (s.tools[name] || 0) + 1; bump(ts, 'tools'); this.touch(s, ts);
      const text = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
      if (/apply_patch|\*\*\* (Update|Add|Delete) File:/.test(name + text)) {
        for (const m of text.matchAll(/\*\*\* (Update|Add|Delete) File: ([^\n\\"]+)/g)) { s.edits.push({ t: ts, tool: `apply_patch:${m[1]}`, path: m[2].trim() }); bump(ts, 'edits'); }
      }
    }
  }

  // Activity state is inferred from transcript recency and last task marker; labelled as inferred in the UI.
  refreshStates() {
    const now = Date.now();
    for (const r of this.db.q("SELECT skey,provider,state,file_mtime,last_utc FROM sessions WHERE last_utc > ?").all(new Date(now - 2 * 86400000).toISOString())) {
      const age = (now - Math.max(r.file_mtime || 0, Date.parse(r.last_utc || 0))) / 1000;
      let st;
      if (r.provider === 'codex') {
        const base = (r.state || '').split('|')[0];
        st = base === 'working' ? (age < 600 ? 'working' : 'unknown (no completion marker)') : base === 'interrupted' ? 'interrupted' : age < 1800 ? 'waiting' : 'finished';
      } else st = age < 120 ? 'working' : age < 1800 ? 'waiting' : 'finished';
      const raw = (r.state || '').split('|')[0];
      this.db.q('UPDATE sessions SET state=? WHERE skey=?').run(`${raw}|${st}`, r.skey);
    }
  }
}

module.exports = { Sessions };
