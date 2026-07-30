import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CodeEditor } from './CodeEditor';
import { api } from '../api';
import type { FileNode, Project } from '../types';

vi.mock('../lib/monaco-setup', () => ({}));
// Stand-in for Monaco that still round-trips value/onChange, so tests can dirty
// the buffer the way typing would.
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, onChange }: { value?: string; onChange?: (v: string) => void }) => (
    <div data-testid="monaco">
      <textarea
        data-testid="monaco-input"
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  ),
  DiffEditor: () => <div data-testid="monaco-diff" />,
}));
vi.mock('../api', () => ({
  api: {
    getTree: vi.fn().mockResolvedValue({ tree: [], lazy: false }),
    getDir: vi.fn().mockResolvedValue({ path: '', children: [] }),
    searchFileNames: vi.fn().mockResolvedValue({ files: [], truncated: false }),
    searchCode: vi.fn().mockResolvedValue({ matches: [], truncated: false }),
    readFile: vi.fn().mockResolvedValue({ path: '', content: '', size: 0, mtimeMs: 1 }),
    getGitBranch: vi.fn().mockResolvedValue({ branch: 'local-dev', detached: false }),
    getGitStatus: vi.fn().mockResolvedValue({ isRepo: true, files: [] }),
    getGitDiff: vi.fn().mockResolvedValue({ isRepo: true, tracked: true, ranges: [] }),
    statFile: vi.fn().mockResolvedValue({ path: '', mtimeMs: 1, size: 0 }),
    saveFile: vi.fn().mockResolvedValue({ ok: true, bytes: 1, mtimeMs: 2 }),
    getGitChanges: vi.fn().mockResolvedValue({
      isRepo: true, branch: 'local-dev', detached: false, staged: [], unstaged: [], conflicts: [],
    }),
  },
}));

const PROJECT = { id: 'p1', name: 'demo', path: '/tmp/demo', status: 'idle', commands: [] } as unknown as Project;

const dir = (path: string, extra: Partial<FileNode> = {}): FileNode => ({
  name: path.split('/').pop()!, path, type: 'dir', ...extra,
});
const file = (path: string): FileNode => ({ name: path.split('/').pop()!, path, type: 'file' });

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

describe('file tree completeness', () => {
  it('renders every top-level entry the backend sends', async () => {
    const many = Array.from({ length: 30 }, (_, i) => file(`f${i}.txt`));
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [dir('src', { children: [file('src/a.ts')] }), ...many],
      lazy: false,
    });
    render(<CodeEditor project={PROJECT} />);
    expect(await screen.findByText('f29.txt')).toBeInTheDocument();
    expect(screen.getByText('f0.txt')).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('loads a deferred folder in full when it is expanded', async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      // `src` is first, so auto-expand takes it and `data` stays collapsed.
      tree: [dir('src', { children: [file('src/a.ts')] }), dir('data', { loaded: false }), file('README.md')],
      lazy: true,
    });
    vi.mocked(api.getDir).mockResolvedValueOnce({
      path: 'data',
      children: [file('data/one.csv'), file('data/two.csv'), dir('data/sub')],
    });

    render(<CodeEditor project={PROJECT} />);
    // Not fetched until it is opened.
    expect(await screen.findByText('data')).toBeInTheDocument();
    expect(api.getDir).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('data'));
    await waitFor(() => expect(api.getDir).toHaveBeenCalledWith('p1', 'data'));
    expect(await screen.findByText('one.csv')).toBeInTheDocument();
    expect(screen.getByText('two.csv')).toBeInTheDocument();
    expect(screen.getByText('sub')).toBeInTheDocument();
  });

  it('auto-expands the first folder, fetching it when it was deferred', async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [dir('big', { loaded: false })],
      lazy: true,
    });
    vi.mocked(api.getDir).mockResolvedValueOnce({
      path: 'big',
      children: [file('big/inside.txt')],
    });
    render(<CodeEditor project={PROJECT} />);
    expect(await screen.findByText('inside.txt')).toBeInTheDocument();
  });

  it('keeps the tree usable when one folder fails to list', async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [file('keep.txt'), dir('bad', { loaded: false })],
      lazy: true,
    });
    vi.mocked(api.getDir).mockRejectedValueOnce(new Error('EACCES'));
    render(<CodeEditor project={PROJECT} />);
    fireEvent.click(await screen.findByText('bad'));
    expect(await screen.findByText(/bad: EACCES/)).toBeInTheDocument();
    expect(screen.getByText('keep.txt')).toBeInTheDocument();
  });

  it('searches file names on the backend so lazy folders are covered', async () => {
    vi.mocked(api.searchFileNames).mockResolvedValue({
      files: ['data/deep/hidden-from-tree.csv'],
      truncated: false,
    });
    render(<CodeEditor project={PROJECT} />);
    fireEvent.change(await screen.findByPlaceholderText(/search file name/i), {
      target: { value: 'hidden' },
    });
    await waitFor(() => expect(api.searchFileNames).toHaveBeenCalledWith('p1', 'hidden'));
    expect(await screen.findByText('data/deep/hidden-from-tree.csv')).toBeInTheDocument();
  });
});

describe('refresh from disk', () => {
  // Opens app.ts with a known mtime, so a later stat can be made to look newer.
  const openFile = async (mtimeMs = 1000, content = 'const a = 1;') => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [file('app.ts')],
      lazy: false,
    });
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content, size: content.length, mtimeMs,
    });
    render(<CodeEditor project={PROJECT} />);
    fireEvent.click(await screen.findByText('app.ts'));
    await screen.findByTestId('monaco');
  };

  const refreshBtn = () => screen.getByRole('button', { name: /refresh/i });

  it('shows a Refresh button once a file is open, and none before', async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo', tree: [file('app.ts')], lazy: false,
    });
    render(<CodeEditor project={PROJECT} />);
    expect(await screen.findByText('app.ts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();

    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'x', size: 1, mtimeMs: 1000,
    });
    fireEvent.click(screen.getByText('app.ts'));
    expect(await screen.findByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('reloads the file content on click', async () => {
    await openFile(1000, 'const a = 1;');
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'const a = 2; // rewritten by Claude', size: 35, mtimeMs: 2000,
    });
    fireEvent.click(refreshBtn());
    await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.readFile).mock.calls[1]).toEqual(['p1', 'app.ts']);
  });

  it('flags "changed on disk" when the probe sees a newer mtime', async () => {
    vi.mocked(api.statFile).mockResolvedValue({ path: 'app.ts', mtimeMs: 9999, size: 12 });
    await openFile(1000);
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    expect(refreshBtn().className).toMatch(/attention/);
  });

  it('does not flag anything while disk matches the loaded copy', async () => {
    vi.mocked(api.statFile).mockResolvedValue({ path: 'app.ts', mtimeMs: 1000, size: 12 });
    await openFile(1000);
    await waitFor(() => expect(api.statFile).toHaveBeenCalled());
    expect(screen.queryByText(/changed on disk/i)).toBeNull();
    expect(refreshBtn().className).not.toMatch(/attention/);
  });

  it('surfaces a file deleted behind the editor and disables refresh', async () => {
    vi.mocked(api.statFile).mockRejectedValue(new Error('File not found.'));
    await openFile(1000);
    expect(await screen.findByText(/deleted on disk/i)).toBeInTheDocument();
    expect(refreshBtn()).toBeDisabled();
  });

  it('keeps the flag clear when the probe fails transiently (no false alarm)', async () => {
    vi.mocked(api.statFile).mockRejectedValue(new Error('Network request failed'));
    await openFile(1000);
    await waitFor(() => expect(api.statFile).toHaveBeenCalled());
    expect(screen.queryByText(/deleted on disk/i)).toBeNull();
    expect(screen.queryByText(/changed on disk/i)).toBeNull();
  });

  it('asks before discarding unsaved edits, and honours a cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openFile(1000, 'const a = 1;');
    // Dirty the buffer through the mocked editor's change hook.
    fireEvent.change(screen.getByTestId('monaco-input'), { target: { value: 'edited locally' } });
    fireEvent.click(refreshBtn());
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/unsaved changes/i);
    // Cancelled → no second read, buffer untouched.
    expect(api.readFile).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('reloads when the discard prompt is accepted', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openFile(1000, 'const a = 1;');
    fireEvent.change(screen.getByTestId('monaco-input'), { target: { value: 'edited locally' } });
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'from disk', size: 9, mtimeMs: 3000,
    });
    fireEvent.click(refreshBtn());
    await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(2));
    confirmSpy.mockRestore();
  });

  it('does not prompt when the buffer is clean', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openFile(1000, 'const a = 1;');
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'const a = 1;', size: 12, mtimeMs: 2000,
    });
    fireEvent.click(refreshBtn());
    await waitFor(() => expect(api.readFile).toHaveBeenCalledTimes(2));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('clears the stale flag after refreshing', async () => {
    vi.mocked(api.statFile).mockResolvedValue({ path: 'app.ts', mtimeMs: 9999, size: 12 });
    await openFile(1000);
    expect(await screen.findByText(/changed on disk/i)).toBeInTheDocument();
    // The reload returns the mtime the probe reported, so nothing is stale now.
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'fresh', size: 5, mtimeMs: 9999,
    });
    fireEvent.click(refreshBtn());
    await waitFor(() => expect(screen.queryByText(/changed on disk/i)).toBeNull());
  });
});

describe('markdown preview toggle', () => {
  // The sidebar also has a "Code" button (search mode) — scope to the toolbar group.
  const mdToggle = () => within(screen.getByRole('group', { name: /markdown view/i }));

  const openMd = async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [file('NOTES.md'), file('app.ts')],
      lazy: false,
    });
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'NOTES.md',
      content: '# Title\n\n- point one\n',
      size: 20,
      mtimeMs: 1,
    });
    render(<CodeEditor project={PROJECT} />);
    fireEvent.click(await screen.findByText('NOTES.md'));
    await screen.findByTestId('monaco');
  };

  it('offers Code/Preview for a markdown file and renders it', async () => {
    await openMd();
    fireEvent.click(mdToggle().getByRole('button', { name: /^preview$/i }));

    const preview = await screen.findByTestId('md-preview');
    expect(preview.querySelector('h1')?.textContent).toBe('Title');
    expect(preview.querySelector('li')?.textContent).toContain('point one');
    expect(screen.queryByTestId('monaco')).toBeNull();
  });

  it('switches back to the source editor', async () => {
    await openMd();
    fireEvent.click(mdToggle().getByRole('button', { name: /^preview$/i }));
    await screen.findByTestId('md-preview');
    fireEvent.click(mdToggle().getByRole('button', { name: /^code$/i }));
    expect(await screen.findByTestId('monaco')).toBeInTheDocument();
    expect(screen.queryByTestId('md-preview')).toBeNull();
  });

  it('previews the live buffer, not just what was saved', async () => {
    await openMd();
    fireEvent.click(mdToggle().getByRole('button', { name: /^preview$/i }));
    expect((await screen.findByTestId('md-preview')).textContent).toContain('Title');
  });

  it('offers no toggle for a non-markdown file', async () => {
    vi.mocked(api.getTree).mockResolvedValueOnce({
      root: '/tmp/demo',
      tree: [file('app.ts')],
      lazy: false,
    });
    vi.mocked(api.readFile).mockResolvedValueOnce({
      path: 'app.ts', content: 'const a = 1;', size: 12, mtimeMs: 1,
    });
    render(<CodeEditor project={PROJECT} />);
    fireEvent.click(await screen.findByText('app.ts'));
    await screen.findByTestId('monaco');
    expect(screen.queryByRole('button', { name: /^preview$/i })).toBeNull();
  });
});
