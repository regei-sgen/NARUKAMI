import { describe, it, expect } from 'vitest';
import { finishToastFor, shouldShowInAppToast, statusVerb, taskToast, toastText } from './notify';
import type { ActiveRun, RunStatus } from '../types';

function run(over: Partial<ActiveRun> = {}): ActiveRun {
  return {
    runId: 'r1',
    projectId: 'p1',
    projectName: 'NARUKAMI',
    label: 'shell',
    kind: 'shell',
    status: 'exited',
    exitCode: 0,
    ...over,
  };
}

describe('statusVerb', () => {
  it('maps terminal statuses to verbs', () => {
    expect(statusVerb('exited')).toBe('finished');
    expect(statusVerb('killed')).toBe('stopped');
    expect(statusVerb('error')).toBe('errored');
  });
});

describe('finishToastFor', () => {
  const session = () => new Set(['r1']);
  const none = () => new Set<string>();

  it('builds a toast for a session-started shell that exited', () => {
    const t = finishToastFor(run(), { sessionRuns: session(), notified: none() });
    expect(t).not.toBeNull();
    expect(t).toMatchObject({
      id: 'r1',
      runId: 'r1',
      projectId: 'p1',
      projectName: 'NARUKAMI',
      label: 'shell',
      kind: 'shell',
      status: 'exited',
      exitCode: 0,
    });
  });

  it('fires for claude killed/error too', () => {
    expect(finishToastFor(run({ kind: 'claude', status: 'killed' }), { sessionRuns: session(), notified: none() })).not.toBeNull();
    expect(finishToastFor(run({ kind: 'claude', status: 'error', exitCode: null }), { sessionRuns: session(), notified: none() })).not.toBeNull();
  });

  it('uses customLabel over label when present', () => {
    const t = finishToastFor(run({ customLabel: 'my build' }), { sessionRuns: session(), notified: none() });
    expect(t?.label).toBe('my build');
  });

  it('does NOT fire while still running/connecting', () => {
    for (const status of ['running', 'connecting'] as RunStatus[]) {
      expect(finishToastFor(run({ status }), { sessionRuns: session(), notified: none() })).toBeNull();
    }
  });

  it('does NOT fire for command kind (only shell/claude)', () => {
    expect(finishToastFor(run({ kind: 'command', label: 'dev' }), { sessionRuns: session(), notified: none() })).toBeNull();
  });

  it('does NOT fire for a run not started this session (restored / dead-on-reconnect)', () => {
    expect(finishToastFor(run(), { sessionRuns: none(), notified: none() })).toBeNull();
  });

  it('does NOT fire twice (dedupe via notified set)', () => {
    expect(finishToastFor(run(), { sessionRuns: session(), notified: new Set(['r1']) })).toBeNull();
  });

  it('marks finish toasts with event "exit"', () => {
    const t = finishToastFor(run(), { sessionRuns: session(), notified: none() });
    expect(t?.event).toBe('exit');
  });
});

describe('taskToast', () => {
  it('builds a task-event toast with a seq-unique id', () => {
    const a = taskToast(run({ kind: 'claude', status: 'running' }), 1);
    const b = taskToast(run({ kind: 'claude', status: 'running' }), 2);
    expect(a.event).toBe('task');
    expect(a.id).not.toBe(b.id); // repeated tasks stack, not dedupe
    expect(a.runId).toBe('r1');
  });

  it('uses customLabel when present', () => {
    expect(taskToast(run({ customLabel: 'agent-1' }), 1).label).toBe('agent-1');
  });
});

describe('shouldShowInAppToast', () => {
  // p1 is the run's project (see run() default). A focused, visible window.
  const here = { selectedProjectId: 'p1', focused: true, visible: true };
  const t = taskToast(run({ kind: 'claude', status: 'running' }), 1);

  it('suppresses when viewing the run\'s own project in a focused window', () => {
    expect(shouldShowInAppToast(t, here)).toBe(false);
  });

  it('shows when a DIFFERENT project is selected', () => {
    expect(shouldShowInAppToast(t, { ...here, selectedProjectId: 'p2' })).toBe(true);
  });

  it('shows when no project is selected', () => {
    expect(shouldShowInAppToast(t, { ...here, selectedProjectId: null })).toBe(true);
  });

  it('shows when the window is not focused (so a backgrounded finish is queued)', () => {
    expect(shouldShowInAppToast(t, { ...here, focused: false })).toBe(true);
  });

  it('shows when the tab is hidden (visibilityState !== visible)', () => {
    expect(shouldShowInAppToast(t, { ...here, visible: false })).toBe(true);
  });
});

describe('toastText', () => {
  it('describes a Claude task completion', () => {
    const { body } = toastText(taskToast(run({ kind: 'claude', status: 'running' }), 1));
    expect(body).toBe('Claude finished a task — click to open');
  });

  it('describes a shell/command task completion', () => {
    const { body } = toastText(taskToast(run({ kind: 'shell', status: 'running' }), 1));
    expect(body).toBe('Command finished — click to open');
  });

  it('describes a process exit with code', () => {
    const t = finishToastFor(run({ status: 'killed', exitCode: 137 }), {
      sessionRuns: new Set(['r1']),
      notified: new Set<string>(),
    });
    expect(toastText(t!).body).toBe('Shell stopped (exit 137) — click to open');
  });

  it('title is project · label', () => {
    expect(toastText(taskToast(run(), 1)).title).toBe('NARUKAMI · shell');
  });
});
