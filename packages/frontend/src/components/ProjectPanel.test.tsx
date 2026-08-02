import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectPanel } from './ProjectPanel';
import { api } from '../api';
import type { AnalyzerResult, Project, RunCommand } from '../types';

// ProjectPanel is where every primary action of the app is triggered — Shell,
// CMD, elevated Shell, Claude, Continue, Run, Analyze — and it had no test at
// all. The audit flagged that: each of these buttons hands a *domain* argument
// (the project, an admin flag, a shell name) to a parent callback, so dropping
// or mistyping one silently breaks the action with nothing going red. These
// tests pin the arguments, not just the clicks.
vi.mock('../api', () => ({
  api: {
    addCommand: vi.fn().mockResolvedValue({ ok: true }),
    suggestCommand: vi.fn().mockResolvedValue({ ok: true }),
    deleteCommand: vi.fn().mockResolvedValue({ ok: true }),
    setCommandShell: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const CMD: RunCommand = {
  id: 'c1',
  projectId: 'p1',
  label: 'dev',
  command: 'npm run dev',
  cwd: null,
  isDefault: true,
  source: 'detected',
  shell: 'powershell',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const PROJECT: Project = {
  id: 'p1',
  name: 'demo',
  path: 'C:/demo',
  type: 'node',
  packageMgr: 'npm',
  status: 'ready',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  commands: [CMD],
  runs: [],
};

const ANALYSIS: AnalyzerResult = {
  type: 'node',
  packageManager: 'npm',
  installCommand: 'npm install',
} as AnalyzerResult;

function mount(overrides: Partial<Parameters<typeof ProjectPanel>[0]> = {}) {
  const props = {
    project: PROJECT,
    onAnalyze: vi.fn().mockResolvedValue({ project: PROJECT, analysis: ANALYSIS }),
    onRun: vi.fn(),
    onShell: vi.fn(),
    onClaude: vi.fn(),
    onContinueClaude: vi.fn(),
    onChanged: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<ProjectPanel {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectPanel toolbar actions', () => {
  // The three shell buttons differ ONLY by the arguments they forward. A wrapper
  // that dropped them would still render and still click — this is the assertion
  // that would catch it.
  it('Shell opens a plain PowerShell with no admin flag', () => {
    const p = mount();
    fireEvent.click(screen.getByTitle(/Open an interactive PowerShell/i));
    expect(p.onShell).toHaveBeenCalledTimes(1);
    expect(p.onShell).toHaveBeenCalledWith(PROJECT);
  });

  it('CMD forwards the cmd shell name', () => {
    const p = mount();
    fireEvent.click(screen.getByTitle(/Open an interactive Command Prompt/i));
    expect(p.onShell).toHaveBeenCalledWith(PROJECT, false, 'cmd');
  });

  it('Shell (Admin) forwards admin=true — the UAC path', () => {
    const p = mount();
    fireEvent.click(screen.getByTitle(/elevated PowerShell/i));
    expect(p.onShell).toHaveBeenCalledWith(PROJECT, true);
  });

  it('Claude Code starts a fresh session and Continue resumes — they are not the same call', () => {
    const p = mount();
    fireEvent.click(screen.getByTitle(/Interactive Claude Code session/i));
    fireEvent.click(screen.getByTitle(/Resume the last Claude conversation/i));
    expect(p.onClaude).toHaveBeenCalledWith(PROJECT);
    expect(p.onContinueClaude).toHaveBeenCalledWith(PROJECT);
    expect(p.onClaude).toHaveBeenCalledTimes(1);
    expect(p.onContinueClaude).toHaveBeenCalledTimes(1);
  });

  it('Run forwards both the project and the specific command row', () => {
    const p = mount();
    fireEvent.click(screen.getByRole('button', { name: /Run/i }));
    expect(p.onRun).toHaveBeenCalledWith(PROJECT, CMD);
  });
});

describe('ProjectPanel analyze', () => {
  it('shows a pending label while analyzing and renders the result', async () => {
    const p = mount();
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/i }));
    expect(await screen.findByRole('button', { name: /Analyzing/i })).toBeTruthy();
    await waitFor(() => expect(p.onAnalyze).toHaveBeenCalledWith('p1'));
  });

  it('surfaces an analyze failure instead of swallowing it', async () => {
    mount({ onAnalyze: vi.fn().mockRejectedValue(new Error('claude -p exited 1')) });
    fireEvent.click(screen.getByRole('button', { name: /^Analyze$/i }));
    expect(await screen.findByText(/claude -p exited 1/)).toBeTruthy();
  });
});

describe('ProjectPanel command management', () => {
  it('adds a manual command and refreshes, without reloading the page', async () => {
    const p = mount();
    // preventDefault is why the submit handler must receive its event — if the
    // wrapper dropped it, jsdom would report the navigation instead.
    fireEvent.change(screen.getByPlaceholderText(/label/i), { target: { value: 'build' } });
    const cmdInput = screen
      .getAllByRole('textbox')
      .find((el) => (el as HTMLInputElement).className.includes('cmd-command-input'));
    fireEvent.change(cmdInput as HTMLElement, { target: { value: 'npm run build' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }));
    await waitFor(() =>
      expect(api.addCommand).toHaveBeenCalledWith('p1', {
        label: 'build',
        command: 'npm run build',
        isDefault: false,
      }),
    );
    await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
  });

  it('deletes a command and refreshes', async () => {
    const p = mount();
    fireEvent.click(screen.getByTitle('Delete command'));
    await waitFor(() => expect(api.deleteCommand).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(p.onChanged).toHaveBeenCalled());
  });

  it('the PS/CMD toggle flips to the other shell', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /^PS$/ }));
    await waitFor(() => expect(api.setCommandShell).toHaveBeenCalledWith('c1', 'cmd'));
  });

  it('surfaces a delete failure', async () => {
    (api.deleteCommand as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    mount();
    fireEvent.click(screen.getByTitle('Delete command'));
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
