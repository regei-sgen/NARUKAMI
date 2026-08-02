/**
 * The manifest of tests that SELF-SKIP when the machine has no routable LAN
 * interface, plus the LAN probe they gate themselves on.
 *
 * Why this file exists
 * --------------------
 * Three backend test files do `const maybe = detectLanIp() !== null ? it : it.skip`.
 * On a container with only loopback, every one of them silently turns into a skip
 * and the suite reports GREEN having verified nothing about the LAN relay — the
 * exact false-green a CI gate is supposed to prevent. `check-skips.mjs` reads a
 * vitest JSON report and holds the run to this manifest:
 *
 *   - LAN present  → every one of these must have RUN. A skip is a hard failure.
 *   - LAN absent   → these may be skipped, but the run prints a loud UNVERIFIED
 *                    banner naming each one, and CI (NARUKAMI_REQUIRE_LAN=1) fails.
 *   - Either way   → any skip OUTSIDE this manifest is a hard failure, and any
 *                    manifest entry that no longer appears in the report at all is
 *                    a hard failure (the manifest has drifted from the tests).
 *
 * Keep in sync with the sources listed below. `grep -rn "it.skip" packages/backend/src`
 * finds every gate; each one's tests belong here.
 */
import os from 'node:os';

/**
 * Byte-for-byte the algorithm in packages/backend/src/services/lanRelay.ts
 * `detectLanIp()`. Duplicated rather than imported because that module is
 * TypeScript and this script must run under bare node in CI before any build.
 * If the source predicate changes, change it here too — `check-skips.mjs`
 * cross-checks the two by refusing to accept a skip while a LAN is detected.
 */
export function detectLanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue; // link-local, not routable
      candidates.push(a.address);
    }
  }
  const isPrivate = (ip) =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? null;
}

/** Every test gated behind `detectLanIp() !== null`. Matched on file + title. */
export const LAN_GATED_TESTS = [
  {
    file: 'src/services/lanRelay.test.ts',
    title: 'forwards HTTP from the LAN address to the loopback origin',
  },
  {
    file: 'src/services/lanRelay.test.ts',
    title: 'start is idempotent — a second call returns the same address',
  },
  {
    file: 'src/services/lanRelay.test.ts',
    title: 'stop severs LAN reachability (connection refused after stop)',
  },
  {
    file: 'src/mobileShareAuth.test.ts',
    title: 'accepts the exact LAN IP ONLY while the relay is active',
  },
  {
    file: 'src/mobileShareAuth.test.ts',
    title: 're-rejects the LAN IP after the relay stops',
  },
  {
    file: 'src/auth.test.ts',
    title: 'a real LAN relay client forging Host: 127.0.0.1 gets the tokenless page',
  },
];
