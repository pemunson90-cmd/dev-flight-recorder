'use strict';
// Sampled process observer: known agent executables only. PID + creation time (PIDs get reused).
// No command lines are recorded.
const { spawn } = require('child_process');
const { log, nowIso } = require('./util');

const NAMES = ['claude', 'codex', 'grok', 'opencode', 'copilot', 'cursor', 'git'];

class Procs {
  constructor(db, cfg) { this.db = db; this.cfg = cfg; this.child = null; this.last = null; this.lastCount = {}; this.error = null; }
  start() {
    const filter = NAMES.map((n) => `Name like '${n}%'`).join(' or ');
    const script = `$ErrorActionPreference='SilentlyContinue'; while($true){ $p=@(Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { @{pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; created=if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}} }); [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $p)); [Console]::Out.Flush(); Start-Sleep -Seconds ${this.cfg.process_scan_seconds} }`;
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d.toString('utf8'); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) this.ingest(line); }
    });
    this.child.on('exit', (c) => { this.error = `sampler exited (${c}); restarting`; log('WARN', this.error); setTimeout(() => this.start(), 10000); });
  }
  stop() { if (this.child) { this.child.removeAllListeners('exit'); this.child.kill(); } }
  ingest(line) {
    let arr; try { arr = JSON.parse(line); } catch { return; }
    if (!Array.isArray(arr)) arr = arr ? [arr] : [];
    const now = nowIso(); const counts = {};
    for (const p of arr) {
      const fam = NAMES.find((n) => (p.name || '').toLowerCase().startsWith(n)) || 'other';
      counts[fam] = (counts[fam] || 0) + 1;
      if (fam === 'git') continue; // counted, not persisted (very short-lived, includes this recorder's own calls)
      const pkey = `${p.pid}:${p.created}`;
      this.db.q(`INSERT INTO procs(pkey,name,pid,ppid,created_utc,first_seen,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(pkey) DO UPDATE SET last_seen=excluded.last_seen`)
        .run(pkey, p.name, p.pid, p.ppid, p.created, now, now);
    }
    this.last = now; this.lastCount = counts; this.error = null;
  }
}
module.exports = { Procs };
