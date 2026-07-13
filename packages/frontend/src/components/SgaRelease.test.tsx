import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SgaRelease, fmtBytes } from './SgaRelease';
import type { Project, ReleaseDoc, ReleasePreflight } from '../types';

const h = vi.hoisted(() => ({
  releasePreflight: vi.fn(),
  createRelease: vi.fn(),
  generateReleaseNotes: vi.fn(),
  deleteRelease: vi.fn(),
  downloadReleaseZip: vi.fn(),
  commitRelease: vi.fn(),
  pushRelease: vi.fn(),
  setReleaseZipDir: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    releasePreflight: h.releasePreflight,
    createRelease: h.createRelease,
    generateReleaseNotes: h.generateReleaseNotes,
    deleteRelease: h.deleteRelease,
    commitRelease: h.commitRelease,
    pushRelease: h.pushRelease,
    setReleaseZipDir: h.setReleaseZipDir,
  },
  downloadReleaseZip: h.downloadReleaseZip,
}));

const project = { id: 'p1', name: 'SGEN', path: 'C:/repo/sgen' } as unknown as Project;
const otherProject = { id: 'p2', name: 'NARUKAMI', path: 'C:/repo/narukami' } as unknown as Project;

function renderTab(selected: Project = project, projects: Project[] = [selected], onSelectProject = vi.fn()) {
  render(<SgaRelease project={selected} projects={projects} onSelectProject={onSelectProject} />);
  return onSelectProject;
}

function preflight(over: Partial<ReleasePreflight> = {}): ReleasePreflight {
  return {
    isRepo: true,
    isSga: true,
    missing: [],
    currentVersion: '2.7.0',
    suggestedVersion: '2.7.1',
    dirty: [],
    branch: 'bugfix/logger-pipeline-hooks-fix',
    zipDir: 'C:/Users/me',
    releasing: false,
    releases: [],
    ...over,
  };
}

function releaseDoc(over: Partial<ReleaseDoc> = {}): ReleaseDoc {
  return {
    id: 'r1',
    projectId: 'p1',
    version: '2.7.1',
    zipPath: 'C:/Users/me/sgen-claude-chat-v2.7.1.zip',
    zipBytes: 2_500_000,
    headCommit: 'abc1234',
    dirtyIncluded: false,
    summary: null,
    notes: null,
    createdAt: '2026-07-12T10:00:00Z',
    updatedAt: '2026-07-12T10:00:00Z',
    zipExists: true,
    ...over,
  };
}

beforeEach(() => {
  h.releasePreflight.mockReset().mockResolvedValue(preflight());
  h.createRelease.mockReset();
  h.generateReleaseNotes.mockReset();
  h.deleteRelease.mockReset();
  h.downloadReleaseZip.mockReset();
  h.commitRelease.mockReset();
  h.pushRelease.mockReset();
  h.setReleaseZipDir.mockReset();
});

describe('fmtBytes', () => {
  it('formats MB / KB / B', () => {
    expect(fmtBytes(2_500_000)).toBe('2.38 MB');
    expect(fmtBytes(2_048)).toBe('2.0 KB');
    expect(fmtBytes(12)).toBe('12 B');
  });
});

describe('SgaRelease', () => {
  it('seeds the version input from the preflight suggestion', async () => {
    renderTab();
    const input = await screen.findByPlaceholderText('2.7.1');
    await waitFor(() => expect((input as HTMLInputElement).value).toBe('2.7.1'));
    expect(screen.getByText('2.7.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Release/ })).toBeEnabled();
  });

  it('explains itself on a non-SGA project and disables the flow', async () => {
    h.releasePreflight.mockResolvedValue(
      preflight({ isSga: false, missing: ['VERSION.md', 'bridge/package.json'] }),
    );
    renderTab();
    expect(await screen.findByText(/doesn't look like the SG Claude Assistant repo/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^.*Release$/ })).not.toBeInTheDocument();
  });

  it('non-SGA project offers a one-click switch to a registered sibling that IS the SGA', async () => {
    // The live 2026-07-12 failure: the restored selection was the stale
    // C:\Users\lloyd\NARUKAMI project, so the tab dead-ended with no button.
    h.releasePreflight.mockImplementation(async (id: string) =>
      id === 'p2'
        ? preflight({ isRepo: false, isSga: false, missing: ['VERSION.md'] })
        : preflight(), // the SGEN sibling (p1) fingerprints clean
    );
    const onSelectProject = renderTab(otherProject, [project, otherProject]);

    const switchBtn = await screen.findByRole('button', { name: /Switch to SGEN/ });
    await userEvent.click(switchBtn);
    expect(onSelectProject).toHaveBeenCalledWith('p1');
  });

  it('non-SGA project with NO SGA sibling keeps the plain explanation', async () => {
    h.releasePreflight.mockResolvedValue(preflight({ isRepo: false, isSga: false, missing: ['VERSION.md'] }));
    renderTab(otherProject, [otherProject]);
    expect(await screen.findByText(/not a git repository/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to/ })).not.toBeInTheDocument();
  });

  it('requires the dirty-tree confirmation before Release enables', async () => {
    h.releasePreflight.mockResolvedValue(
      preflight({
        dirty: [
          { path: 'bridge/server.js', status: 'modified' },
          { path: 'VERSION.md', status: 'modified' }, // exempt version file — not listed
        ],
      }),
    );
    renderTab();
    expect(await screen.findByText(/1 uncommitted change\(s\) would ship/)).toBeInTheDocument();
    expect(screen.getByText('bridge/server.js')).toBeInTheDocument();
    expect(screen.queryByText('VERSION.md')).not.toBeInTheDocument();

    const releaseBtn = screen.getByRole('button', { name: /Release/ });
    expect(releaseBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(releaseBtn).toBeEnabled();
  });

  it('one click: builds the zip, shows the artifact, then auto-generates notes', async () => {
    h.createRelease.mockResolvedValue(releaseDoc());
    h.generateReleaseNotes.mockResolvedValue(
      releaseDoc({
        summary: '**SG Assistant 2.7.1** — Smoother and more reliable.',
        notes: '- Fixed the thing.\n- Improved the other thing.',
      }),
    );

    renderTab();
    const btn = await screen.findByRole('button', { name: /Release/ });
    await waitFor(() => expect(btn).toBeEnabled());
    await userEvent.click(btn);

    // Artifact card (zip path + size) appears from the create call.
    expect(await screen.findByText('C:/Users/me/sgen-claude-chat-v2.7.1.zip')).toBeInTheDocument();
    expect(h.createRelease).toHaveBeenCalledWith('p1', { version: '2.7.1', includeDirty: false });

    // Notes fill in from the follow-up call.
    expect(await screen.findByText(/Smoother and more reliable/)).toBeInTheDocument();
    expect(screen.getByText(/Fixed the thing/)).toBeInTheDocument();
    expect(h.generateReleaseNotes).toHaveBeenCalledWith('r1');
  });

  it('copies the summary to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    h.releasePreflight.mockResolvedValue(
      preflight({ releases: [releaseDoc({ summary: 'THE SUMMARY', notes: 'THE NOTES' })] }),
    );

    renderTab();
    // Open the saved release from history, then copy its summary.
    await userEvent.click(await screen.findByText('v2.7.1'));
    const copyButtons = await screen.findAllByRole('button', { name: 'Copy' });
    await userEvent.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith('THE SUMMARY');
  });

  it('shows the current branch in the repo-state tile', async () => {
    renderTab();
    expect(await screen.findByText('bugfix/logger-pipeline-hooks-fix')).toBeInTheDocument();
  });

  it('commit bump → push flow: commit swaps the button to Push, push reports done', async () => {
    // The bump is pending (only the 3 version files dirty) → Commit bump shows.
    h.releasePreflight.mockResolvedValue(
      preflight({
        currentVersion: '2.7.1',
        dirty: [
          { path: 'VERSION.md', status: 'modified' },
          { path: 'bridge/package.json', status: 'modified' },
          { path: 'extension/manifest.json', status: 'modified' },
        ],
      }),
    );
    h.commitRelease.mockImplementation(async () => {
      // After the commit the tree is clean again.
      h.releasePreflight.mockResolvedValue(preflight({ currentVersion: '2.7.1' }));
      return {
        ok: true,
        commit: 'abc123def456',
        message: 'chore(release): bump to v2.7.1',
        files: ['VERSION.md', 'bridge/package.json', 'extension/manifest.json'],
      };
    });
    h.pushRelease.mockResolvedValue({
      ok: true,
      branch: 'bugfix/logger-pipeline-hooks-fix',
      upstreamCreated: false,
      detail: 'up to date',
    });

    renderTab();
    const commitBtn = await screen.findByRole('button', { name: /Commit bump/ });
    await userEvent.click(commitBtn);
    expect(h.commitRelease).toHaveBeenCalledWith('p1');

    // Commit button is replaced by Push, with the commit hash + message noted.
    const pushBtn = await screen.findByRole('button', { name: /Push/ });
    expect(screen.queryByRole('button', { name: /Commit bump/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Committed abc123d/)).toBeInTheDocument();

    await userEvent.click(pushBtn);
    expect(h.pushRelease).toHaveBeenCalledWith('p1');
    expect(await screen.findByText(/Pushed to bugfix\/logger-pipeline-hooks-fix/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Push$/ })).not.toBeInTheDocument();
  });

  it('no Commit bump button when the version files match HEAD', async () => {
    renderTab(); // default preflight: clean tree
    await screen.findByPlaceholderText('2.7.1');
    expect(screen.queryByRole('button', { name: /Commit bump/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Push$/ })).not.toBeInTheDocument();
  });

  it('zip folder input shows the persisted dir; Save appears only when edited and persists it', async () => {
    h.setReleaseZipDir.mockResolvedValue({ ok: true, zipDir: 'C:\\releases', isDefault: false });
    renderTab();

    const input = (await screen.findByLabelText('Zip output folder')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('C:/Users/me'));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'C:\\releases');
    const save = screen.getByRole('button', { name: 'Save' });
    await userEvent.click(save);

    expect(h.setReleaseZipDir).toHaveBeenCalledWith('C:\\releases');
    // Persisted: input reflects the server-resolved path, Save disappears, Saved flashes.
    await waitFor(() => expect(input.value).toBe('C:\\releases'));
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('past releases list renders and delete removes a row', async () => {
    h.releasePreflight.mockResolvedValue(preflight({ releases: [releaseDoc()] }));
    h.deleteRelease.mockResolvedValue({ ok: true });
    renderTab();
    expect(await screen.findByText('v2.7.1')).toBeInTheDocument();
    await userEvent.click(screen.getByTitle('Remove from history (keeps the zip file)'));
    expect(h.deleteRelease).toHaveBeenCalledWith('r1');
  });
});
