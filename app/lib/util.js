'use strict';
// Shared helpers: config, logging, path rules, read-only git runner.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.DFR_CONFIG ? path.resolve(process.env.DFR_CONFIG) : path.resolve(APP_DIR, '..', 'config.json');

function loadConfig() {
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')); // tolerate Notepad's BOM
  c.data_dir = path.resolve(c.data_dir);
  c.watch_roots = c.watch_roots.map((r, i) => ({ ...r, id: i + 1, path: normPath(r.path) }));
  c._sensitiveName = c.sensitive_name_patterns.map((p) => new RegExp(p, 'i'));
  c._sensitiveDir = new Set(c.sensitive_dir_names.map((s) => s.toLowerCase()));
  c._excludeDir = new Set(c.exclude_dir_names.map((s) => s.toLowerCase()));
  c._eligibleExt = new Set(c.snapshots.eligible_extensions.map((s) => s.toLowerCase()));
  return c;
}

// Canonical form: absolute, backslashes, no trailing slash. Comparisons use key().
function normPath(p) {
  let r = path.resolve(p);
  if (r.length > 3 && r.endsWith(path.sep)) r = r.slice(0, -1);
  return r;
}
const key = (p) => normPath(p).toLowerCase();
function isInside(child, parent) {
  const c = key(child), p = key(parent);
  return c === p || c.startsWith(p + '\\');
}

// Directory-segment exclusion (caches, archives, sensitive dirs). Applied before any read.
function excludedDirSegment(cfg, relPath) {
  const parts = relPath.split(/[\\/]/);
  parts.pop();
  for (const seg of parts) {
    const s = seg.toLowerCase();
    if (cfg._excludeDir.has(s) || cfg._sensitiveDir.has(s)) return true;
    if (cfg.exclude_dir_prefixes.some((pre) => s.startsWith(pre.toLowerCase()))) return true;
  }
  return false;
}
function sensitiveName(cfg, fileName) {
  return cfg._sensitiveName.some((re) => re.test(fileName));
}

// Path heuristics for report categories (labels only, not quality judgements).
function category(p) {
  const s = p.replace(/\\/g, '/').toLowerCase();
  const b = s.split('/').pop();
  if (/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py)$/.test(s)) return 'tests';
  if (/(^|\/)(dist|build|out|generated|captures?|verification|reports?)(\/|$)/.test(s)) return 'generated';
  if (/\.(md|txt|rst|adoc|docx?|pdf)$/.test(b)) return 'documents';
  if (/\.(png|jpe?g|gif|svg|webp|ico|mp3|wav|ogg|mp4|ttf|otf|woff2?|psd|blend)$/.test(b)) return 'assets';
  if (/\.(c|cc|cpp|cs|css|go|h|html|java|jsx?|mjs|cjs|py|rs|sql|tsx?|gd|tscn|ps1|sh|json|ya?ml|toml)$/.test(b)) return 'source';
  return 'unknown';
}

let logStream = null;
function initLog(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  logStream = fs.createWriteStream(path.join(dataDir, 'logs', 'recorder.log'), { flags: 'a' });
}
const recentErrors = [];
function log(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  if (logStream) logStream.write(line + '\n');
  if (level === 'ERROR' || level === 'WARN') {
    recentErrors.push(line);
    if (recentErrors.length > 100) recentErrors.shift();
  }
  if (process.stdout.isTTY) console.log(line);
}

// Read-only git: argv only, never a shell, optional locks off, fsmonitor off, bounded.
let gitActive = 0;
const gitQueue = [];
function git(cwd, args, { maxBuffer = 16 * 1024 * 1024, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const run = () => {
      gitActive++;
      execFile('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', cwd, ...args],
        { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, maxBuffer, timeout, windowsHide: true, encoding: 'buffer' },
        (err, stdout, stderr) => {
          gitActive--;
          if (gitQueue.length) gitQueue.shift()();
          if (err) {
            err.stderrText = stderr ? stderr.toString('utf8').slice(0, 500) : '';
            return reject(err);
          }
          resolve(stdout);
        });
    };
    if (gitActive < 3) run(); else gitQueue.push(run);
  });
}

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { APP_DIR, CONFIG_PATH, loadConfig, normPath, key, isInside, excludedDirSegment, sensitiveName, category, initLog, log, recentErrors, git, nowIso, sleep };
