// Shared helpers for the Argus Panoptes monitor. Pure, no I/O.

// The kami display layer: canonical god-mode id → Shinto kami pseudonym
// (see docs: kami-archetypes — the Yaoyorozu no Kami roster). This is ADDITIVE
// decoration only — the canonical id is what the god layer persists and what
// every parser keys on. `general` = the base contract (Amaterasu).
export const KAMI: Record<string, string> = {
  developer: 'Mahitotsu',
  researcher: 'Kuebiko',
  'data-analyst': 'Tsukuyomi',
  qa: 'Enma',
  reviewer: 'Susanoo',
  planner: 'Omoikane',
  'ci-cd': 'Sarutahiko',
  'web-builder': 'Uzume',
  general: 'Amaterasu',
};

export function godName(mode: string | undefined | null): string {
  if (!mode) return '';
  return KAMI[mode] ?? '';
}

/** Human age from a millisecond duration. -1 (unknown) → "—". */
export function fmtAge(ms: number): string {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/** Countdown to a unix-epoch-SECONDS reset time, relative to now. */
export function fmtCountdown(resetsAtSec: number | undefined, nowMs: number = Date.now()): string {
  if (!resetsAtSec) return '';
  const ms = resetsAtSec * 1000 - nowMs;
  if (ms <= 0) return 'resetting…';
  return `resets in ${fmtAge(ms)}`;
}

/** Semantic threshold class for a usage/percentage: green<50, amber 50–79, red≥80. */
export function pctLevel(pct: number | undefined): 'ok' | 'warn' | 'crit' {
  const p = pct ?? 0;
  if (p >= 80) return 'crit';
  if (p >= 50) return 'warn';
  return 'ok';
}

export function fmtNum(n: number | undefined): string {
  if (n == null) return '0';
  return n.toLocaleString();
}
