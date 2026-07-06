import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

type Api = typeof import('./api');
let apiMod: Api;

function makeResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeAll(async () => {
  vi.stubEnv('VITE_RUNNER_TOKEN', 'testtoken123');
  vi.resetModules();
  apiMod = await import('./api');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasToken', () => {
  it('is true for a real token', () => {
    expect(apiMod.hasToken()).toBe(true);
  });

  it('is false for the placeholder or an empty token', async () => {
    vi.stubEnv('VITE_RUNNER_TOKEN', 'paste-the-token-here');
    vi.resetModules();
    expect((await import('./api')).hasToken()).toBe(false);

    vi.stubEnv('VITE_RUNNER_TOKEN', '');
    vi.resetModules();
    expect((await import('./api')).hasToken()).toBe(false);

    // restore the good token for the remaining tests
    vi.stubEnv('VITE_RUNNER_TOKEN', 'testtoken123');
    vi.resetModules();
    apiMod = await import('./api');
  });
});

describe('runWsUrl', () => {
  it('builds a token-authed ws url and encodes the runId', () => {
    expect(apiMod.runWsUrl('r 1')).toBe('ws://127.0.0.1:4000/ws/runs/r%201?token=testtoken123');
  });
});

describe('request + api methods', () => {
  it('GET listProjects hits the right URL with a bearer header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(200, '[{"id":"p1"}]'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiMod.api.listProjects();
    expect(res).toEqual([{ id: 'p1' }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/projects');
    expect(init.headers.Authorization).toBe('Bearer testtoken123');
  });

  it('POST addProject sends a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(201, '{"id":"p2"}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiMod.api.addProject('C:/proj');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ path: 'C:/proj' });
  });

  it('openClaude posts the effort level', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(201, '{"runId":"r1","pid":9}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiMod.api.openClaude('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/projects/p1/claude');
    expect(JSON.parse(init.body)).toEqual({ effort: 'ultracode' });
  });

  it('run posts the commandId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(201, '{"runId":"r1","pid":9}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiMod.api.run('p1', 'cmd1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4000/api/projects/p1/run');
    expect(JSON.parse(init.body)).toEqual({ commandId: 'cmd1' });
  });

  it('deleteProject issues a DELETE and tolerates a 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse(204, ''));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiMod.api.deleteProject('p1');
    expect(res).toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('throws the server error message on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(400, '{"error":"bad path"}')));
    await expect(apiMod.api.addProject('x')).rejects.toThrow('bad path');
  });

  it('throws a generic message when the error body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeResponse(500, '')));
    await expect(apiMod.api.listProjects()).rejects.toThrow('Request failed (500)');
  });

  it('throws the intended message (not a SyntaxError) on a NON-JSON error body', async () => {
    // A proxy/HTML 500 body previously blew up in JSON.parse before the res.ok
    // check, surfacing a raw SyntaxError instead of the useful status message.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(makeResponse(502, '<html><body>Bad Gateway</body></html>')),
    );
    await expect(apiMod.api.listProjects()).rejects.toThrow('Request failed (502)');
  });
});
