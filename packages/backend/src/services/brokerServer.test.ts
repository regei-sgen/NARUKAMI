import { describe, it, expect, vi } from 'vitest';
import type net from 'node:net';
import { BrokerTransport, elevationPsCommand } from './brokerServer';

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

describe('elevationPsCommand', () => {
  const exe = 'C:\\Program Files\\NARUKAMI\\NARUKAMI.exe';
  const agent = 'C:\\Program Files\\NARUKAMI\\resources\\broker-agent.mjs';
  const cfg = 'C:\\Users\\me\\AppData\\Local\\Temp\\narukami-broker\\run.json';

  it('elevates a hidden powershell (not the exe directly) via -Verb RunAs', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    expect(cmd).toMatch(/^Start-Process -FilePath 'powershell\.exe' -Verb RunAs -WindowStyle Hidden/);
    expect(cmd).toContain("'-NoProfile','-NonInteractive','-Command',");
  });

  it('sets ELECTRON_RUN_AS_NODE INSIDE the elevated command, not in this parent', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    // The flag must live inside the -Command payload (elevated context)...
    expect(cmd).toContain("$env:ELECTRON_RUN_AS_NODE=''1''");
    // ...and NOT be set before Start-Process (which UAC would drop).
    expect(cmd.startsWith('$env:')).toBe(false);
    // The exe is invoked with the call operator inside that same payload.
    expect(cmd).toContain('& ');
  });

  it('quotes the exe, agent, and cfg paths for the elevated shell', () => {
    const cmd = elevationPsCommand(exe, agent, cfg);
    // Paths are doubly single-quoted because they sit inside the outer -Command string.
    expect(cmd).toContain(`''${exe}''`);
    expect(cmd).toContain(`''${agent}''`);
    expect(cmd).toContain(`''${cfg}''`);
  });

  it('escapes embedded single quotes in paths', () => {
    const weird = "C:\\Users\\O'Brien\\app.exe";
    const cmd = elevationPsCommand(weird, agent, cfg);
    // psQuote doubles the quote, then the outer psQuote doubles again → four quotes.
    expect(cmd).toContain("O''''Brien");
    expect(cmd).not.toContain("O'Brien"); // no unescaped single quote survives
  });
});
