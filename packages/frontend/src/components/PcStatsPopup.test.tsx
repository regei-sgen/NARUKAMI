import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PcStatsPopup, STATS_URL } from './PcStatsPopup';
import { PcStatsWindow } from './PcStatsWindow';
import { api } from '../api';
import type { PcStats } from '../types';

const baseStats: PcStats = {
  ts: 1,
  cpu: { model: 'x', cores: 1, physicalCores: null, speedMHz: 1, loadPct: 0, tjMaxC: null },
  mem: { usedMB: 1, totalMB: 2 },
  series: { cpu: [], mem: [], cpuTemp: [], gpuLoad: [], gpuTemp: [] },
  gpus: [],
  gpuSource: null,
  temps: [],
  status: {
    hostname: 'h',
    platform: 'win32',
    release: '1',
    arch: 'x64',
    uptimeSec: 60,
    battery: null,
    disk: null,
  },
};

describe('PcStatsPopup (header chip)', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('opens PC Stats as a named window instead of an in-page panel', () => {
    const focus = vi.fn();
    const open = vi.fn().mockReturnValue({ focus });
    vi.stubGlobal('open', open);

    render(<PcStatsPopup />);
    fireEvent.click(screen.getByRole('button', { name: 'PC stats' }));

    expect(open).toHaveBeenCalledWith(STATS_URL, 'narukami-pcstats');
    // reusing the window name means a second click focuses the existing window
    expect(focus).toHaveBeenCalled();
  });

  it('never renders a panel in the main window', () => {
    vi.stubGlobal('open', vi.fn().mockReturnValue(null));
    const { container } = render(<PcStatsPopup />);
    fireEvent.click(screen.getByRole('button', { name: 'PC stats' }));
    expect(container.querySelector('.pcv')).toBeNull();
  });
});

describe('PcStatsWindow (detached window)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getPcStats').mockResolvedValue({ ...baseStats });
  });
  afterEach(() => {
    delete (window as unknown as { narukamiDesktop?: unknown }).narukamiDesktop;
  });

  it('gives the readout the whole surface — controls live in the kebab menu', async () => {
    const { container } = render(<PcStatsWindow />);
    await waitFor(() => expect(container.querySelector('.pcv')).toBeTruthy());
    // no title strip stealing vertical space from a landscape phone
    expect(screen.queryByText('PC STATS')).toBeNull();
    expect(container.querySelector('.pcv-menu')).toBeNull();
  });

  it('toggles the pin through the desktop bridge', async () => {
    const setAlwaysOnTop = vi.fn().mockResolvedValue(false);
    (window as unknown as { narukamiDesktop: unknown }).narukamiDesktop = { setAlwaysOnTop };
    vi.spyOn(api, 'getStatsLan').mockResolvedValue({ running: false, info: null });

    render(<PcStatsWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Panel menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Unpin from top/ }));

    await waitFor(() => expect(setAlwaysOnTop).toHaveBeenCalledWith(false));
  });

  it('shows the address and token SEPARATELY, each with its own copy button', async () => {
    (window as unknown as { narukamiDesktop: unknown }).narukamiDesktop = {
      setAlwaysOnTop: vi.fn().mockResolvedValue(true),
    };
    vi.spyOn(api, 'getStatsLan').mockResolvedValue({ running: false, info: null });
    const start = vi.spyOn(api, 'startStatsLan').mockResolvedValue({
      running: true,
      info: {
        port: 4311,
        token: 'tok123',
        urls: ['http://192.168.1.10:4311'],
        phoneUrls: ['http://192.168.1.10:4311/?pcstats=1&token=tok123'],
      },
    });

    render(<PcStatsWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Panel menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Share to phone/ }));

    await waitFor(() => expect(start).toHaveBeenCalled());

    // The native app has two fields, so the two values must be copyable apart —
    // the old combined "?pcstats=1&token=..." link is no longer what it wants.
    await waitFor(() => expect(screen.getByText('http://192.168.1.10:4311')).toBeTruthy());
    expect(screen.getByText('tok123')).toBeTruthy();
    expect(screen.queryByText(/\?pcstats=1&token=/)).toBeNull();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    fireEvent.click(screen.getByRole('button', { name: 'COPY ADDRESS' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.1.10:4311'));

    fireEvent.click(screen.getByRole('button', { name: 'COPY TOKEN' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('tok123'));
  });

  it('hides pin and Wi-Fi controls on the phone (no desktop bridge)', async () => {
    const spy = vi.spyOn(api, 'getStatsLan');
    render(<PcStatsWindow />);
    fireEvent.click(await screen.findByRole('button', { name: 'Panel menu' }));

    expect(screen.queryByRole('menuitem', { name: /Pin|Unpin/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Share to phone/ })).toBeNull();
    // Reload stays — it is useful on the phone
    expect(screen.getByRole('menuitem', { name: 'Reload' })).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });
});
