import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock('../db', () => ({
  prisma: { appSetting: { findUnique: h.findUnique } },
}));

type Mod = typeof import('./browserLogs');
let mod: Mod;

// The ring is module-level state, so each test gets a FRESH module instance —
// otherwise the project cap test would be polluted by every project id used above it.
beforeEach(async () => {
  vi.resetModules();
  mod = await import('./browserLogs');
  h.findUnique.mockReset().mockResolvedValue(null);
});

/** A Runtime.consoleAPICalled message as CDP delivers it. */
function consoleCall(type: string, ...values: unknown[]): { method: string; params: unknown } {
  return {
    method: 'Runtime.consoleAPICalled',
    params: { type, args: values.map((v) => ({ type: typeof v, value: v })) },
  };
}

function exception(description: string): { method: string; params: unknown } {
  return {
    method: 'Runtime.exceptionThrown',
    params: { exceptionDetails: { exception: { description } } },
  };
}

function request(id: string, url: string): { method: string; params: unknown } {
  return { method: 'Network.requestWillBeSent', params: { requestId: id, request: { url } } };
}

function response(id: string, status: number, url: string): { method: string; params: unknown } {
  return { method: 'Network.responseReceived', params: { requestId: id, response: { status, url } } };
}

function failed(id: string, errorText: string): { method: string; params: unknown } {
  return { method: 'Network.loadingFailed', params: { requestId: id, errorText } };
}

describe('recordBrowserEvents — CDP normalization', () => {
  it('maps a console call to its own type and keeps the joined args as text', () => {
    expect(mod.recordBrowserEvents('p1', [consoleCall('warning', 'hot reload', 42)])).toBe(1);
    const { events } = mod.readBrowserEvents('p1', {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      seq: 1,
      level: 'warn',
      kind: 'console.warning',
      text: 'hot reload 42',
    });
    expect(typeof events[0].ts).toBe('string');
  });

  it('maps console levels: error/assert → error, info → info, everything else → log', () => {
    mod.recordBrowserEvents('p1', [
      consoleCall('error', 'boom'),
      consoleCall('assert', 'nope'),
      consoleCall('info', 'fyi'),
      consoleCall('debug', 'noisy'),
      consoleCall('table', 'rows'),
    ]);
    const { events } = mod.readBrowserEvents('p1', {});
    expect(events.map((e) => e.level)).toEqual(['error', 'error', 'info', 'log', 'log']);
  });

  it('maps an uncaught exception to level error with the stack as text', () => {
    mod.recordBrowserEvents('p1', [exception('TypeError: x is not a function\n    at App.tsx:12')]);
    const [e] = mod.readBrowserEvents('p1', {}).events;
    expect(e.level).toBe('error');
    expect(e.kind).toBe('exception');
    expect(e.text).toContain('TypeError: x is not a function');
  });

  it('falls back to exceptionDetails.text when there is no exception object', () => {
    mod.recordBrowserEvents('p1', [
      { method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Script error.' } } },
    ]);
    expect(mod.readBrowserEvents('p1', {}).events[0].text).toBe('Script error.');
  });

  it('stores nothing for a request or a successful response', () => {
    const stored = mod.recordBrowserEvents('p1', [
      request('r1', 'http://localhost:5173/src/App.tsx'),
      response('r1', 200, 'http://localhost:5173/src/App.tsx'),
    ]);
    expect(stored).toBe(0);
    expect(mod.readBrowserEvents('p1', {}).events).toEqual([]);
  });

  it('stores a >=400 response as a network event with url and status', () => {
    mod.recordBrowserEvents('p1', [
      request('r1', 'http://localhost:5173/api/users'),
      response('r1', 500, 'http://localhost:5173/api/users'),
    ]);
    const [e] = mod.readBrowserEvents('p1', {}).events;
    expect(e).toMatchObject({
      level: 'network',
      kind: 'response',
      status: 500,
      url: 'http://localhost:5173/api/users',
    });
    expect(e.text).toContain('500');
  });

  it('names the url a failed request was for, taken from its earlier requestWillBeSent', () => {
    mod.recordBrowserEvents('p1', [
      request('r7', 'http://localhost:5173/missing.js'),
      failed('r7', 'net::ERR_ABORTED'),
    ]);
    const [e] = mod.readBrowserEvents('p1', {}).events;
    expect(e).toMatchObject({
      level: 'network',
      kind: 'request-failed',
      text: 'net::ERR_ABORTED',
      url: 'http://localhost:5173/missing.js',
    });
    expect(e.status).toBeUndefined();
  });

  it('still stores a failure whose request was never seen (no url field)', () => {
    mod.recordBrowserEvents('p1', [failed('unknown', 'net::ERR_CONNECTION_REFUSED')]);
    const [e] = mod.readBrowserEvents('p1', {}).events;
    expect(e.level).toBe('network');
    expect(e.url).toBeUndefined();
  });

  it('ignores unknown methods and malformed entries', () => {
    expect(
      mod.recordBrowserEvents('p1', [
        { method: 'Network.dataReceived', params: {} },
        { method: 'Runtime.executionContextCreated', params: {} },
      ]),
    ).toBe(0);
    expect(mod.recordBrowserEvents('p1', [])).toBe(0);
    expect(mod.recordBrowserEvents('', [consoleCall('log', 'x')])).toBe(0);
    expect(mod.readBrowserEvents('p1', {}).events).toEqual([]);
  });

  it('clips a huge console payload so one log line cannot own the heap', () => {
    mod.recordBrowserEvents('p1', [consoleCall('log', 'x'.repeat(50_000))]);
    const [e] = mod.readBrowserEvents('p1', {}).events;
    expect(e.text).toHaveLength(mod.BROWSER_LOG_TEXT_MAX);
    expect(e.text.endsWith('…')).toBe(true);
  });
});

describe('readBrowserEvents — filtering', () => {
  beforeEach(() => {
    mod.recordBrowserEvents('p1', [
      consoleCall('log', 'one'),
      consoleCall('error', 'two'),
      consoleCall('log', 'three'),
      request('r1', 'http://localhost:5173/a.js'),
      failed('r1', 'net::ERR_ABORTED'),
    ]);
  });

  it('returns only events newer than `since` and reports the next cursor', () => {
    const first = mod.readBrowserEvents('p1', {});
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first.nextSeq).toBe(4);

    const next = mod.readBrowserEvents('p1', { since: first.nextSeq });
    expect(next.events).toEqual([]);
    expect(next.nextSeq).toBe(4);

    mod.recordBrowserEvents('p1', [consoleCall('log', 'four')]);
    const after = mod.readBrowserEvents('p1', { since: first.nextSeq });
    expect(after.events.map((e) => e.text)).toEqual(['four']);
    expect(after.nextSeq).toBe(5);
  });

  it('filters by exact level', () => {
    expect(mod.readBrowserEvents('p1', { level: 'error' }).events.map((e) => e.text)).toEqual(['two']);
    expect(mod.readBrowserEvents('p1', { level: 'network' }).events).toHaveLength(1);
    expect(mod.readBrowserEvents('p1', { level: 'warn' }).events).toEqual([]);
  });

  it('advances the cursor past filtered-out events so a level poller does not stall', () => {
    const errs = mod.readBrowserEvents('p1', { level: 'error' });
    expect(errs.nextSeq).toBe(4);
  });

  it('never walks the cursor backwards for a project with nothing recorded', () => {
    expect(mod.readBrowserEvents('p-unknown', { since: 9 })).toEqual({ events: [], nextSeq: 9 });
    expect(mod.readBrowserEvents('p-unknown', {})).toEqual({ events: [], nextSeq: 0 });
  });

  it('keeps projects isolated', () => {
    mod.recordBrowserEvents('p2', [consoleCall('log', 'other project')]);
    expect(mod.readBrowserEvents('p1', {}).events.map((e) => e.text)).not.toContain('other project');
    expect(mod.readBrowserEvents('p2', {}).events).toHaveLength(1);
    expect(mod.readBrowserEvents('p2', {}).events[0].seq).toBe(1);
  });
});

describe('readBrowserEvents — limits', () => {
  beforeEach(() => {
    for (let i = 1; i <= 350; i += 1) mod.recordBrowserEvents('p1', [consoleCall('log', `#${i}`)]);
  });

  it('evicts the oldest events past the per-project cap but never rewinds seq', () => {
    const all = mod.readBrowserEvents('p1', { limit: mod.BROWSER_LOG_LIMIT_MAX });
    expect(all.events).toHaveLength(mod.BROWSER_LOG_RING_MAX);
    expect(all.events[0].seq).toBe(350 - mod.BROWSER_LOG_RING_MAX + 1);
    expect(all.events[all.events.length - 1].text).toBe('#350');
    expect(all.nextSeq).toBe(350);
  });

  it('defaults to the newest BROWSER_LOG_LIMIT_DEFAULT events', () => {
    const { events } = mod.readBrowserEvents('p1', {});
    expect(events).toHaveLength(mod.BROWSER_LOG_LIMIT_DEFAULT);
    expect(events[events.length - 1].text).toBe('#350');
    expect(events[0].seq).toBe(350 - mod.BROWSER_LOG_LIMIT_DEFAULT + 1);
  });

  it('clamps an out-of-range limit instead of trusting it', () => {
    expect(mod.readBrowserEvents('p1', { limit: 10_000 }).events).toHaveLength(mod.BROWSER_LOG_RING_MAX);
    expect(mod.readBrowserEvents('p1', { limit: 0 }).events).toHaveLength(1);
    expect(mod.readBrowserEvents('p1', { limit: -5 }).events).toHaveLength(1);
  });
});

describe('bounded project tracking', () => {
  it('evicts the least-recently-written project past the cap', () => {
    for (let i = 0; i < mod.BROWSER_LOG_PROJECT_MAX; i += 1) {
      mod.recordBrowserEvents(`p${i}`, [consoleCall('log', `project ${i}`)]);
    }
    // Touch p0 so p1 becomes the least-recently-written.
    mod.recordBrowserEvents('p0', [consoleCall('log', 'still alive')]);
    mod.recordBrowserEvents('overflow', [consoleCall('log', 'newcomer')]);

    expect(mod.readBrowserEvents('p1', {}).events).toEqual([]);
    expect(mod.readBrowserEvents('p0', {}).events).toHaveLength(2);
    expect(mod.readBrowserEvents('overflow', {}).events).toHaveLength(1);
  });
});

describe('clearBrowserEvents', () => {
  it('drops the buffered events but keeps the cursor monotonic', () => {
    mod.recordBrowserEvents('p1', [consoleCall('log', 'a'), consoleCall('log', 'b')]);
    mod.clearBrowserEvents('p1');

    const cleared = mod.readBrowserEvents('p1', {});
    expect(cleared.events).toEqual([]);
    expect(cleared.nextSeq).toBe(2);

    mod.recordBrowserEvents('p1', [consoleCall('log', 'c')]);
    expect(mod.readBrowserEvents('p1', { since: 2 }).events.map((e) => e.seq)).toEqual([3]);
  });

  it('is a no-op for a project that was never recorded', () => {
    expect(() => mod.clearBrowserEvents('nobody')).not.toThrow();
  });

  it('forgets in-flight requests so a stale requestId cannot attach a url later', () => {
    mod.recordBrowserEvents('p1', [request('r1', 'http://localhost:5173/a.js')]);
    mod.clearBrowserEvents('p1');
    mod.recordBrowserEvents('p1', [failed('r1', 'net::ERR_ABORTED')]);
    expect(mod.readBrowserEvents('p1', {}).events[0].url).toBeUndefined();
  });
});

describe('previewProjectId', () => {
  const ui = (value: unknown): { value: string } => ({ value: JSON.stringify(value) });

  it('prefers the selected project when its stored preview url agrees', async () => {
    h.findUnique.mockResolvedValue(
      ui({
        selectedId: 'proj-b',
        browserUrlByProject: {
          'proj-a': 'http://localhost:5173/',
          'proj-b': 'http://localhost:3000/dashboard',
        },
      }),
    );
    await expect(mod.previewProjectId('http://localhost:3000/other')).resolves.toBe('proj-b');
  });

  it('trusts an exact url match when the selected project disagrees', async () => {
    h.findUnique.mockResolvedValue(
      ui({
        selectedId: 'proj-b',
        browserUrlByProject: {
          'proj-a': 'http://localhost:5173/',
          'proj-b': 'http://localhost:3000/',
        },
      }),
    );
    await expect(mod.previewProjectId('http://localhost:5173/')).resolves.toBe('proj-a');
  });

  it('falls back to the selected project when no stored url matches', async () => {
    h.findUnique.mockResolvedValue(ui({ selectedId: 'proj-b', browserUrlByProject: {} }));
    await expect(mod.previewProjectId('http://localhost:4321/')).resolves.toBe('proj-b');
  });

  it('returns null with no ui state, no selection, or an unreadable row', async () => {
    h.findUnique.mockResolvedValue(null);
    await expect(mod.previewProjectId('http://localhost:5173/')).resolves.toBeNull();

    h.findUnique.mockResolvedValue({ value: 'not json' });
    await expect(mod.previewProjectId('http://localhost:5173/')).resolves.toBeNull();

    h.findUnique.mockResolvedValue(ui({ browserUrlByProject: { a: 'http://localhost:9/' } }));
    await expect(mod.previewProjectId('http://localhost:5173/')).resolves.toBeNull();

    h.findUnique.mockRejectedValue(new Error('db down'));
    await expect(mod.previewProjectId('http://localhost:5173/')).resolves.toBeNull();

    h.findUnique.mockResolvedValue(ui({ selectedId: 'proj-b' }));
    await expect(mod.previewProjectId('')).resolves.toBeNull();
  });
});
