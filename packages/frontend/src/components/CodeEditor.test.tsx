import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import { api } from '../api';
import type { Project } from '../types';

vi.mock('../lib/monaco-setup', () => ({}));
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: () => <div data-testid="monaco" />,
  DiffEditor: () => <div data-testid="monaco-diff" />,
}));
vi.mock('../api', () => ({
  api: {
    getTree: vi.fn().mockResolvedValue({ tree: [], truncated: false }),
    getGitBranch: vi.fn().mockResolvedValue({ branch: 'local-dev', detached: false }),
    getGitChanges: vi.fn().mockResolvedValue({
      isRepo: true, branch: 'local-dev', detached: false, staged: [], unstaged: [], conflicts: [],
    }),
  },
}));

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo', status: 'idle', commands: [] } as unknown as Project;

beforeEach(() => vi.clearAllMocks());

describe('CodeEditor sidebar tabs', () => {
  it('defaults to Explorer and switches to the Changes panel', async () => {
    render(<CodeEditor project={PROJECT} />);
    // Explorer default: the Name/Code search modes are visible.
    expect(await screen.findByRole('button', { name: /^name$/i })).toBeInTheDocument();
    // Switch to Changes.
    fireEvent.click(screen.getByRole('button', { name: /^changes$/i }));
    expect(api.getGitChanges).toHaveBeenCalledWith('p1');
  });
});
