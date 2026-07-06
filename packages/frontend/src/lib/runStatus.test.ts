import { describe, it, expect } from 'vitest';
import { normalizeStatus } from './runStatus';

describe('normalizeStatus', () => {
  it('maps the known terminal statuses', () => {
    expect(normalizeStatus('killed')).toBe('killed');
    expect(normalizeStatus('error')).toBe('error');
    expect(normalizeStatus('exited')).toBe('exited');
  });

  it('defaults unknown / undefined to exited', () => {
    expect(normalizeStatus('running')).toBe('exited');
    expect(normalizeStatus('whatever')).toBe('exited');
    expect(normalizeStatus(undefined)).toBe('exited');
  });
});
