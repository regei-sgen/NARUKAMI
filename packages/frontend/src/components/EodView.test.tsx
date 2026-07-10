import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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
});
