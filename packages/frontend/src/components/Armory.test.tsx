import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Armory as ArmoryData } from '../types';

const { getArmory } = vi.hoisted(() => ({ getArmory: vi.fn() }));
vi.mock('../api', () => ({ api: { getArmory } }));

import { Armory } from './Armory';

const sample: ArmoryData = {
  ok: true,
  ts: '',
  skills: [
    { name: 'goddev', description: 'developer mode', scope: 'global' },
    { name: 'narukami', description: 'runner skill', scope: 'project', project: 'NARUKAMI' },
  ],
  hooks: [{ event: 'Stop', matcher: '*', command: '~/.claude/hooks/x.sh', scope: 'global' }],
  memory: [{ name: 'stay-on-branch', description: 'branch rule', type: 'feedback', project: 'NARUKAMI' }],
  agents: [],
  commands: [{ name: 'narukami', description: 'launch command', scope: 'project', project: 'NARUKAMI' }],
  counts: { skills: 2, hooks: 1, memory: 1, agents: 0, commands: 1 },
};

describe('Armory', () => {
  beforeEach(() => getArmory.mockReset());

  it('renders skills, hooks, memory, commands and the empty agents note from the api', async () => {
    getArmory.mockResolvedValue(sample);
    render(<Armory />);

    expect(await screen.findByText('goddev')).toBeTruthy(); // a global skill
    expect(screen.getByText('Stop')).toBeTruthy(); // hook event
    expect(screen.getByText('~/.claude/hooks/x.sh')).toBeTruthy(); // hook command
    expect(screen.getByText('stay-on-branch')).toBeTruthy(); // memory pin
    // 'narukami' is both a project skill and a project command → two cards
    expect(screen.getAllByText('narukami')).toHaveLength(2);
    // empty agents section still renders its note
    expect(screen.getByText(/No custom agents/)).toBeTruthy();
  });
});
