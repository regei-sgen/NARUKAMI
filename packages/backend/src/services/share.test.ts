import { describe, it, expect, afterEach } from 'vitest';
import {
  hostAllowed,
  hostnameOf,
  isLoopbackHostname,
  isPrivateLanHostname,
  lanAddresses,
  lanAddressRank,
  orderLanAddresses,
  resolveBindHost,
  setShareEnabled,
} from './share';

afterEach(() => setShareEnabled(false));

describe('hostnameOf', () => {
  it('strips the port from a Host header', () => {
    expect(hostnameOf('localhost:4000')).toBe('localhost');
    expect(hostnameOf('192.168.1.5:4000')).toBe('192.168.1.5');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
  });
  it('extracts the hostname from a full Origin', () => {
    expect(hostnameOf('http://192.168.1.5:5173')).toBe('192.168.1.5');
    expect(hostnameOf('https://localhost:3000')).toBe('localhost');
  });
  it('unwraps IPv6 brackets from both forms', () => {
    expect(hostnameOf('[::1]:4000')).toBe('::1');
    expect(hostnameOf('http://[::1]:4000')).toBe('::1');
  });
  it('returns null for empty / missing input', () => {
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('')).toBeNull();
  });
});

describe('isLoopbackHostname', () => {
  it('recognises the loopback names only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    expect(isLoopbackHostname('192.168.1.5')).toBe(false);
    expect(isLoopbackHostname(null)).toBe(false);
  });
});

describe('isPrivateLanHostname', () => {
  it('accepts RFC1918 + link-local IPv4', () => {
    expect(isPrivateLanHostname('10.0.0.4')).toBe(true);
    expect(isPrivateLanHostname('192.168.1.20')).toBe(true);
    expect(isPrivateLanHostname('172.16.5.5')).toBe(true);
    expect(isPrivateLanHostname('172.31.0.1')).toBe(true);
    expect(isPrivateLanHostname('169.254.10.10')).toBe(true);
  });
  it('rejects public + out-of-range IPv4', () => {
    expect(isPrivateLanHostname('8.8.8.8')).toBe(false);
    expect(isPrivateLanHostname('172.15.0.1')).toBe(false);
    expect(isPrivateLanHostname('172.32.0.1')).toBe(false);
    expect(isPrivateLanHostname('11.0.0.1')).toBe(false);
    expect(isPrivateLanHostname('999.1.1.1')).toBe(false);
  });
  it('accepts IPv6 unique-local / link-local', () => {
    expect(isPrivateLanHostname('fe80::1')).toBe(true);
    expect(isPrivateLanHostname('fd00::1')).toBe(true);
    expect(isPrivateLanHostname('fc00::1')).toBe(true);
  });
});

describe('hostAllowed', () => {
  it('allows only loopback when sharing is OFF', () => {
    setShareEnabled(false);
    expect(hostAllowed('127.0.0.1:4000')).toBe(true);
    expect(hostAllowed('localhost:5173')).toBe(true);
    expect(hostAllowed('192.168.1.5:4000')).toBe(false);
    expect(hostAllowed('http://192.168.1.5:4000')).toBe(false);
  });
  it('also allows private-LAN (but never public) when sharing is ON', () => {
    setShareEnabled(true);
    expect(hostAllowed('127.0.0.1:4000')).toBe(true);
    expect(hostAllowed('192.168.1.5:4000')).toBe(true);
    expect(hostAllowed('10.0.0.9:4000')).toBe(true);
    expect(hostAllowed('http://192.168.1.5:4000')).toBe(true);
    expect(hostAllowed('8.8.8.8:4000')).toBe(false);
    expect(hostAllowed('evil.com:4000')).toBe(false);
  });
});

describe('lanAddresses', () => {
  it('returns an array of private IPv4 addresses', () => {
    const addrs = lanAddresses();
    expect(Array.isArray(addrs)).toBe(true);
    for (const a of addrs) expect(isPrivateLanHostname(a)).toBe(true);
  });
});

describe('resolveBindHost', () => {
  it('binds 0.0.0.0 whenever sharing is on — even if the caller asks for loopback', () => {
    // This is the regression guard: the desktop shell always passes 127.0.0.1,
    // and sharing MUST still open the LAN or the phone gets "site can't be reached".
    expect(resolveBindHost(true, '127.0.0.1')).toBe('0.0.0.0');
    expect(resolveBindHost(true, undefined)).toBe('0.0.0.0');
    expect(resolveBindHost(true, '0.0.0.0')).toBe('0.0.0.0');
  });
  it('stays loopback (or the caller host) when sharing is off', () => {
    expect(resolveBindHost(false, '127.0.0.1')).toBe('127.0.0.1');
    expect(resolveBindHost(false, undefined)).toBe('127.0.0.1');
    expect(resolveBindHost(false, '0.0.0.0')).toBe('0.0.0.0');
  });
});

describe('lanAddressRank / orderLanAddresses', () => {
  it('ranks real home/office Wi-Fi ahead of virtual adapters and link-local', () => {
    expect(lanAddressRank('192.168.1.20')).toBeLessThan(lanAddressRank('172.17.0.1')); // vs Docker
    expect(lanAddressRank('10.0.0.5')).toBeLessThan(lanAddressRank('192.168.56.1')); // vs VirtualBox
    expect(lanAddressRank('192.168.1.20')).toBeLessThan(lanAddressRank('169.254.1.1')); // vs link-local
    expect(lanAddressRank('192.168.137.1')).toBeGreaterThan(lanAddressRank('192.168.1.1')); // ICS demoted
  });
  it('orders candidates best-guess first and de-dupes', () => {
    const ordered = orderLanAddresses([
      '169.254.9.9',
      '172.17.0.1',
      '192.168.68.119',
      '10.1.2.3',
      '192.168.68.119',
    ]);
    expect(ordered).toEqual(['192.168.68.119', '10.1.2.3', '172.17.0.1', '169.254.9.9']);
  });
  it('keeps OS interface order to break ties within a rank', () => {
    expect(orderLanAddresses(['192.168.1.5', '192.168.1.9'])).toEqual(['192.168.1.5', '192.168.1.9']);
  });
});
