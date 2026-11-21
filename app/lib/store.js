'use strict';
// Encrypted content-addressed snapshot store + secret filter + line diff.
// Blob bytes: gzip -> AES-256-GCM (random 12-byte nonce per blob). Master key is wrapped by Windows
// DPAPI (LocalMachine scope, so it works without an interactive logon) and the data folder is ACL'd
// to the owning user only. The key never leaves this process.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { log, nowIso } = require('./util');

let KEY = null;
let blobDir = null;

function ps(script, input) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { input, encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
}

function initKey(dataDir) {
  blobDir = path.join(dataDir, 'blobs');
  fs.mkdirSync(blobDir, { recursive: true });
  const keyFile = path.join(dataDir, 'master.key.dpapi');
  const unwrap = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'LocalMachine'))`;
  const wrap = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'LocalMachine'))`;
  if (fs.existsSync(keyFile)) {
    KEY = Buffer.from(ps(unwrap, fs.readFileSync(keyFile, 'utf8')), 'base64');
  } else {
    const raw = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, ps(wrap, raw.toString('base64')));
    KEY = raw;
    log('INFO', 'created new DPAPI-wrapped master key');
  }
  if (KEY.length !== 32) throw new Error('master key unwrap failed');
}

// Restrict the data folder to the current user (plus SYSTEM/Administrators for OS maintenance).
function lockDownAcl(dataDir) {
  try {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls', [dataDir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '/Q'], { windowsHide: true, timeout: 30000 });
  } catch (e) { log('WARN', 'ACL lock-down failed: ' + e.message); }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function encrypt(plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, nonce);
  const body = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 6 })), c.final()]);
  return Buffer.concat([Buffer.from('DFR1'), nonce, c.getAuthTag(), body]);
}
function decrypt(buf) {
  if (buf.subarray(0, 4).toString() !== 'DFR1') throw new Error('bad blob header');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(32)), d.final()]));
}

// Store content once per hash. Returns { sha, stored, size_stored } or { error }.
function putBlob(db, cfg, plain) {
  const sha = sha256(plain);
  const existing = db.q('SELECT sha,size_stored FROM blobs WHERE sha=? AND retired_utc IS NULL').get(sha);
  if (existing) { db.q('UPDATE blobs SET refcount=refcount+1 WHERE sha=?').run(sha); return { sha, stored: false, size_stored: existing.size_stored }; }
  const enc = encrypt(plain);
  if (enc.length > cfg.snapshots.max_delta_bytes) return { error: 'excluded_size', detail: `compressed ${enc.length} B > change cap ${cfg.snapshots.max_delta_bytes} B` };
  const used = storeBytes(db);
  if (used + enc.length > cfg.snapshots.max_store_bytes) {
    db.meta('capture_paused_quota', nowIso());
    return { error: 'excluded_quota', detail: `store ${used} B + ${enc.length} B exceeds ${cfg.snapshots.max_store_bytes} B` };
  }
  const rel = path.join(sha.slice(0, 2), sha + '.bin');
  fs.mkdirSync(path.join(blobDir, sha.slice(0, 2)), { recursive: true });
  fs.writeFileSync(path.join(blobDir, rel), enc);
  db.q('INSERT OR REPLACE INTO blobs(sha,file,size_plain,size_stored,refcount,utc,retired_utc) VALUES(?,?,?,?,1,?,NULL)').run(sha, rel, plain.length, enc.length, nowIso());
  return { sha, stored: true, size_stored: enc.length };
}
function getBlob(db, sha) {
  const r = db.q('SELECT file FROM blobs WHERE sha=? AND retired_utc IS NULL').get(sha);
  if (!r) return null;
  return decrypt(fs.readFileSync(path.join(blobDir, r.file)));
}
function storeBytes(db) {
  return Number(db.q('SELECT COALESCE(SUM(size_stored),0) n FROM blobs WHERE retired_utc IS NULL').get().n);
}

// Retention: blobs whose newest reference is older than retention_days are MOVED (never deleted)
// into data_dir/_scrap-YYYYMMDD/blobs per the owner's no-delete rule. Metadata rows stay, marked retired.
function retire(db, cfg, dataDir) {
  const cutoff = new Date(Date.now() - cfg.snapshots.retention_days * 86400000).toISOString();
  const old = db.q(`SELECT b.sha, b.file FROM blobs b WHERE b.retired_utc IS NULL AND b.utc < ?
    AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.blob_sha=b.sha AND v.utc >= ?)`).all(cutoff, cutoff);
  if (!old.length) return 0;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const scrap = path.join(dataDir, `_scrap-${stamp}`, 'blobs');
  for (const b of old) {
    const dest = path.join(scrap, b.file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { fs.renameSync(path.join(blobDir, b.file), dest); } catch (e) { log('WARN', 'retire move failed ' + e.message); continue; }
    db.q('UPDATE blobs SET retired_utc=? WHERE sha=?').run(nowIso(), b.sha);
  }
  db.q('UPDATE versions SET status=\'retired_retention\' WHERE blob_sha IN (SELECT sha FROM blobs WHERE retired_utc IS NOT NULL) AND status IN (\'captured\',\'baseline\',\'baseline_git_head\')').run();
  log('INFO', `retention moved ${old.length} blob(s) to ${scrap}`);
  if (storeBytes(db) < cfg.snapshots.max_store_bytes * 0.95) db.meta('capture_paused_quota', '');
  return old.length;
}

// Best-effort credential detection. A hit means the WHOLE file content is skipped.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\btskey-[A-Za-z0-9-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
];
function findSecret(text) {
  for (const re of SECRET_PATTERNS) if (re.test(text)) return re.source.slice(0, 40);
  return null;
}
function redact(text) {
  let t = text;
  for (const re of SECRET_PATTERNS) t = t.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[REDACTED]');
  return t;
}

// Myers line diff -> unified hunks. Bounded: gives up (says so) on huge edit distances.
function lineDiff(aText, bText, ctx = 3, maxD = 4000) {
  const a = aText.split('\n'), b = bText.split('\n');
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length; while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const N = A.length, M = B.length, max = Math.min(N + M, maxD);
  const V = new Map([[1, 0]]); const trace = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    trace.push(new Map(V));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && (V.get(k - 1) ?? -1) < (V.get(k + 1) ?? -1))) ? (V.get(k + 1) ?? 0) : (V.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V.set(k, x);
      if (x >= N && y >= M) { done = true; break; }
    }
  }
  if (!done) return { truncated: true, text: `(diff too large to compute: more than ${maxD} changed lines)` , added: null, removed: null };
  const ops = []; let x = N, y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const Vd = trace[d]; const k = x - y;
    const prevK = (k === -d || (k !== d && (Vd.get(k - 1) ?? -1) < (Vd.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    const px = Vd.get(prevK) ?? 0, py = px - prevK;
    while (x > px && y > py) { ops.push([' ', A[x - 1]]); x--; y--; }
    if (x === px) ops.push(['+', B[y - 1]]); else ops.push(['-', A[x - 1]]);
    x = px; y = py;
  }
  while (x > 0 && y > 0) { ops.push([' ', A[x - 1]]); x--; y--; }
  ops.reverse();
  const full = a.slice(0, s).map((l) => [' ', l]).concat(ops, a.slice(ea).map((l) => [' ', l]));
  let added = 0, removed = 0; for (const [o] of ops) { if (o === '+') added++; else if (o === '-') removed++; }
  // Build hunks
  const out = []; let i = 0; const L = full.length;
  const lineNo = []; let la = 1, lb = 1; for (const [o] of full) { lineNo.push([la, lb]); if (o !== '+') la++; if (o !== '-') lb++; }
  while (i < L) {
    if (full[i][0] === ' ') { i++; continue; }
    let start = Math.max(0, i - ctx), end = i;
    while (end < L) {
      if (full[end][0] !== ' ') { end++; continue; }
      let run = 0; while (end + run < L && full[end + run][0] === ' ') run++;
      if (end + run >= L || run > ctx * 2) { end = Math.min(L, end + ctx); break; }
      end += run;
    }
    const seg = full.slice(start, end);
    const ca = seg.filter((o) => o[0] !== '+').length, cb = seg.filter((o) => o[0] !== '-').length;
    out.push(`@@ -${lineNo[start][0]},${ca} +${lineNo[start][1]},${cb} @@`);
    for (const [o, l] of seg) out.push(o + l);
    i = end;
  }
  return { truncated: false, text: out.join('\n'), added, removed };
}

module.exports = { initKey, lockDownAcl, sha256, putBlob, getBlob, storeBytes, retire, findSecret, redact, lineDiff };
