import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangesPanel } from './ChangesPanel';
import { api } from '../api';
import type { GitChanges } from '../types';

vi.mock('../api', () => ({
  api: {
    getGitChanges: vi.fn(),
    stageFile: vi.fn().mockResolvedValue({ ok: true }),
    unstageFile: vi.fn().mockResolvedValue({ ok: true }),
    discardFile: vi.fn().mockResolvedValue({ ok: true }),
    commitChanges: vi.fn().mockResolvedValue({ ok: true, head: 'abc123' }),
    stageAll: vi.fn().mockResolvedValue({ ok: true }),
    unstageAll: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const SAMPLE: GitChanges = {
  isRepo: true,
  branch: 'local-dev',
  detached: false,
  staged: [{ path: 'src/a.ts', type: 'modified', staged: true }],
  unstaged: [{ path: 'src/b.ts', type: 'modified', staged: false }],
  conflicts: [{ path: 'src/c.ts', type: 'modified', staged: false }],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.getGitChanges as ReturnType<typeof vi.fn>).mockResolvedValue(SAMPLE);
});

describe('ChangesPanel', () => {
  it('renders the branch name and all three buckets', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    expect(await screen.findByText('local-dev')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    expect(screen.getByText('b.ts')).toBeInTheDocument();
    expect(screen.getByText('c.ts')).toBeInTheDocument();
  });

  it('stages an unstaged file and refetches', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: /^stage src\/b\.ts$/i }));
    await waitFor(() => expect(api.stageFile).toHaveBeenCalledWith('p1', 'src/b.ts'));
    expect(api.getGitChanges).toHaveBeenCalledTimes(2); // mount + after stage
  });

  it('confirms before discarding, then calls discardFile', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('b.ts');
    fireEvent.click(screen.getByRole('button', { name: /^discard src\/b\.ts$/i }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(api.discardFile).toHaveBeenCalledWith('p1', 'src/b.ts', false));
    confirmSpy.mockRestore();
  });

  it('opens the diff when a file row is clicked', async () => {
    const onOpenDiff = vi.fn();
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={onOpenDiff} />);
    fireEvent.click(await screen.findByText('a.ts'));
    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts', false);
  });

  it('disables Commit until a message is typed', async () => {
    render(<ChangesPanel projectId="p1" currentPath={null} onOpenDiff={vi.fn()} />);
    await screen.findByText('a.ts');
    const commit = screen.getByRole('button', { name: /^commit$/i });
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/commit message/i), {
      target: { value: 'my message' },
    });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    await waitFor(() => expect(api.commitChanges).toHaveBeenCalledWith('p1', 'my message'));
  });
});
