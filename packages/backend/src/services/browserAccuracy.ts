// Cross-browser accuracy advisor. The Browser view previews web apps in an
// embedded Chromium (Blink) webview, so Safari (WebKit) and Firefox (Gecko) can
// only be emulated by User-Agent — the pixels are always Blink's. This service
// makes that honest and useful: it reports exactly where the real target browser
// would diverge, combining a curated offline catalog (instant grounding) with
// project-specific findings from Claude Code inspecting the actual source.

import type { AccuracyFinding, AccuracyReport } from '../types';
import {
  AnalyzerError,
  extractJsonObject,
  isRecord,
  runClaude,
  unwrapEnvelope,
} from './analyzer';
import { catalogFor, engineLabel, type CatalogEntry, type Severity } from './browserAccuracyCatalog';

const SEVERITIES: Severity[] = ['high', 'medium', 'low'];
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export function coerceSeverity(value: unknown): Severity {
  return typeof value === 'string' && (SEVERITIES as string[]).includes(value)
    ? (value as Severity)
    : 'medium';
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// The prompt Claude runs (headless, in the project's cwd). It inspects the real
// source for hazards specific to the target engine and returns strict JSON.
export function accuracyPrompt(url: string, engineName: string): string {
  return `You are reviewing the web project in the current working directory for CROSS-BROWSER RENDERING ACCURACY.

The developer previews this app in an embedded Chromium (Blink) view, but the target browser is ${engineName}. Chromium and ${engineName} differ in real, well-documented ways. Inspect the project's ACTUAL source — stylesheets (*.css/*.scss/*.less), Tailwind/PostCSS config, styled-components / CSS-in-JS, and JSX/TSX/HTML — and identify concrete places where the layout or behavior in ${engineName} will DIFFER from what the Chromium preview shows.

Preview URL for context (do not fetch it): ${url || '(none provided)'}

Only report issues that are actually present or clearly likely in THIS codebase. Skip generic advice that does not apply. Favor high-impact layout/behavior breaks. Consider engine-specific hazards such as: viewport units (100vh vs dvh/svh on iOS), -webkit-/-moz- prefixes still required (backdrop-filter, background-clip:text, mask, appearance), native form controls, scroll behavior (overscroll-behavior, scroll-snap, -webkit-overflow-scrolling), :focus-visible/focus rings, sticky positioning, font smoothing, input auto-zoom on iOS (<16px fonts), scrollbar styling, and features that shipped later in the target engine.

Respond with ONLY a single minified JSON object, no prose, no markdown fences, matching exactly:
{"summary":"one factual sentence on overall accuracy","findings":[{"area":"Layout|CSS|Forms|Scrolling|Typography|Media|Behavior|JS-API","severity":"high|medium|low","note":"what will look/behave differently in ${engineName} vs the Chromium preview, referencing the specific code/file where possible","fix":"the concrete change to make it match, or empty string"}]}

Rules:
- Order findings most-severe first. At most 8 findings.
- If the project looks fully compatible, return an empty findings array and say so in the summary.
- Output the JSON object only.`;
}

// Turn a catalog entry into a report finding.
function fromCatalog(entry: CatalogEntry): AccuracyFinding {
  return {
    area: entry.area,
    severity: entry.severity,
    note: entry.note,
    fix: entry.fix,
    source: 'catalog',
  };
}

// Parse the `findings` array Claude returned into sanitized findings.
export function parseClaudeFindings(parsed: unknown): AccuracyFinding[] {
  const obj = isRecord(parsed) ? parsed : {};
  const raw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: AccuracyFinding[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const note = str(item.note);
    if (!note) continue; // a finding with nothing to say is noise
    findings.push({
      area: str(item.area) || 'Behavior',
      severity: coerceSeverity(item.severity),
      note,
      fix: str(item.fix),
      source: 'claude',
    });
  }
  return findings;
}

export function parseClaudeSummary(parsed: unknown): string {
  const obj = isRecord(parsed) ? parsed : {};
  return str(obj.summary);
}

// Collapse near-duplicate notes (Claude often restates a catalog item). Two
// findings are "the same" if their notes share a strong normalized prefix.
function normNote(note: string): string {
  return note
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

// Merge catalog grounding with Claude's project-specific findings: catalog first
// (reliable baseline), then Claude findings that aren't restatements, all sorted
// by severity while keeping catalog ahead of Claude within a severity tier.
export function mergeFindings(
  catalog: AccuracyFinding[],
  claude: AccuracyFinding[],
): AccuracyFinding[] {
  const seen = new Set(catalog.map((f) => normNote(f.note)));
  const extra = claude.filter((f) => {
    const key = normNote(f.note);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const all = [...catalog, ...extra];
  // Stable sort by severity; ties keep insertion order (catalog before claude).
  return all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || a.i - b.i)
    .map(({ f }) => f);
}

/** The offline, catalog-only report for an engine (no Claude call). */
export function catalogReport(engineId: string, summary?: string): AccuracyReport {
  const findings = catalogFor(engineId).map(fromCatalog);
  const name = engineLabel(engineId);
  return {
    engine: name,
    summary:
      summary ??
      (findings.length
        ? `Built-in reference: ${findings.length} known ${name} difference${findings.length === 1 ? '' : 's'} vs. the Chromium preview.`
        : `No catalogued rendering differences — ${name} is Blink-based, so it renders identically to this preview.`),
    findings,
  };
}

/**
 * Full accuracy check: run Claude over the project for engine-specific hazards,
 * then merge with the curated catalog. Throws AnalyzerError if the `claude` CLI
 * is missing/fails (the route falls back to catalogReport).
 */
export async function checkBrowserAccuracy(
  projectPath: string,
  url: string,
  engineId: string,
): Promise<AccuracyReport> {
  const name = engineLabel(engineId);
  const stdout = await runClaude(accuracyPrompt(url, name), projectPath);
  const inner = unwrapEnvelope(stdout);
  const jsonText = extractJsonObject(inner);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AnalyzerError('Could not parse the accuracy report returned by Claude Code.', inner);
  }

  const catalog = catalogFor(engineId).map(fromCatalog);
  const claude = parseClaudeFindings(parsed);
  const findings = mergeFindings(catalog, claude);
  const claudeSummary = parseClaudeSummary(parsed);

  return {
    engine: name,
    summary:
      claudeSummary ||
      `Checked this project for ${name} rendering differences vs. the Chromium preview.`,
    findings,
  };
}
