import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Locate the master token file the backend authenticates against — the same
 * resolution config.ts uses (RUNNER_TOKEN_FILE, else <repoRoot>/.runner-token).
 * The repo root is found by walking up from the Vite root, so it does not matter
 * whether the build was started in packages/frontend or at the workspace root.
 * Returns null when there is no token on this machine (CI, a fresh clone).
 */
function findTokenFile(startDir: string): string | null {
  const explicit = process.env.RUNNER_TOKEN_FILE;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, '.runner-token');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Every file under `dir`, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Build-time tripwire for the master token.
 *
 * api.ts reads VITE_RUNNER_TOKEN only behind `import.meta.env.DEV`, so `vite
 * build` tree-shakes it out. Unguarded, Vite inlines the REAL secret from
 * packages/frontend/.env as a string literal — and this bundle ships inside the
 * installer AND is what the LAN stats listener serves to a phone, so the leak is
 * remotely readable by anyone who can reach the listener. That guarantee rested
 * on a single source line with nothing watching it; this plugin fails the build
 * if the secret ever reappears in an emitted asset.
 *
 * Scans what was actually WRITTEN (closeBundle, not generateBundle) so files
 * copied from public/ are covered too. Build-only — never runs on dev serve,
 * where the token is supposed to be present.
 */
function tokenLeakGuard(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'narukami-token-leak-guard',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const tokenFile = findTokenFile(config.root);
      // No token file: nothing to leak, and a missing one must never fail a
      // build (CI and fresh clones have none until `npm run token` runs).
      if (!tokenFile) return;

      let token = '';
      try {
        token = fs.readFileSync(tokenFile, 'utf8').trim();
      } catch {
        return; // unreadable — treat exactly like absent
      }
      // gen-token.mjs writes 64 hex chars. Anything short is a placeholder and
      // would match half the bundle by accident.
      if (token.length < 32) return;

      const outDir = path.resolve(config.root, config.build.outDir);
      let files: string[];
      try {
        files = walk(outDir);
      } catch {
        return; // no output directory (a build that emitted nothing)
      }

      const needle = Buffer.from(token, 'utf8');
      const leaked = files.filter((f) => fs.readFileSync(f).includes(needle));
      if (leaked.length > 0) {
        throw new Error(
          `[token-leak-guard] The master runner token (${path.relative(process.cwd(), tokenFile)}) ` +
            `was inlined into ${leaked.length} emitted asset(s):\n` +
            leaked.map((f) => `  - ${path.relative(outDir, f)}`).join('\n') +
            `\nThis bundle ships in the installer and is served to phones by the LAN stats ` +
            `listener. Guard every env read of the token with \`import.meta.env.DEV\` ` +
            `(see src/api.ts) so \`vite build\` tree-shakes it out.`,
        );
      }
    },
  };
}

// Dev server bound to localhost only, on the fixed port the backend allow-lists.
export default defineConfig({
  plugins: [react(), tokenLeakGuard()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});
