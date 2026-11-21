'use strict';
// Keeps recorder.js running: restarts it after a crash with backoff. Started by the boot-time task.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(process.env.DFR_CONFIG || path.join(__dirname, '..', 'config.json'), 'utf8').replace(/^﻿/, ''));
fs.mkdirSync(path.join(cfg.data_dir, 'logs'), { recursive: true });
const logf = path.join(cfg.data_dir, 'logs', 'supervisor.log');
const say = (m) => fs.appendFileSync(logf, `${new Date().toISOString()} ${m}\n`);
let fails = 0, child = null, stopping = false;

function run() {
  const t0 = Date.now();
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'recorder.js')], { stdio: 'ignore', windowsHide: true });
  say(`started recorder pid=${child.pid}`);
  child.on('exit', (code) => {
    if (stopping) return;
    fails = Date.now() - t0 > 300000 ? 0 : fails + 1;
    const wait = Math.min(300000, 5000 * 2 ** Math.min(fails, 6));
    say(`recorder exited code=${code}; restarting in ${wait / 1000}s`);
    setTimeout(run, wait);
  });
}
const stop = () => { stopping = true; if (child) child.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
run();
