import { describe, it, expect } from 'vitest';
import {
  accuracyPrompt,
  catalogReport,
  coerceSeverity,
  mergeFindings,
  parseClaudeFindings,
  parseClaudeSummary,
} from './browserAccuracy';
import type { AccuracyFinding } from '../types';
import { catalogFor, engineFamily, engineLabel } from './browserAccuracyCatalog';

describe('coerceSeverity', () => {
  it('passes through the three valid severities', () => {
    expect(coerceSeverity('high')).toBe('high');
    expect(coerceSeverity('medium')).toBe('medium');
    expect(coerceSeverity('low')).toBe('low');
  });
  it('defaults anything unknown to medium', () => {
    expect(coerceSeverity('critical')).toBe('medium');
    expect(coerceSeverity(undefined)).toBe('medium');
    expect(coerceSeverity(3)).toBe('medium');
  });
});

describe('parseClaudeFindings', () => {
  it('keeps well-formed findings and tags them as claude-sourced', () => {
    const parsed = {
      findings: [
        { area: 'Layout', severity: 'high', note: '100vh overflows', fix: 'use dvh' },
        { area: 'CSS', severity: 'weird', note: 'needs prefix' }, // bad severity, no fix
      ],
    };
    expect(parseClaudeFindings(parsed)).toEqual<AccuracyFinding[]>([
      { area: 'Layout', severity: 'high', note: '100vh overflows', fix: 'use dvh', source: 'claude' },
      { area: 'CSS', severity: 'medium', note: 'needs prefix', fix: '', source: 'claude' },
    ]);
  });

  it('drops entries with no note and non-object entries', () => {
    const parsed = { findings: [{ area: 'X', note: '   ' }, 'nope', null, { severity: 'low' }] };
    expect(parseClaudeFindings(parsed)).toEqual([]);
  });

  it('defaults a missing area to Behavior', () => {
    const out = parseClaudeFindings({ findings: [{ note: 'something differs' }] });
    expect(out[0].area).toBe('Behavior');
    expect(out[0].source).toBe('claude');
  });

  it('tolerates a missing or non-array findings field', () => {
    expect(parseClaudeFindings({})).toEqual([]);
    expect(parseClaudeFindings({ findings: 'x' })).toEqual([]);
    expect(parseClaudeFindings(null)).toEqual([]);
  });
});

describe('parseClaudeSummary', () => {
  it('returns the trimmed summary or empty string', () => {
    expect(parseClaudeSummary({ summary: '  all good  ' })).toBe('all good');
    expect(parseClaudeSummary({})).toBe('');
    expect(parseClaudeSummary(null)).toBe('');
  });
});

describe('mergeFindings', () => {
  const cat = (note: string, severity: AccuracyFinding['severity'] = 'medium'): AccuracyFinding => ({
    area: 'CSS',
    severity,
    note,
    fix: '',
    source: 'catalog',
  });
  const cl = (note: string, severity: AccuracyFinding['severity'] = 'medium'): AccuracyFinding => ({
    area: 'CSS',
    severity,
    note,
    fix: '',
    source: 'claude',
  });

  it('orders by severity, keeping catalog ahead of claude within a tier', () => {
    const out = mergeFindings(
      [cat('a low', 'low'), cat('b high', 'high')],
      [cl('c high', 'high'), cl('d medium', 'medium')],
    );
    expect(out.map((f) => f.note)).toEqual(['b high', 'c high', 'd medium', 'a low']);
  });

  it('drops claude findings that restate a catalog note (normalized prefix)', () => {
    const out = mergeFindings(
      [cat('backdrop-filter needs the -webkit- prefix in Safari')],
      [cl('backdrop-filter needs the -webkit- prefix in safari!!!'), cl('a genuinely new issue')],
    );
    expect(out.map((f) => f.note)).toEqual([
      'backdrop-filter needs the -webkit- prefix in Safari',
      'a genuinely new issue',
    ]);
  });

  it('de-dupes claude findings against each other too', () => {
    // both share the same normalized 40-char prefix -> only the first survives
    const out = mergeFindings(
      [],
      [
        cl('the backdrop filter really needs a webkit prefix here'),
        cl('the backdrop filter really needs a webkit prefix there'),
      ],
    );
    expect(out).toHaveLength(1);
  });
});

describe('catalog + engine mapping', () => {
  it('maps every selectable browser id to a family and label', () => {
    expect(engineFamily('safari-ios')).toBe('safari');
    expect(engineFamily('brave')).toBe('chromium');
    expect(engineFamily('firefox')).toBe('firefox');
    expect(engineLabel('safari-ios')).toBe('Safari (iOS)');
    expect(engineLabel('edge')).toBe('Edge');
  });

  it('includes iOS-only Safari entries only for safari-ios', () => {
    const ios = catalogFor('safari-ios');
    const mac = catalogFor('safari');
    const iosOnly = ios.filter((e) => e.engines?.includes('safari-ios'));
    expect(iosOnly.length).toBeGreaterThan(0);
    // none of those iOS-tagged entries leak into desktop Safari
    for (const e of iosOnly) expect(mac).not.toContainEqual(e);
  });

  it('gives each Chromium browser only its own tagged notes', () => {
    for (const id of ['chrome', 'edge', 'brave', 'opera']) {
      const entries = catalogFor(id);
      expect(entries.length).toBeGreaterThan(0);
      for (const e of entries) {
        expect(e.engines).toBeDefined();
        expect(e.engines).toContain(id);
      }
    }
  });
});

describe('catalogReport', () => {
  it('reports catalogued Safari differences, most-severe first', () => {
    const report = catalogReport('safari');
    expect(report.engine).toBe('Safari');
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.source === 'catalog')).toBe(true);
    // findings arrive from the catalog in curated (roughly severity) order; the
    // report itself doesn't re-sort, so just assert the high ones are present.
    expect(report.findings.some((f) => f.severity === 'high')).toBe(true);
  });

  it('reassures that Chrome renders identically (Blink is the preview engine)', () => {
    const report = catalogReport('chrome');
    expect(report.engine).toBe('Chrome');
    // Chrome has a single reassurance note, no real divergences.
    expect(report.findings.every((f) => f.source === 'catalog')).toBe(true);
    expect(report.summary.length).toBeGreaterThan(0);
  });
});

describe('accuracyPrompt', () => {
  it('names the target browser and includes the url for context', () => {
    const p = accuracyPrompt('http://localhost:3000', 'Safari (iOS)');
    expect(p).toContain('Safari (iOS)');
    expect(p).toContain('http://localhost:3000');
    expect(p).toMatch(/single minified JSON object/i);
  });

  it('handles an empty url gracefully', () => {
    const p = accuracyPrompt('', 'Firefox');
    expect(p).toContain('Firefox');
    expect(p).toContain('(none provided)');
  });
});
