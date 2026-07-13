import { describe, it, expect } from 'vitest';
import { nextReconnectAction } from './reconnect';

describe('nextReconnectAction', () => {
  it('reconnects when the pty is still live (the common case: transient drop)', () => {
    expect(nextReconnectAction({ live: true, status: 'running', exitCode: null }, 0, 40)).toEqual({
      kind: 'reconnect',
    });
    // Live wins even if the persisted status looks odd or attempts are high.
    expect(nextReconnectAction({ live: true, status: 'exited', exitCode: 0 }, 39, 40)).toEqual({
      kind: 'reconnect',
    });
  });

  it('settles on the real terminal status when the run actually ended', () => {
    expect(nextReconnectAction({ live: false, status: 'exited', exitCode: 0 }, 2, 40)).toEqual({
      kind: 'settle',
      status: 'exited',
      exitCode: 0,
    });
    expect(nextReconnectAction({ live: false, status: 'killed', exitCode: 137 }, 2, 40)).toEqual({
      kind: 'settle',
      status: 'killed',
      exitCode: 137,
    });
    expect(nextReconnectAction({ live: false, status: 'error', exitCode: null }, 2, 40)).toEqual({
      kind: 'settle',
      status: 'error',
      exitCode: null,
    });
  });

  it('retries while the run is not-yet-live but not conclusively ended', () => {
    // Backend still coming up / stale 'running' row — must not be mistaken for an exit.
    expect(nextReconnectAction({ live: false, status: 'running', exitCode: null }, 0, 40)).toEqual({
      kind: 'retry',
    });
    expect(nextReconnectAction({ live: false, status: 'connecting', exitCode: null }, 10, 40)).toEqual(
      { kind: 'retry' },
    );
  });

  it('gives up only after exhausting the attempt cap', () => {
    expect(nextReconnectAction({ live: false, status: 'running', exitCode: null }, 39, 40)).toEqual({
      kind: 'retry',
    });
    expect(nextReconnectAction({ live: false, status: 'running', exitCode: null }, 40, 40)).toEqual({
      kind: 'giveup',
    });
  });
});
