import { describe, it, expect, beforeEach } from 'vitest';
import {
  _clearAllDevices,
  clearDevicesForRun,
  deviceConnected,
  deviceDisconnected,
  getDevice,
  listDevices,
  onDeviceEvent,
  setDeviceState,
  touchDevice,
  type DeviceEvent,
} from './mobileDevices';

beforeEach(() => {
  _clearAllDevices();
});

describe('touchDevice', () => {
  it('creates a PENDING entry on first contact (fail closed) and emits it', () => {
    const events: DeviceEvent[] = [];
    const off = onDeviceEvent((e) => events.push(e));
    const d = touchDevice('run1', 'dev1', '192.168.1.23', 'iPhone Safari');
    off();
    expect(d?.state).toBe('pending');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('pending');
    expect(events[0].device.ip).toBe('192.168.1.23');
  });

  it('refreshes lastSeen/ip/ua on later sightings without re-emitting', () => {
    const first = touchDevice('run1', 'dev1', '192.168.1.23', 'ua-a', 1000);
    const events: DeviceEvent[] = [];
    const off = onDeviceEvent((e) => events.push(e));
    const again = touchDevice('run1', 'dev1', '192.168.1.99', 'ua-b', 2000);
    off();
    expect(again).toBe(first); // same entry, updated in place
    expect(again?.lastSeen).toBe(2000);
    expect(again?.ip).toBe('192.168.1.99');
    expect(again?.state).toBe('pending'); // a re-knock never resets a verdict
    expect(events).toHaveLength(0);
  });

  it('scopes approval per run: the same device on another run knocks again', () => {
    touchDevice('run1', 'dev1', 'ip', 'ua');
    setDeviceState('run1', 'dev1', 'approved');
    const other = touchDevice('run2', 'dev1', 'ip', 'ua');
    expect(other?.state).toBe('pending');
    expect(getDevice('run1', 'dev1')?.state).toBe('approved');
  });

  it('rejects missing or oversized device ids', () => {
    expect(touchDevice('run1', '', 'ip', 'ua')).toBeNull();
    expect(touchDevice('run1', 'x'.repeat(65), 'ip', 'ua')).toBeNull();
  });
});

describe('setDeviceState', () => {
  it('approves and denies, emitting the verdict once', () => {
    touchDevice('run1', 'dev1', 'ip', 'ua');
    const events: DeviceEvent[] = [];
    const off = onDeviceEvent((e) => events.push(e));
    expect(setDeviceState('run1', 'dev1', 'approved')?.state).toBe('approved');
    expect(setDeviceState('run1', 'dev1', 'approved')?.state).toBe('approved'); // idempotent
    expect(setDeviceState('run1', 'dev1', 'denied')?.state).toBe('denied');
    off();
    expect(events.map((e) => e.kind)).toEqual(['approved', 'denied']);
  });

  it('returns null for an unknown device', () => {
    expect(setDeviceState('run1', 'ghost', 'approved')).toBeNull();
  });
});

describe('connection tracking (the monitor)', () => {
  it('counts live sockets per device and never goes negative', () => {
    touchDevice('run1', 'dev1', 'ip', 'ua');
    deviceConnected('run1', 'dev1');
    deviceConnected('run1', 'dev1');
    expect(getDevice('run1', 'dev1')?.connections).toBe(2);
    deviceDisconnected('run1', 'dev1');
    deviceDisconnected('run1', 'dev1');
    deviceDisconnected('run1', 'dev1'); // spurious extra close
    expect(getDevice('run1', 'dev1')?.connections).toBe(0);
  });

  it('lists devices most-recently-seen first, optionally per run', () => {
    touchDevice('run1', 'old', 'ip1', 'ua', 1000);
    touchDevice('run2', 'other', 'ip2', 'ua', 2000);
    touchDevice('run1', 'new', 'ip3', 'ua', 3000);
    expect(listDevices().map((d) => d.deviceId)).toEqual(['new', 'other', 'old']);
    expect(listDevices('run1').map((d) => d.deviceId)).toEqual(['new', 'old']);
  });
});

describe('clearDevicesForRun', () => {
  it('drops a run\'s devices (share gone → approval gone → re-knock required)', () => {
    touchDevice('run1', 'dev1', 'ip', 'ua');
    setDeviceState('run1', 'dev1', 'approved');
    touchDevice('run2', 'dev2', 'ip', 'ua');
    expect(clearDevicesForRun('run1')).toBe(1);
    expect(getDevice('run1', 'dev1')).toBeNull();
    expect(getDevice('run2', 'dev2')).not.toBeNull();
    // A later knock on run1 starts over as pending.
    expect(touchDevice('run1', 'dev1', 'ip', 'ua')?.state).toBe('pending');
  });
});
