import type { ShellKind } from '../types';

const LABELS: Record<ShellKind, string> = {
  powershell: 'PowerShell',
  cmd: 'CMD',
  gitbash: 'Git Bash',
};

/** Human label for a shell kind — used for the tab title. Mirrors the backend's
 *  shellLabel() so a run's stored name and the live tab agree. Pure. */
export function shellLabel(kind: ShellKind): string {
  return LABELS[kind] ?? 'Shell';
}
