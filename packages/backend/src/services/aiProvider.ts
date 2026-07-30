import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { REPO_ROOT } from '../config';
import { godHome, isProvisioned } from './godclaude';
import { getBaseUrl } from './serverInfo';

/**
 * Which credential NARUKAMI hands to the `claude` processes it spawns.
 *
 * - 'claude-code' (DEFAULT): inject nothing. Every Claude launch authenticates
 *   exactly the way it does today — with the CLI's own signed-in credential
 *   (`claude /login`, i.e. the Pro/Max/Team subscription or Console account).
 * - 'api-key': inject ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) into
 *   the spawn env, so the session bills to that Console API key instead.
 *
 * Per the Claude Code auth-precedence docs, ANTHROPIC_API_KEY is sent as the
 * `X-Api-Key` header and outranks the subscription login; in headless mode
 * (`claude -p`) it is always used when present, while an INTERACTIVE session
 * prompts once to approve the key and remembers the answer.
 */
export type AiProvider = 'claude-code' | 'api-key';

export interface AiConfig {
  provider: AiProvider;
  /** SECRET. Stays server-side — never serialized to the UI (see publicAiConfig). */
  apiKey: string;
  /** Optional custom endpoint (an LLM gateway / proxy). '' = Anthropic default. */
  baseUrl: string;
  /** `/effort <level>` typed into every fresh Claude tab. */
  defaultEffort: string;
}

/**
 * `ultracode` = xhigh + dynamic workflow fan-out. Kept as the shipped default so
 * this setting starts life matching the previous hard-coded behaviour exactly.
 */
export const DEFAULT_EFFORT = 'ultracode';

export const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'claude-code',
  apiKey: '',
  baseUrl: '',
  defaultEffort: DEFAULT_EFFORT,
};

/** AppSetting key holding the AI config (JSON object value). */
export const AI_SETTING_KEY = 'aiProvider';

/** Anthropic credential vars the BACKEND's own environment may already carry.
 *  cleanEnv() passes these through to every spawn, so they can silently outrank
 *  a 'claude-code' selection — the UI surfaces them rather than hiding it. */
const INHERITED_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/** A rejected settings write — surfaced to the UI as a 400, not a 500. */
export class SettingsError extends Error {}

// ── validation ───────────────────────────────────────────────────────────────

// Anything that could break out of a single env-var value, plus a sane ceiling.
// Deliberately NOT an `sk-ant-` shape check: gateway/proxy keys are legitimate.
/** True if `s` holds whitespace or a control character — never valid in an env value. */
function hasControlOrSpace(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}
const MAX_KEY_CHARS = 512;

/** Trim + reject an unusable API key. '' means "no key". */
export function sanitizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const key = raw.trim();
  if (!key) return '';
  if (hasControlOrSpace(key)) {
    throw new SettingsError('The API key cannot contain spaces, tabs, or line breaks.');
  }
  if (key.length > MAX_KEY_CHARS) {
    throw new SettingsError(`The API key is too long (max ${MAX_KEY_CHARS} characters).`);
  }
  return key;
}

/** Trim + validate an optional custom endpoint. '' means "Anthropic default". */
export function sanitizeBaseUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const url = raw.trim();
  if (!url) return '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SettingsError('The base URL must be a full URL, e.g. https://gateway.example.com.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SettingsError('The base URL must start with http:// or https://.');
  }
  return url.replace(/\/+$/, '');
}

/** `/effort` is typed into the TUI as a slash-command arg — word chars only. */
export function sanitizeEffort(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_EFFORT;
  const effort = raw.trim();
  return /^[a-zA-Z0-9-]{1,32}$/.test(effort) ? effort : DEFAULT_EFFORT;
}

/**
 * A non-reversible preview of a stored key — enough to recognise WHICH key is
 * saved, never enough to use it. The full value never leaves the backend.
 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length < 12) return '••••••••';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

// ── store (DB-backed, with a sync cache for the pty spawn path) ──────────────

// startClaude() is synchronous, so it can't await a DB read on every launch.
// The config is primed at boot and re-primed on every write, so the cache is
// only ever stale if another process edits the row directly.
let cache: AiConfig = { ...DEFAULT_AI_CONFIG };

function coerce(value: unknown): AiConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_AI_CONFIG };
  const o = value as Record<string, unknown>;
  return {
    provider: o.provider === 'api-key' ? 'api-key' : 'claude-code',
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
    defaultEffort: sanitizeEffort(o.defaultEffort),
  };
}

/** Read the stored config from the DB into the cache. Best-effort: a DB hiccup
 *  must never stop a Claude launch — it just falls back to the default (login). */
export async function loadAiConfig(): Promise<AiConfig> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: AI_SETTING_KEY } });
    cache = row ? coerce(JSON.parse(row.value)) : { ...DEFAULT_AI_CONFIG };
  } catch {
    cache = { ...DEFAULT_AI_CONFIG };
  }
  return cache;
}

/** The last-loaded config. Sync — safe to call from the pty spawn path. */
export function cachedAiConfig(): AiConfig {
  return cache;
}

/** Overwrite the cache directly (tests + the write path). */
export function setCachedAiConfig(cfg: AiConfig): void {
  cache = cfg;
}

/**
 * Apply a partial update and persist it. Patch semantics on the secret:
 * `apiKey: undefined` KEEPS the stored key (so the provider can be switched
 * without re-typing it); `apiKey: ''` clears it.
 */
export async function writeAiConfig(patch: {
  provider?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  defaultEffort?: unknown;
}): Promise<AiConfig> {
  const current = await loadAiConfig();

  const next: AiConfig = {
    provider: patch.provider === undefined ? current.provider : patch.provider === 'api-key' ? 'api-key' : 'claude-code',
    apiKey: patch.apiKey === undefined ? current.apiKey : sanitizeApiKey(patch.apiKey),
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : sanitizeBaseUrl(patch.baseUrl),
    defaultEffort:
      patch.defaultEffort === undefined ? current.defaultEffort : sanitizeEffort(patch.defaultEffort),
  };

  // Fail closed: selecting API-key mode with no key would silently fall back to
  // the login, so the UI would claim a provider that isn't in use.
  if (next.provider === 'api-key' && !next.apiKey) {
    throw new SettingsError('Add an API key before switching to API-key mode.');
  }

  await prisma.appSetting.upsert({
    where: { key: AI_SETTING_KEY },
    update: { value: JSON.stringify(next) },
    create: { key: AI_SETTING_KEY, value: JSON.stringify(next) },
  });
  cache = next;
  return next;
}

// ── spawn env ────────────────────────────────────────────────────────────────

/**
 * Env overlay for a `claude` process (interactive tab or headless `claude -p`).
 * Empty in the default 'claude-code' mode, so a NARUKAMI session authenticates
 * exactly as it does today.
 *
 * Applied ONLY to Claude launches — never to project commands or plain shells,
 * which are untrusted and have no business seeing the key.
 */
export function claudeSpawnEnv(cfg: AiConfig = cache): Record<string, string> {
  if (cfg.provider !== 'api-key' || !cfg.apiKey) return {};
  const env: Record<string, string> = { ANTHROPIC_API_KEY: cfg.apiKey };
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
  return env;
}

// ── public projection ────────────────────────────────────────────────────────

export interface PublicAiConfig {
  provider: AiProvider;
  hasKey: boolean;
  /** Masked preview of the stored key ('' when none) — never the key itself. */
  keyPreview: string;
  baseUrl: string;
  defaultEffort: string;
  /** Anthropic credential vars present in the BACKEND's own environment. */
  inheritedAuthVars: string[];
  /** What a Claude launch will actually authenticate with, right now. */
  effective: 'api-key' | 'inherited-env' | 'claude-code-login';
}

/** The config as the UI is allowed to see it — secret replaced by a preview. */
export function publicAiConfig(
  cfg: AiConfig = cache,
  env: NodeJS.ProcessEnv = process.env,
): PublicAiConfig {
  const inherited = INHERITED_AUTH_VARS.filter((name) => Boolean(env[name]?.trim()));
  const usingKey = cfg.provider === 'api-key' && Boolean(cfg.apiKey);
  return {
    provider: cfg.provider,
    hasKey: Boolean(cfg.apiKey),
    keyPreview: maskKey(cfg.apiKey),
    baseUrl: cfg.baseUrl,
    defaultEffort: cfg.defaultEffort,
    inheritedAuthVars: [...inherited],
    // Our injected key wins (it's applied last over cleanEnv). Otherwise an
    // inherited var still outranks the CLI login — say so instead of implying
    // the subscription is in use.
    effective: usingKey ? 'api-key' : inherited.length > 0 ? 'inherited-env' : 'claude-code-login',
  };
}

// ── diagnostics (read-only "About" block) ────────────────────────────────────

export interface AboutInfo {
  version: string | null;
  platform: string;
  arch: string;
  node: string;
  /** The backend's own reachable origin, once it has bound a port. */
  backendUrl: string | null;
  /** NARUKAMI's embedded GODCLAUDE home + whether it is installed. */
  godHome: string;
  godInstalled: boolean;
  /** SQLite file backing the app (from DATABASE_URL). */
  database: string | null;
}

function readVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function aboutInfo(): AboutInfo {
  // DATABASE_URL is a file: URL — show the path, and never a query string (it
  // can carry connection params we don't want echoed into the UI).
  const raw = process.env.DATABASE_URL ?? '';
  const database = raw ? raw.replace(/^file:/, '').split('?')[0] : null;
  return {
    version: readVersion(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    backendUrl: getBaseUrl(),
    godHome: godHome(),
    godInstalled: isProvisioned(),
    database,
  };
}
