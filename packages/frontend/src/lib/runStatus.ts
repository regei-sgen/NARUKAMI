import type { RunStatus } from '../types';

/** Map a server-reported run status string to the UI's RunStatus union. */
export function normalizeStatus(status: string | undefined): RunStatus {
  if (status === 'killed') return 'killed';
  if (status === 'error') return 'error';
  return 'exited';
}
