import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalTab } from './TerminalTab';
import { api } from '../api';
import type { ActiveRun } from '../types';

// xterm paints to a canvas/WebGL surface jsdom does not implement, so the real
// Terminal cannot mount here. The stand-in keeps exactly the surface TerminalTab
// touches (grid size, addons, the onData disposable) — enough for the component
// to run its effect end to end while the assertions stay on the toolbar.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    open(): void {}
    write(): void {}
    reset(): void {}
    resize(): void {}
    clearSelection(): void {}
    hasSelection(): boolean {
      return false;
    }
    getSelection(): string {
      return '';
    }
    onData(): { dispose: () => void } {
      return { dispose: () => undefined };
    }
    dispose(): void {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  },
}));

vi.mock('../api', () => ({
  api: {
    getRun: vi.fn().mockResolvedValue({ id: 'r1', status: 'exited', exitCode: 1, live: false }),
    godSessionState: vi.fn().mockResolvedValue({ installed: false, active: false, modes: [] }),
    godArmSession: vi.fn(),
    stopRun: vi.fn().mockResolvedValue({ ok: true, stopped: true }),
    openUrl: vi.fn(),
    diagnoseRun: vi.fn(),
  },
  runWsUrl: () => 'ws://127.0.0.1:4000/ws/runs/r1',
}));

// The component opens a socket and observes its container as soon as the
// deferred rAF fires; neither exists in jsdom.
class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void {}
}

const FAILED: ActiveRun = {
  runId: 'r1',
  projectId: 'p1',
  projectName: 'demo',
  label: 'build',
  kind: 'command',
  status: 'exited',
  exitCode: 1,
};

function renderTab(run: ActiveRun) {
  return render(
    <TerminalTab run={run} onStatus={vi.fn()} onRestart={vi.fn()} />,
  );
}

const explainButton = () => screen.queryByRole('button', { name: /explain/i });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TerminalTab — explain this failure', () => {
  it('offers no explain action while the run is still going', () => {
    renderTab({ ...FAILED, status: 'running', exitCode: null });
    expect(explainButton()).not.toBeInTheDocument();
  });

  it('offers no explain action for a clean (exit 0) run', () => {
    renderTab({ ...FAILED, exitCode: 0 });
    expect(explainButton()).not.toBeInTheDocument();
  });

  it('offers an enabled explain action once the run exited non-zero', () => {
    renderTab(FAILED);
    const btn = explainButton();
    expect(btn).toBeInTheDocument();
    expect(btn).toBeEnabled();
  });

  it('asks the backend once and renders the explanation', async () => {
    vi.mocked(api.diagnoseRun).mockResolvedValue({
      explanation: 'The build failed because tsconfig.json is missing.',
    });
    renderTab(FAILED);
    fireEvent.click(explainButton()!);

    expect(
      await screen.findByText('The build failed because tsconfig.json is missing.'),
    ).toBeInTheDocument();
    expect(api.diagnoseRun).toHaveBeenCalledTimes(1);
    expect(api.diagnoseRun).toHaveBeenCalledWith('r1');
  });

  it('shows a pending state and refuses a second submit while in flight', async () => {
    let settle!: (v: { explanation: string }) => void;
    vi.mocked(api.diagnoseRun).mockReturnValue(
      new Promise<{ explanation: string }>((res) => {
        settle = res;
      }),
    );
    renderTab(FAILED);
    fireEvent.click(explainButton()!);

    await waitFor(() => expect(explainButton()).toBeDisabled());
    // A second click on the pending action must not fire a second request.
    fireEvent.click(explainButton()!);
    expect(api.diagnoseRun).toHaveBeenCalledTimes(1);

    settle({ explanation: 'done' });
    expect(await screen.findByText('done')).toBeInTheDocument();
    await waitFor(() => expect(explainButton()).toBeEnabled());
  });

  it('surfaces a 502 (model call failed) as an error the user can read', async () => {
    // api.request turns the 502 body's `error` into the thrown message.
    vi.mocked(api.diagnoseRun).mockRejectedValue(new Error('claude -p exited 1'));
    renderTab(FAILED);
    fireEvent.click(explainButton()!);

    expect(await screen.findByText('claude -p exited 1')).toBeInTheDocument();
    await waitFor(() => expect(explainButton()).toBeEnabled());
  });
});
