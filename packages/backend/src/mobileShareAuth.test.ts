import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAllowedHost, isAllowedOrigin, isLoopbackHost } from './auth';
import { startRelay, stopRelay, detectLanIp } from './services/lanRelay';

// A throwaway loopback origin for the relay to forward to.
function makeOrigin(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => res.end('ok'));
    srv.listen(0, '127.0.0.1', () =>
      resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() }),
    );
  });
}

afterEach(async () => {
  await stopRelay();
});

describe('isLoopbackHost (gates master-token injection)', () => {
  it('is true only for loopback, so a LAN host never gets the master token', () => {
    expect(isLoopbackHost('127.0.0.1:4000')).toBe(true);
    expect(isLoopbackHost('localhost:5173')).toBe(true);
    expect(isLoopbackHost('[::1]:4000')).toBe(true);
    expect(isLoopbackHost('192.168.1.50:8080')).toBe(false); // LAN → tokenless page
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('auth widening for LAN share (relay-gated)', () => {
  it('rejects the LAN IP while NOT sharing (relay off)', () => {
    const ip = detectLanIp() ?? '192.168.1.50';
    expect(isAllowedHost(`${ip}:8080`)).toBe(false);
    expect(isAllowedOrigin(`http://${ip}:8080`)).toBe(false);
  });

  const hasLan = detectLanIp() !== null;
  const maybe = hasLan ? it : it.skip;

  maybe('accepts the exact LAN IP ONLY while the relay is active', async () => {
    const ip = detectLanIp()!;
    const origin = await makeOrigin();
    try {
      const addr = await startRelay(origin.port);
      // While sharing: the relay's own LAN IP is accepted as Host + Origin.
      expect(isAllowedHost(`${addr.host}:${addr.port}`)).toBe(true);
      expect(isAllowedOrigin(`http://${addr.host}:${addr.port}`)).toBe(true);
      expect(addr.host).toBe(ip);

      // A DIFFERENT IP is still rejected even while sharing.
      expect(isAllowedHost('10.0.0.99:8080')).toBe(false);
      // A DNS-rebinding page sends its DOMAIN as Host/Origin, never the raw IP —
      // still rejected while sharing. This is the attack the guard exists for.
      expect(isAllowedHost('evil.com:8080')).toBe(false);
      expect(isAllowedOrigin('http://evil.com')).toBe(false);

      // Loopback stays allowed throughout.
      expect(isAllowedHost('127.0.0.1:4000')).toBe(true);
    } finally {
      origin.close();
    }
  });

  maybe('re-rejects the LAN IP after the relay stops', async () => {
    const origin = await makeOrigin();
    try {
      const addr = await startRelay(origin.port);
      expect(isAllowedHost(`${addr.host}:${addr.port}`)).toBe(true);
      await stopRelay();
      expect(isAllowedHost(`${addr.host}:${addr.port}`)).toBe(false);
      expect(isAllowedOrigin(`http://${addr.host}:${addr.port}`)).toBe(false);
    } finally {
      origin.close();
    }
  });
});
