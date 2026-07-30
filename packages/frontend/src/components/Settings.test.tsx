import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AboutInfo, AiSettings } from '../types';

const { getAiSettings, saveAiSettings, clearAiKey, getAbout, setReleaseZipDir } = vi.hoisted(() => ({
  getAiSettings: vi.fn(),
  saveAiSettings: vi.fn(),
  clearAiKey: vi.fn(),
  getAbout: vi.fn(),
  setReleaseZipDir: vi.fn(),
}));
vi.mock('../api', () => ({
  api: { getAiSettings, saveAiSettings, clearAiKey, getAbout, setReleaseZipDir },
}));

import { Settings } from './Settings';

const DEFAULT_AI: AiSettings = {
  provider: 'claude-code',
  hasKey: false,
  keyPreview: '',
  baseUrl: '',
  defaultEffort: 'ultracode',
  inheritedAuthVars: [],
  effective: 'claude-code-login',
};

const ABOUT: AboutInfo = {
  version: '1.0.0',
  platform: 'win32',
  arch: 'x64',
  node: '22.0.0',
  backendUrl: 'http://127.0.0.1:4000',
  godHome: 'C:/x/.narukami/godclaude', // portable-exempt: fixed test fixture
  godInstalled: true,
  database: 'C:/x/dev.db', // portable-exempt: fixed test fixture
};

const onPrefsChange = vi.fn();

function renderSettings(prefs = {}) {
  return render(
    <Settings
      themes={[{ value: '', label: 'Beni', accent: '#ff2d3c' }]}
      theme=""
      onThemeChange={vi.fn()}
      dockPosition="bottom"
      onDockPositionChange={vi.fn()}
      dockHeight={320}
      dockWidth={480}
      onDockSizeReset={vi.fn()}
      sidebarCollapsed={false}
      onSidebarCollapsedChange={vi.fn()}
      prefs={prefs}
      onPrefsChange={onPrefsChange}
    />,
  );
}

beforeEach(() => {
  for (const m of [getAiSettings, saveAiSettings, clearAiKey, getAbout, setReleaseZipDir, onPrefsChange]) {
    m.mockReset();
  }
  getAiSettings.mockResolvedValue(DEFAULT_AI);
  getAbout.mockResolvedValue(ABOUT);
});

describe('Settings — AI provider', () => {
  it('defaults to the Claude Code login and says nothing is injected', async () => {
    renderSettings();
    expect(await screen.findByText(/signed-in login/)).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    // API-key mode can't be selected until a key exists
    expect(screen.getByText('no key yet')).toBeTruthy();
    expect(screen.getByText('Anthropic API key').closest('button')?.disabled).toBe(true);
  });

  it('saves a pasted key and switches the provider in one write', async () => {
    saveAiSettings.mockResolvedValue({
      ...DEFAULT_AI,
      provider: 'api-key',
      hasKey: true,
      keyPreview: 'sk-ant-…1234',
      effective: 'api-key',
    });
    renderSettings();

    const input = await screen.findByLabelText('Anthropic API key');
    fireEvent.change(input, { target: { value: 'sk-ant-api03-secret1234' } });
    fireEvent.click(screen.getByText('Save key'));

    await waitFor(() =>
      expect(saveAiSettings).toHaveBeenCalledWith({
        provider: 'api-key',
        apiKey: 'sk-ant-api03-secret1234',
        baseUrl: '',
      }),
    );
    // the masked preview replaces the field; the raw key is gone from the DOM
    expect(await screen.findByText('sk-ant-…1234')).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-ant-api03-secret1234');
  });

  it('surfaces a rejected save instead of showing the new state', async () => {
    saveAiSettings.mockRejectedValue(new Error('Add an API key before switching to API-key mode.'));
    renderSettings();

    const input = await screen.findByLabelText('Anthropic API key');
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.click(screen.getByText('Save key'));

    expect(await screen.findByText(/Add an API key/)).toBeTruthy();
    expect(screen.getByText('no key yet')).toBeTruthy(); // state unchanged
  });

  it('removes a stored key and falls back to the login', async () => {
    getAiSettings.mockResolvedValue({
      ...DEFAULT_AI,
      provider: 'api-key',
      hasKey: true,
      keyPreview: 'sk-ant-…1234',
      effective: 'api-key',
    });
    clearAiKey.mockResolvedValue(DEFAULT_AI);
    renderSettings();

    fireEvent.click(await screen.findByText('Remove'));
    await waitFor(() => expect(clearAiKey).toHaveBeenCalled());
    expect(await screen.findByText(/signed-in login/)).toBeTruthy();
  });

  it('warns when an inherited env credential outranks the login', async () => {
    getAiSettings.mockResolvedValue({
      ...DEFAULT_AI,
      inheritedAuthVars: ['ANTHROPIC_API_KEY'],
      effective: 'inherited-env',
    });
    renderSettings();
    expect(await screen.findByText(/already set in the environment/)).toBeTruthy();
  });

  it('persists a changed default effort', async () => {
    saveAiSettings.mockResolvedValue({ ...DEFAULT_AI, defaultEffort: 'high' });
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Default effort'), { target: { value: 'high' } });
    await waitFor(() => expect(saveAiSettings).toHaveBeenCalledWith({ defaultEffort: 'high' }));
  });
});

describe('Settings — notifications', () => {
  it('treats an unset pref as ON and reports a toggle-off', async () => {
    renderSettings();
    const toggle = await screen.findByLabelText('Show in-app toasts');
    expect((toggle as HTMLInputElement).checked).toBe(true);

    fireEvent.click(toggle);
    expect(onPrefsChange).toHaveBeenCalledWith({ inAppToasts: false });
  });

  it('reflects a stored off-pref', async () => {
    renderSettings({ desktopNotifications: false });
    const toggle = await screen.findByLabelText('Show desktop notifications');
    expect((toggle as HTMLInputElement).checked).toBe(false);
  });
});

describe('Settings — about', () => {
  it('renders the read-only diagnostics', async () => {
    renderSettings();
    expect(await screen.findByText('1.0.0')).toBeTruthy();
    expect(screen.getByText('http://127.0.0.1:4000')).toBeTruthy();
    expect(screen.getByText(/win32/)).toBeTruthy();
  });
});
