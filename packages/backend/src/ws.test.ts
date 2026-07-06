import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the runner so we can assert what handleClientMessage forwards.
vi.mock('./services/runner', () => ({
  attach: vi.fn(),
  getFinalState: vi.fn(),
  resizeRun: vi.fn(),
  writeToRun: vi.fn(),
}));

import { handleClientMessage } from './ws';
import { writeToRun, resizeRun } from './services/runner';

const wt = vi.mocked(writeToRun);
const rs = vi.mocked(resizeRun);

beforeEach(() => {
  wt.mockClear();
  rs.mockClear();
});

describe('handleClientMessage', () => {
  it('forwards input to writeToRun', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 'ls\r' }));
    expect(wt).toHaveBeenCalledWith('run1', 'ls\r');
    expect(rs).not.toHaveBeenCalled();
  });

  it('forwards resize to resizeRun', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    expect(rs).toHaveBeenCalledWith('run1', 120, 40);
    expect(wt).not.toHaveBeenCalled();
  });

  it('accepts a Buffer payload', () => {
    handleClientMessage('run1', Buffer.from(JSON.stringify({ type: 'input', data: 'x' })));
    expect(wt).toHaveBeenCalledWith('run1', 'x');
  });

  it('ignores malformed JSON', () => {
    handleClientMessage('run1', 'not json {');
    expect(wt).not.toHaveBeenCalled();
    expect(rs).not.toHaveBeenCalled();
  });

  it('ignores input without a string data field', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'input' }));
    handleClientMessage('run1', JSON.stringify({ type: 'input', data: 42 }));
    expect(wt).not.toHaveBeenCalled();
  });

  it('ignores resize with non-numeric dimensions', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'resize', cols: '80', rows: 24 }));
    expect(rs).not.toHaveBeenCalled();
  });

  it('ignores unknown message types', () => {
    handleClientMessage('run1', JSON.stringify({ type: 'bogus' }));
    expect(wt).not.toHaveBeenCalled();
    expect(rs).not.toHaveBeenCalled();
  });
});
