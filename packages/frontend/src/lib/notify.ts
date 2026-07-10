import type { ActiveRun, Toast } from '../types';

// Human verb for a terminal run status.
export function statusVerb(status: string): string {
  if (status === 'exited') return 'finished';
  if (status === 'killed') return 'stopped';
  return 'errored';
}

const TERMINAL = new Set(['exited', 'killed', 'error']);

/**
 * Decide whether a run reaching its current status should raise a finish toast,
 * and if so build it. Returns null when it shouldn't fire. Gates:
 *  - status is terminal (exited/killed/error)
 *  - kind is shell or claude (command runs don't notify)
 *  - the run was started THIS session (in `sessionRuns`) — restored/dead-on-
 *    reconnect tabs stay quiet
 *  - not already notified (dedupe)
 * Pure + side-effect free so the caller records the dedupe + enqueues.
 */
export function finishToastFor(
  run: ActiveRun,
  opts: { sessionRuns: Set<string>; notified: Set<string> },
): Toast | null {
  if (!TERMINAL.has(run.status)) return null;
  if (run.kind !== 'shell' && run.kind !== 'claude') return null;
  if (!opts.sessionRuns.has(run.runId)) return null;
  if (opts.notified.has(run.runId)) return null;
  return {
    id: run.runId,
    runId: run.runId,
    projectId: run.projectId,
    projectName: run.projectName,
    label: run.customLabel ?? run.label,
    kind: run.kind,
    status: run.status,
    exitCode: run.exitCode,
    event: 'exit',
  };
}

/**
 * Build a "task done" toast for a still-alive run that just went idle after
 * producing output (Claude finished responding / a shell command returned).
 * `seq` makes the id unique so repeated tasks stack instead of dedupe.
 */
export function taskToast(run: ActiveRun, seq: number): Toast {
  return {
    id: `${run.runId}:task:${seq}`,
    runId: run.runId,
    projectId: run.projectId,
    projectName: run.projectName,
    label: run.customLabel ?? run.label,
    kind: run.kind,
    status: run.status,
    exitCode: run.exitCode,
    event: 'task',
  };
}

/**
 * Whether an in-app toast should actually be shown, given where the user is.
 * Suppressed when they're actively viewing the run's OWN project in a focused,
 * visible window — they can already see it finish, so a toast is just noise.
 * Kept pure so App can unit-test the gate; the native OS notification is a
 * separate path that self-gates on window focus, so a backgrounded finish in
 * the selected project still surfaces there.
 */
export function shouldShowInAppToast(
  t: Toast,
  ctx: { selectedProjectId: string | null; focused: boolean; visible: boolean },
): boolean {
  const viewingHere = ctx.selectedProjectId === t.projectId && ctx.focused && ctx.visible;
  return !viewingHere;
}

/** Title + body text for a toast / native notification, based on its event. */
export function toastText(t: Toast): { title: string; body: string } {
  const title = `${t.projectName} · ${t.label}`;
  if (t.event === 'task') {
    const what = t.kind === 'claude' ? 'Claude finished a task' : 'Command finished';
    return { title, body: `${what} — click to open` };
  }
  const kind = t.kind === 'claude' ? 'Claude' : 'Shell';
  const code = t.exitCode != null ? ` (exit ${t.exitCode})` : '';
  return { title, body: `${kind} ${statusVerb(t.status)}${code} — click to open` };
}

let permissionAsked = false;

// Ask once, quietly, for OS-notification permission. In the packaged Electron
// app this is usually granted already; in the browser it shows a single prompt.
export function primeNotifications(): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default' && !permissionAsked) {
    permissionAsked = true;
    void Notification.requestPermission().catch(() => undefined);
  }
}

// Best-effort native OS notification for a finished run. Only fires when the
// app is NOT focused — when it is, the in-app toast already covers it. Clicking
// focuses the window and routes to the run's tab via `onClick`.
export function fireNativeNotification(t: Toast, onClick: () => void): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'visible' &&
      document.hasFocus()
    ) {
      return;
    }
    const { title, body } = toastText(t);
    const n = new Notification(title, {
      body,
      tag: t.id, // collapse duplicates for the same event
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        /* noop */
      }
      onClick();
      n.close();
    };
  } catch {
    /* noop — notifications are a nicety, never break the app over them */
  }
}
