#!/usr/bin/env node
// Wires the phone's localhost:4311 to the PC's read-only stats listener on
// 4311, so the PC Stats APK works over USB with nothing on the Wi-Fi at all.
//
//   node packages/mobile/scripts/adb-reverse.mjs [phonePort] [pcPort]
//
// The phone still needs the listener's token (tray → "Copy token"): the stats
// server authenticates every request regardless of how the bytes arrive. This
// only forwards the port — it deliberately does NOT touch the main NARUKAMI
// backend, which stays loopback-only because it hands out its own bearer token.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Both sides default to 4311 — the stats listener's port and the app's default. */
const STATS_PORT = 4311;
const PHONE_PORT = Number(process.argv[2]) || STATS_PORT;
const PC_PORT = Number(process.argv[3]) || Number(process.env.NARUKAMI_STATS_PORT) || STATS_PORT;

/** adb from PATH, ANDROID_HOME, or the toolchain this repo provisions. */
function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.ADB_PATH,
    ...(process.env.ANDROID_HOME ? [path.join(process.env.ANDROID_HOME, 'platform-tools', exe)] : []),
    ...(process.env.ANDROID_SDK_ROOT ? [path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe)] : []),
    path.join(os.homedir(), 'AppData', 'Local', 'narukami-build', 'android-sdk', 'platform-tools', exe),
    path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe),
    path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe),
    path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // last resort: hope it's on PATH
  return exe;
}

const adb = findAdb();

let devices;
try {
  devices = execFileSync(adb, ['devices'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() && !l.includes('offline') && !l.includes('unauthorized'));
} catch {
  console.error(`Could not run adb (${adb}). Install platform-tools, or set ADB_PATH.`);
  process.exit(1);
}

if (!devices.length) {
  console.error(
    'No authorised device. Plug the phone in, enable USB debugging, and accept the prompt on the phone.',
  );
  process.exit(1);
}

execFileSync(adb, ['reverse', `tcp:${PHONE_PORT}`, `tcp:${PC_PORT}`], { stdio: 'inherit' });
console.log(`phone 127.0.0.1:${PHONE_PORT}  ->  PC 127.0.0.1:${PC_PORT}`);
console.log('Start the stats server on the PC (tray -> "Phone server (Wi-Fi)"), then open PC Stats.');
console.log(`The app's default address is http://127.0.0.1:${STATS_PORT}; paste the token from the tray.`);
