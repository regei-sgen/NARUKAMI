import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toasts } from './Toasts';
import type { Toast } from '../types';

// First React component test — proves the jsdom + Testing Library setup works, so
// components (previously impossible to test under the node-env/.test.ts-only
// config) now can be.
function toast(over: Partial<Toast> = {}): Toast {
  return {
    id: 't1',
    runId: 'r1',
    projectId: 'p1',
    projectName: 'proj',
    label: 'dev',
    kind: 'command',
    status: 'exited',
    exitCode: 0,
    event: 'exit',
    ...over,
  };
}

describe('Toasts', () => {
  it('renders nothing when the list is empty', () => {
    const { container } = render(<Toasts toasts={[]} onFocus={() => {}} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('focuses the run on click and dismisses on the close button', () => {
    const onFocus = vi.fn();
    const onDismiss = vi.fn();
    render(<Toasts toasts={[toast()]} onFocus={onFocus} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByTitle('Go to this terminal'));
    expect(onFocus).toHaveBeenCalledTimes(1);

    // The × button stops propagation, so it dismisses WITHOUT also focusing.
    fireEvent.click(screen.getByTitle('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('t1');
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
