import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  startRelay,
  stopRelay,
  isRelayRunning,
  activeLanAddress,
  detectLanIp,
} from './lanRelay';

// A throwaway loopback HTTP origin to forward to.
function makeOrigin(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`ok host=${req.headers.host} path=${req.url}`);
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() });
    });
  });
}

afterEach(async () => {
  await stopRelay();
});

describe('lanRelay', () => {
  it('is stopped by default', () => {
    expect(isRelayRunning()).toBe(false);
    expect(activeLanAddress()).toBeNull();
  });

  // These forward tests need a routable LAN interface. On a CI box with only
  // loopback, detectLanIp() is null — skip rather than fail.
  const hasLan = detectLanIp() !== null;
  const maybe = hasLan ? it : it.skip;

  maybe('forwards HTTP from the LAN address to the loopback origin', async () => {
    const origin = await makeOrigin();
    try {
      const addr = await startRelay(origin.port);
      expect(isRelayRunning()).toBe(true);
      expect(addr.host).toBe(detectLanIp());
      expect(addr.port).toBeGreaterThan(0);

      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: addr.host, port: addr.port, path: '/probe' }, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          })
          .on('error', reject);
      });
      // The origin saw the LAN host header (the exact thing auth.ts must accept).
      expect(body).toContain(`host=${addr.host}:${addr.port}`);
      expect(body).toContain('path=/probe');
    } finally {
      origin.close();
    }
  });

  maybe('start is idempotent — a second call returns the same address', async () => {
    const origin = await makeOrigin();
    try {
      const a = await startRelay(origin.port);
      const b = await startRelay(origin.port);
      expect(b).toEqual(a);
    } finally {
      origin.close();
    }
  });

  maybe('stop severs LAN reachability (connection refused after stop)', async () => {
    const origin = await makeOrigin();
    try {
      const addr = await startRelay(origin.port);
      await stopRelay();
      expect(isRelayRunning()).toBe(false);
      expect(activeLanAddress()).toBeNull();
      const refused = await new Promise<boolean>((resolve) => {
        const sock = net.connect(addr.port, addr.host);
        sock.on('connect', () => {
          sock.destroy();
          resolve(false);
        });
        sock.on('error', () => resolve(true));
        setTimeout(() => resolve(true), 1000);
      });
      expect(refused).toBe(true);
    } finally {
      origin.close();
    }
  });
});
