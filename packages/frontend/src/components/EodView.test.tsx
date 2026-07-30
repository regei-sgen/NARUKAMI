import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, todayKey } from '../lib/eod';

const { getEodActive, listEodReports } = vi.hoisted(() => ({
  getEodActive: vi.fn(),
  listEodReports: vi.fn(),
}));
vi.mock('../api', () => ({
  api: { getEodActive, listEodReports, generateEodReport: vi.fn(), deleteEodReport: vi.fn(), getEodReport: vi.fn() },
}));

import { EodView, toSlack } from './EodView';

describe('toSlack (markdown → Slack mrkdwn, paste-ready)', () => {
  it('turns headings into *bold* and bullets into •, drops rules and ## syntax', () => {
    const slack = toSlack(
      '## EOD -- July 6, 2026\n\n### Dashboard\n-   Fixed a bug.\n-   Shipped v1.5.\n\n### Summary\n-   Good day.\n---',
    );
    expect(slack).toContain('*EOD — July 6, 2026*');
    expect(slack).toContain('*Dashboard*');
    expect(slack).toContain('• Fixed a bug.');
    expect(slack).toContain('• Good day.');
    expect(slack).not.toContain('##'); // no markdown headings left
    expect(slack).not.toMatch(/^-{3,}$/m); // no horizontal rule
  });
});

describe('EodView', () => {
  beforeEach(() => {
    getEodActive.mockReset();
    listEodReports.mockReset();
    getEodActive.mockResolvedValue({
      day: '2026-07-06',
      projects: [
        { name: 'Dashboard.sgen.com', path: 'C:/x/dash', registered: true, projectId: 'p1', sessions: 2, runs: 0, commits: 3 },
        { name: 'lumen-assets', path: 'C:/x/lumen', registered: false, projectId: null, sessions: 1, runs: 0, commits: 0 },
      ],
    });
    listEodReports.mockResolvedValue([]);
  });

  it('lists active projects with default-checked include checkboxes', async () => {
    render(<EodView />);
    expect(await screen.findByText('Dashboard.sgen.com')).toBeTruthy();
    expect(screen.getByText('lumen-assets')).toBeTruthy();
    expect(screen.getByText('ext')).toBeTruthy(); // non-registered marker
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it('defaults to today/today and a quick preset widens the request to the range', async () => {
    render(<EodView />);
    await screen.findByText('Dashboard.sgen.com'); // initial load settled
    const today = todayKey();
    // Mount fetched the single day (today, today).
    expect(getEodActive).toHaveBeenCalledWith(today, today);

    getEodActive.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(getEodActive).toHaveBeenCalled());
    // 7-day inclusive window ending today: from = today-6, to = today.
    expect(getEodActive).toHaveBeenLastCalledWith(addDays(today, -6), today);
  });
});

describe('toSlack — the detailed report format (per-project sub-headings)', () => {
  it('converts **bold** to Slack single-asterisk bold, leaving no literal ** behind', () => {
    const slack = toSlack(
      '### NARUKAMI\n**Overview** — Shipped the Settings tab.\n\n**Delivered**\n-   Added **server-side** key storage.\n',
    );
    expect(slack).toContain('*NARUKAMI*');
    expect(slack).toContain('*Overview* — Shipped the Settings tab.');
    expect(slack).toContain('*Delivered*');
    expect(slack).toContain('• Added *server-side* key storage.');
    expect(slack).not.toContain('**'); // no markdown bold survives into Slack
  });

  it('keeps a heading that already contains bold from doubling its asterisks', () => {
    expect(toSlack('### **NARUKAMI**')).toBe('*NARUKAMI*');
  });
});

describe('toSlack — nested sub-lists (the themed report format)', () => {
  it('preserves one level of nesting instead of flattening it', () => {
    const slack = toSlack(
      '#### Account Management\n-   Expanded account management by adding:\n    -   Operator settings management.\n    -   Account editing.\n-   Back at top level.',
    );
    const lines = slack.split('\n');
    expect(lines).toContain('*Account Management*');
    expect(lines).toContain('• Expanded account management by adding:');
    expect(lines).toContain('    • Operator settings management.');
    expect(lines).toContain('    • Account editing.');
    expect(lines).toContain('• Back at top level.');
  });

  it('keeps a plain top-level bullet unindented', () => {
    expect(toSlack('- One thing.')).toBe('• One thing.');
  });
});
