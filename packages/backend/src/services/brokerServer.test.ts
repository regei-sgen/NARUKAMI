import { describe, it, expect, vi } from 'vitest';
import type net from 'node:net';
import { BrokerTransport } from './brokerServer';

function fakeSocket() {
  const writes: string[] = [];
  const sock = {
    destroyed: false,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    destroy: () => {
      sock.destroyed = true;
    },
  };
  return { sock, writes };
}

function frames(writes: string[]) {
  return writes.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('BrokerTransport', () => {
  it('exposes the pid it was constructed with', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 4321);
    expect(t.pid).toBe(4321);
  });

  it('encodes input / resize / kill as newline-delimited JSON frames', () => {
    const { sock, writes } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    t.write('echo hi');
    t.resize(120, 40);
    t.kill();
    expect(frames(writes)).toEqual([
      { t: 'input', d: 'echo hi' },
      { t: 'resize', cols: 120, rows: 40 },
      { t: 'kill' },
    ]);
  });

  it('decodes base64 data frames to the onData callback', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const chunks: string[] = [];
    t.onData((c) => chunks.push(c));
    t.handleFrame({ t: 'data', d: Buffer.from('héllo €', 'utf8').toString('base64') });
    expect(chunks).toEqual(['héllo €']);
  });

  it('fires onExit once with the frame code, then is idempotent', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const exit = vi.fn();
    t.onExit(exit);
    t.handleFrame({ t: 'exit', code: 7 });
    t.handleFrame({ t: 'exit', code: 9 }); // ignored — already exited
    t.socketClosed(); // also ignored
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ exitCode: 7 });
  });

  it('treats a socket close as exit(null) when no exit frame arrived', () => {
    const { sock } = fakeSocket();
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    const exit = vi.fn();
    t.onExit(exit);
    t.socketClosed();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ exitCode: null });
    expect(sock.destroyed).toBe(true);
  });

  it('does not throw writing after the socket is destroyed', () => {
    const { sock } = fakeSocket();
    sock.destroyed = true;
    const t = new BrokerTransport(sock as unknown as net.Socket, 1);
    expect(() => t.write('x')).not.toThrow();
  });
});
