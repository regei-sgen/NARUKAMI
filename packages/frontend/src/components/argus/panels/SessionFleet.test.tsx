import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionFleet } from './SessionFleet';
import type { ArgusSession, ArgusSessions } from '../../../types';

function session(over: Partial<ArgusSession> = {}): ArgusSession {
  return {
    pid: 100,
    sessionId: '11111111-2222-3333-4444-555555555555',
    cwd: 'C:/proj',
    name: '',
    version: '2.1',
    status: 'idle',
    modes: [],
    state: 'live',
    ageMs: 1000,
    updatedAt: 1,
    ...over,
  };
}
function fleet(items: ArgusSession[]): ArgusSessions {
  return { count: items.length, live: items.filter((s) => s.state === 'live').length, items };
}

describe('SessionFleet origin badge', () => {
  it('badges a NARUKAMI-launched session and marks a native one', () => {
    render(
      <SessionFleet
        sessions={fleet([
          session({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', origin: 'narukami' }),
          session({ sessionId: 'bbbbbbbb-0000-0000-0000-000000000002', origin: 'native' }),
        ])}
      />,
    );
    // The NARUKAMI badge distinguishes our session; the native one is marked too.
    expect(screen.getByText('NARUKAMI')).toBeTruthy();
    expect(screen.getByText('native')).toBeTruthy();
  });

  it('shows no origin badge when origin is unknown (undefined)', () => {
    render(<SessionFleet sessions={fleet([session({ origin: undefined })])} />);
    expect(screen.queryByText('NARUKAMI')).toBeNull();
    expect(screen.queryByText('native')).toBeNull();
  });
});
