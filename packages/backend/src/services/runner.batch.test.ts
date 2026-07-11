import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// registerRun's exit path persists via prisma — stub it so these tests stay
// pure timer/fan-out tests with no real DB.
vi.mock('../db', () => ({
  prisma: {
    runLog: { create: vi.fn().mockResolvedValue({}) },
    run: { update: vi.fn().mockResolvedValue({}) },
  },
}));

import {
  registerRun,
  attach,
  getLiveTranscript,
  type RunTransport,
  type RunnerEvent,
} from './runner';

/** A scriptable RunTransport: tests drive onData/onExit by hand. */
function fakeTransport(): {
  transport: RunTransport;
  emit: (chunk: string) => void;
  exit: (code: number | null) => void;
} {
  let dataCb: ((chunk: string) => void) | null = null;
  let exitCb: ((info: { exitCode: number | null }) => void) | null = null;
  return {
    transport: {
      pid: 4242,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
    },
    emit: (chunk) => dataCb?.(chunk),
    exit: (code) => exitCb?.({ exitCode: code }),
  };
}

let seq = 0;
const nextId = () => `batch-test-${++seq}`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pty output micro-batching', () => {
  it('coalesces a burst of chunks into one subscriber event after the batch window', () => {
    const { transport, emit } = fakeTransport();
    const runId = nextId();
    registerRun(runId, transport);

    const events: RunnerEvent[] = [];
    const att = attach(runId, (e) => events.push(e));
    expect(att).not.toBeNull();
    expect(att!.backlog).toBe('');

    emit('a');
    emit('b');
    emit('c');
    // Nothing fans out synchronously — the batch window is still open.
    expect(events).toHaveLength(0);

    vi.advanceTimersByTime(8);
    expect(events).toEqual([{ type: 'data', chunk: 'abc' }]);
  });

  it('attach() folds pending bytes into the backlog with no later duplicate', () => {
    const { transport, emit } = fakeTransport();
    const runId = nextId();
    registerRun(runId, transport);

    emit('early ');
    emit('bytes');

    const events: RunnerEvent[] = [];
    const att = attach(runId, (e) => events.push(e));
    // The un-flushed batch is visible in the snapshot immediately...
    expect(att!.backlog).toBe('early bytes');

    // ...and does NOT arrive a second time when the timer would have fired.
    vi.advanceTimersByTime(20);
    expect(events).toHaveLength(0);
  });

  it('flushes immediately when the buffered size crosses the cap', () => {
    const { transport, emit } = fakeTransport();
    const runId = nextId();
    registerRun(runId, transport);

    const events: RunnerEvent[] = [];
    attach(runId, (e) => events.push(e));

    const big = 'x'.repeat(256 * 1024);
    emit(big);
    // No timer advance needed — the size cap forces a synchronous flush.
    expect(events).toEqual([{ type: 'data', chunk: big }]);
  });

  it('drains buffered output before the exit event (no tail loss, right order)', () => {
    const { transport, emit, exit } = fakeTransport();
    const runId = nextId();
    registerRun(runId, transport);

    const events: RunnerEvent[] = [];
    attach(runId, (e) => events.push(e));

    emit('last words');
    exit(0);

    expect(events).toEqual([
      { type: 'data', chunk: 'last words' },
      { type: 'exit', status: 'exited', exitCode: 0 },
    ]);
  });

  it('getLiveTranscript sees micro-batched bytes without waiting for the timer', () => {
    const { transport, emit } = fakeTransport();
    const runId = nextId();
    registerRun(runId, transport);

    emit('fresh');
    expect(getLiveTranscript(runId)).toBe('fresh');
  });
});
