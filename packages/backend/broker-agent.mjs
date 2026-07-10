#!/usr/bin/env node
// NARUKAMI elevated admin-shell broker agent.
//
// Launched ELEVATED (via UAC / Start-Process -Verb RunAs) by the non-elevated
// NARUKAMI backend. Because this process is High integrity, the PowerShell PTY
// it spawns is elevated too. It relays that PTY's bytes back to the backend over
// a loopback TCP socket (sockets cross integrity levels; console handles do not).
//
// Config is a 0600 temp file whose path is argv[2]:
//   { port, token, runId, cwd, cols, rows, nodePty }
// nodePty is the absolute path to node-pty, resolved by the backend so dev and
// packaged (Electron-rebuilt) layouts both load the correct ABI build.
//
// Wire protocol (newline-delimited JSON; terminal bytes base64):
//   agent -> backend: {t:'hello',token,runId,pid} then {t:'data',d} / {t:'exit',code}
//   backend -> agent: {t:'input',d} / {t:'resize',cols,rows} / {t:'kill'}

import net from 'node:net';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

(async () => {
  const cfgPath = process.argv[2];
  if (!cfgPath) process.exit(2);

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    process.exit(2);
  }
  // The config carries a one-time auth token — remove it from disk immediately.
  try {
    fs.unlinkSync(cfgPath);
  } catch {
    /* best effort */
  }

  let spawn;
  try {
    const mod = await import(pathToFileURL(cfg.nodePty).href);
    spawn = mod.spawn ?? mod.default?.spawn;
  } catch (err) {
    process.stderr.write(`[broker-agent] cannot load node-pty: ${err?.message || err}\n`);
    process.exit(3);
  }
  if (typeof spawn !== 'function') process.exit(3);

  // Elevated because THIS process is elevated. This is the whole point.
  // cfg.env carries NARUKAMI's per-spawn extras (e.g. DET_HOOKS_HOME for the
  // embedded godclaude) — merged over this process's own env.
  const proc = spawn('powershell.exe', ['-NoLogo'], {
    name: 'xterm-color',
    cols: cfg.cols || 80,
    rows: cfg.rows || 30,
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env || {}) },
  });

  const socket = net.connect(cfg.port, '127.0.0.1', () => {
    send({ t: 'hello', token: cfg.token, runId: cfg.runId, pid: proc.pid });
  });
  socket.setEncoding('utf8');

  function send(o) {
    try {
      if (!socket.destroyed) socket.write(JSON.stringify(o) + '\n');
    } catch {
      /* noop */
    }
  }

  let exited = false;
  function die(code) {
    if (exited) return;
    exited = true;
    try {
      proc.kill();
    } catch {
      /* noop */
    }
    try {
      socket.end();
    } catch {
      /* noop */
    }
    process.exit(code);
  }

  // Micro-batch pty output (mirrors the backend runner): ConPTY emits many
  // small chunks under load, and each frame costs a base64 encode + JSON parse
  // on both ends. Coalescing for a few ms collapses the frame count without
  // perceptible echo latency. The size cap bounds buffered memory.
  let pendChunks = [];
  let pendChars = 0;
  let pendTimer = null;
  function flushData() {
    if (pendTimer) {
      clearTimeout(pendTimer);
      pendTimer = null;
    }
    if (pendChunks.length === 0) return;
    const joined = pendChunks.length === 1 ? pendChunks[0] : pendChunks.join('');
    pendChunks = [];
    pendChars = 0;
    send({ t: 'data', d: Buffer.from(joined, 'utf8').toString('base64') });
  }
  proc.onData((d) => {
    pendChunks.push(d);
    pendChars += d.length;
    if (pendChars >= 256 * 1024) flushData();
    else if (!pendTimer) pendTimer = setTimeout(flushData, 8);
  });
  proc.onExit(({ exitCode }) => {
    flushData(); // drain buffered output before the exit frame
    send({ t: 'exit', code: exitCode ?? null });
    setTimeout(() => die(0), 50); // let the exit frame flush
  });

  let buf = '';
  socket.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d);
      else if (m.t === 'resize') {
        try {
          proc.resize(m.cols, m.rows);
        } catch {
          /* noop */
        }
      } else if (m.t === 'kill') die(0);
    }
  });

  socket.on('close', () => die(0));
  socket.on('error', () => die(1));
})();
