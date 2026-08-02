// End-to-end tests for the stdio MCP bridge (mcp-bridge.mjs).
//
// The bridge is a real child process speaking newline-delimited JSON-RPC over
// stdio, so it is tested as one: spawn it against a throwaway http server
// standing in for the NARUKAMI backend, write frames to its stdin, and assert on
// what comes back on stdout. Nothing here imports the bridge — an in-process
// import would not exercise the framing, and the framing is half the contract.
//
// COLLECTION: vitest.config.ts collects `src/**/*.test.ts` only, so this file at
// the package root is NOT picked up on its own. src/services/mcpConfig.test.ts
// side-effect-imports it, which is what puts these suites in `npm run test:unit`.
// Keep that import or these tests stop running silently.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-bridge.mjs');
const SELF = 'self-run-id';

/** Requests the bridge made, newest last. Reset before every test. */
let calls = [];
/** Per-test route table: (call) => { status?, body? } | undefined for 404. */
let handler = () => undefined;

let server;
let child;
let baseUrl;

// --- JSON-RPC client over the child's stdio -------------------------------
let nextId = 1;
const pending = new Map();

function rpc(method, params, timeoutMs = 10_000) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`rpc timed out: ${method}`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

/** Call a tool and hand back the single text block MCP tool results carry. */
async function callTool(name, args, timeoutMs) {
  const msg = await rpc('tools/call', { name, arguments: args }, timeoutMs);
  expect(msg.error, `tools/call ${name} returned a protocol error`).toBeUndefined();
  return { text: msg.result?.content?.[0]?.text ?? '', isError: msg.result?.isError === true };
}

/**
 * The JSON header of a tool reply. wait_for_terminal appends a `\n--- last N
 * lines ---` block of raw terminal output after its JSON summary; the others are
 * JSON all the way through.
 */
function firstJson(text) {
  const cut = text.indexOf('\n---');
  return JSON.parse(cut === -1 ? text : text.slice(0, cut));
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const out = handler(call) ?? { status: 404, body: { error: `stub: no route for ${call.method} ${call.path}` } };
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  child = spawn(process.execPath, [BRIDGE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NARUKAMI_BASE_URL: baseUrl,
      NARUKAMI_TOKEN: 'test-token',
      NARUKAMI_SELF_RUN_ID: SELF,
    },
  });
  child.stderr.resume(); // the bridge logs diagnostics there; drain so it can't block
  child.stdout.setEncoding('utf8');
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  const init = await rpc('initialize', { protocolVersion: '2024-11-05' });
  expect(init.result?.serverInfo?.name).toBe('narukami-terminals');
});

afterAll(async () => {
  child?.kill();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  calls = [];
  handler = () => undefined;
});

describe('mcp-bridge tools/list', () => {
  it('advertises all seven orchestration tools', async () => {
    const msg = await rpc('tools/list');
    const names = msg.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'close_terminal',
        'list_terminals',
        'read_browser_logs',
        'read_terminal',
        'send_terminal',
        'spawn_terminal',
        'wait_for_terminal',
      ].sort(),
    );
  });

  it('gives every tool a non-trivial description and an object schema', async () => {
    const msg = await rpc('tools/list');
    for (const tool of msg.result.tools) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('spawn_terminal', () => {
  it('opens a shell in a project by id and returns the new terminal id', async () => {
    handler = (c) =>
      c.method === 'POST' && c.path === '/api/projects/proj-1/shell'
        ? { status: 201, body: { runId: 'new-run-1', pid: 4242, elevated: false } }
        : undefined;

    const { text, isError } = await callTool('spawn_terminal', { project_id: 'proj-1' });
    expect(isError).toBe(false);
    const out = firstJson(text);
    expect(out.terminal_id).toBe('new-run-1');
    expect(out.kind).toBe('shell');
    expect(out.pid).toBe(4242);

    const post = calls.find((c) => c.path === '/api/projects/proj-1/shell');
    expect(post.body).toEqual({ shell: 'powershell' });
    expect(post.auth).toBe('Bearer test-token');
  });

  it('resolves project_path against the registered project list', async () => {
    handler = (c) => {
      if (c.path === '/api/projects') {
        return { body: [{ id: 'proj-9', name: 'web', path: 'C:\\code\\web' }] };
      }
      if (c.path === '/api/projects/proj-9/shell') {
        return { status: 201, body: { runId: 'run-9', pid: 7 } };
      }
      return undefined;
    };

    const { text, isError } = await callTool('spawn_terminal', { project_path: 'C:\\code\\web\\' });
    expect(isError).toBe(false);
    expect(firstJson(text).terminal_id).toBe('run-9');
  });

  it('reports an unknown project_path instead of spawning anything', async () => {
    handler = (c) => (c.path === '/api/projects' ? { body: [] } : undefined);
    const { text, isError } = await callTool('spawn_terminal', { project_path: 'C:\\nope' });
    expect(isError).toBe(true);
    expect(text).toContain('No registered project has the path');
    expect(calls.some((c) => c.path.endsWith('/shell'))).toBe(false);
  });

  it('opens a claude tab and applies the label via the name endpoint', async () => {
    handler = (c) => {
      if (c.path === '/api/projects/p/claude') {
        return { status: 201, body: { runId: 'c1', pid: 9, sessionId: 'sess-1' } };
      }
      if (c.path === '/api/runs/c1/name') return { body: { ok: true, name: 'suite: web' } };
      return undefined;
    };

    const { text } = await callTool('spawn_terminal', {
      project_id: 'p',
      kind: 'claude',
      label: 'suite: web',
    });
    const out = firstJson(text);
    expect(out.terminal_id).toBe('c1');
    expect(out.claude_session_id).toBe('sess-1');
    expect(out.label).toBe('suite: web');
    expect(calls.find((c) => c.path === '/api/runs/c1/name').body).toEqual({ name: 'suite: web' });
  });

  it('surfaces the live tab id when a Continue collides (409)', async () => {
    handler = (c) =>
      c.path === '/api/projects/p/claude'
        ? {
            status: 409,
            body: {
              error: 'That Claude session is already open in a live tab — switch to it, or start a new Claude tab.',
              runId: 'live-tab-7',
              sessionId: 's7',
            },
          }
        : undefined;

    const { text, isError } = await callTool('spawn_terminal', {
      project_id: 'p',
      kind: 'claude',
      continue: true,
    });
    expect(isError).toBe(true);
    expect(text).toContain('already open in a live tab');
    expect(text).toContain('live-tab-7');
  });

  it('refuses to open an elevated shell and never calls the API', async () => {
    const { text, isError } = await callTool('spawn_terminal', { project_id: 'p', admin: true });
    expect(isError).toBe(true);
    expect(text).toContain('UAC');
    expect(calls).toEqual([]);
  });

  it('fails closed when the API accepts the spawn but returns no runId', async () => {
    handler = (c) => (c.path === '/api/projects/p/shell' ? { status: 201, body: {} } : undefined);
    const { text, isError } = await callTool('spawn_terminal', { project_id: 'p' });
    expect(isError).toBe(true);
    expect(text).toContain('returned no runId');
  });

  it('rejects an unknown kind', async () => {
    const { text, isError } = await callTool('spawn_terminal', { project_id: 'p', kind: 'admin' });
    expect(isError).toBe(true);
    expect(text).toContain("kind must be 'shell' or 'claude'");
    expect(calls).toEqual([]);
  });
});

describe('close_terminal', () => {
  it('refuses to close SELF and never calls the API', async () => {
    const { text, isError } = await callTool('close_terminal', { terminal_id: SELF });
    expect(isError).toBe(true);
    expect(text).toContain('Refusing to close yourself');
    expect(calls).toEqual([]);
  });

  it('closes another terminal over the close endpoint', async () => {
    handler = (c) =>
      c.method === 'POST' && c.path === '/api/runs/other-1/close'
        ? { body: { ok: true, stopped: true } }
        : undefined;

    const { text, isError } = await callTool('close_terminal', { terminal_id: 'other-1' });
    expect(isError).toBe(false);
    expect(text).toContain('Closed other-1');
    expect(text).toContain('stopped=true');
  });

  it('reports a 404 from the close endpoint as a tool error', async () => {
    handler = () => ({ status: 404, body: { error: 'Run not found.' } });
    const { text, isError } = await callTool('close_terminal', { terminal_id: 'ghost' });
    expect(isError).toBe(true);
    expect(text).toContain('Run not found.');
  });
});

describe('wait_for_terminal', () => {
  it('returns as soon as the idle endpoint reports idle, with the trailing output', async () => {
    handler = (c) => {
      if (c.path === '/api/terminals/t1/idle') {
        return {
          body: {
            runId: 't1',
            live: true,
            lastOutputAt: '2026-08-01T17:01:20.862Z',
            idleMs: 4000,
            idle: true,
            exited: false,
            exitCode: null,
          },
        };
      }
      if (c.path === '/api/terminals/t1/read') return { body: { live: true, text: 'PASS 551 tests' } };
      return undefined;
    };

    const started = Date.now();
    const { text, isError } = await callTool('wait_for_terminal', {
      terminal_id: 't1',
      require_new_output: false,
    });
    expect(isError).toBe(false);
    const out = firstJson(text);
    expect(out.reason).toBe('idle');
    expect(out.polls).toBe(1);
    expect(out.live).toBe(true);
    expect(text).toContain('PASS 551 tests');
    expect(Date.now() - started).toBeLessThan(3_000);
    // The threshold is forwarded, not assumed by the caller.
    expect(calls.find((c) => c.path === '/api/terminals/t1/idle').query.ms).toBe('1500');
  });

  it('waits for output produced after the wait began before reporting idle', async () => {
    let polls = 0;
    handler = (c) => {
      if (c.path === '/api/terminals/t2/idle') {
        polls += 1;
        // Poll 1 is already "idle" — but only on a stale timestamp from before
        // the wait started, which must NOT be mistaken for the command finishing.
        return {
          body: {
            runId: 't2',
            live: true,
            lastOutputAt: polls === 1 ? '2026-08-01T17:00:00.000Z' : '2026-08-01T17:00:09.000Z',
            idleMs: 9_000,
            idle: true,
            exited: false,
            exitCode: null,
          },
        };
      }
      if (c.path === '/api/terminals/t2/read') return { body: { live: true, text: 'done' } };
      return undefined;
    };

    const { text } = await callTool('wait_for_terminal', { terminal_id: 't2', poll_ms: 250 });
    const out = firstJson(text);
    expect(out.reason).toBe('idle');
    expect(out.polls).toBe(2);
    expect(out.saw_new_output).toBe(true);
  });

  it("reports reason 'exited' with the exit code when the process is gone", async () => {
    handler = (c) => {
      if (c.path === '/api/terminals/t3/idle') {
        return {
          body: {
            runId: 't3',
            live: false,
            lastOutputAt: null,
            idleMs: 0,
            idle: true,
            exited: true,
            exitCode: 1,
          },
        };
      }
      if (c.path === '/api/terminals/t3/read') return { body: { live: false, text: 'boom' } };
      return undefined;
    };

    const { text } = await callTool('wait_for_terminal', { terminal_id: 't3' });
    const out = firstJson(text);
    expect(out.reason).toBe('exited');
    expect(out.exited).toBe(true);
    expect(out.exit_code).toBe(1);
  });

  it('terminates on timeout when the terminal never goes quiet', async () => {
    handler = (c) => {
      if (c.path === '/api/terminals/t4/idle') {
        return {
          body: {
            runId: 't4',
            live: true,
            lastOutputAt: new Date().toISOString(),
            idleMs: 10,
            idle: false,
            exited: false,
            exitCode: null,
          },
        };
      }
      if (c.path === '/api/terminals/t4/read') return { body: { live: true, text: 'still building' } };
      return undefined;
    };

    const started = Date.now();
    const { text, isError } = await callTool(
      'wait_for_terminal',
      { terminal_id: 't4', timeout_ms: 1_000, poll_ms: 250 },
      15_000,
    );
    const elapsed = Date.now() - started;
    expect(isError).toBe(false);
    const out = firstJson(text);
    expect(out.reason).toBe('timeout');
    expect(out.polls).toBeGreaterThan(1);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
    expect(text).toContain('still building');
  }, 20_000);

  it('clamps out-of-range knobs to the endpoint\'s accepted window', async () => {
    handler = (c) => {
      if (c.path === '/api/terminals/t5/idle') {
        return { body: { runId: 't5', live: false, lastOutputAt: null, idleMs: 0, idle: true, exited: true, exitCode: 0 } };
      }
      if (c.path === '/api/terminals/t5/read') return { body: { live: false, text: '' } };
      return undefined;
    };

    await callTool('wait_for_terminal', { terminal_id: 't5', idle_ms: 5 });
    expect(calls.find((c) => c.path === '/api/terminals/t5/idle').query.ms).toBe('100');
  });
});

describe('read_browser_logs', () => {
  it('passes the since cursor through and hands back next_seq', async () => {
    handler = (c) =>
      c.path === '/api/projects/p1/browser-logs'
        ? {
            body: {
              events: [
                { seq: 12, ts: '2026-08-01T00:00:00.000Z', level: 'error', kind: 'exception', text: 'boom' },
              ],
              nextSeq: 12,
            },
          }
        : undefined;

    const { text, isError } = await callTool('read_browser_logs', {
      project_id: 'p1',
      since: 11,
      level: 'error',
      limit: 50,
    });
    expect(isError).toBe(false);
    const out = JSON.parse(text);
    expect(out.next_seq).toBe(12);
    expect(out.count).toBe(1);
    expect(out.events[0].text).toBe('boom');

    const q = calls.find((c) => c.path === '/api/projects/p1/browser-logs').query;
    expect(q).toEqual({ since: '11', level: 'error', limit: '50' });
  });

  it('omits since/level/limit entirely when they are not supplied', async () => {
    handler = () => ({ body: { events: [], nextSeq: 0 } });
    const { text } = await callTool('read_browser_logs', { project_id: 'p1' });
    expect(calls[0].query).toEqual({});
    expect(JSON.parse(text).note).toContain('No preview events');
  });

  it('reports an unknown project as a tool error', async () => {
    handler = () => ({ status: 404, body: { error: 'Project not found.' } });
    const { text, isError } = await callTool('read_browser_logs', { project_id: 'nope' });
    expect(isError).toBe(true);
    expect(text).toContain('Project not found.');
  });
});
