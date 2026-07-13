import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

const h = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  settingFindUnique: vi.fn(),
  settingUpsert: vi.fn(),
  settingDeleteMany: vi.fn(),
  releaseFindUnique: vi.fn(),
  releaseFindFirst: vi.fn(),
  releaseFindMany: vi.fn(),
  releaseCreate: vi.fn(),
  releaseUpdate: vi.fn(),
  releaseDelete: vi.fn(),
  releasePreflight: vi.fn(),
  buildReleaseZip: vi.fn(),
  collectNotesMaterial: vi.fn(),
  generateReleaseNotes: vi.fn(),
  commitVersionBump: vi.fn(),
  pushCurrentBranch: vi.fn(),
}));

vi.mock('../db', () => ({
  prisma: {
    project: { findUnique: h.projectFindUnique },
    appSetting: {
      findUnique: h.settingFindUnique,
      upsert: h.settingUpsert,
      deleteMany: h.settingDeleteMany,
    },
    release: {
      findUnique: h.releaseFindUnique,
      findFirst: h.releaseFindFirst,
      findMany: h.releaseFindMany,
      create: h.releaseCreate,
      update: h.releaseUpdate,
      delete: h.releaseDelete,
    },
  },
}));

vi.mock('../services/release', async () => {
  const real = await vi.importActual<typeof import('../services/release')>('../services/release');
  return {
    ...real,
    releasePreflight: h.releasePreflight,
    buildReleaseZip: h.buildReleaseZip,
    collectNotesMaterial: h.collectNotesMaterial,
    commitVersionBump: h.commitVersionBump,
    pushCurrentBranch: h.pushCurrentBranch,
  };
});

vi.mock('../services/analyzer', () => {
  class AnalyzerError extends Error {}
  return { AnalyzerError, generateReleaseNotes: h.generateReleaseNotes };
});

import { releaseRoutes } from './release';
import { AnalyzerError } from '../services/analyzer';

function stubLogger() {
  const log = {
    fatal: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {}, error: () => {},
    child: () => log,
  };
  return log;
}

const PROJECT = { id: 'p1', name: 'SGEN', path: 'C:/repo/sgen' };

const CLEAN_PREFLIGHT = {
  isRepo: true,
  isSga: true,
  missing: [] as string[],
  currentVersion: '2.7.0',
  suggestedVersion: '2.7.1',
  dirty: [] as Array<{ path: string; status: string }>,
  branch: 'main',
};

function releaseRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    projectId: 'p1',
    version: '2.7.1',
    zipPath: 'C:/home/sgen-claude-chat-v2.7.1.zip',
    zipBytes: 1234,
    headCommit: 'abc1234',
    dirtyIncluded: false,
    summary: null,
    notes: null,
    createdAt: new Date('2026-07-12T10:00:00Z'),
    updatedAt: new Date('2026-07-12T10:00:00Z'),
    ...over,
  };
}

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ loggerInstance: stubLogger() as unknown as FastifyBaseLogger });
  await app.register(releaseRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  h.projectFindUnique.mockReset().mockResolvedValue(PROJECT);
  h.settingFindUnique.mockReset().mockResolvedValue(null);
  h.settingUpsert.mockReset().mockResolvedValue({});
  h.settingDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  h.releaseFindUnique.mockReset();
  h.releaseFindFirst.mockReset().mockResolvedValue(null);
  h.releaseFindMany.mockReset().mockResolvedValue([]);
  h.releaseCreate.mockReset();
  h.releaseUpdate.mockReset();
  h.releaseDelete.mockReset().mockResolvedValue({});
  h.releasePreflight.mockReset().mockResolvedValue({ ...CLEAN_PREFLIGHT });
  h.buildReleaseZip.mockReset();
  h.commitVersionBump.mockReset();
  h.pushCurrentBranch.mockReset();
  h.collectNotesMaterial.mockReset().mockResolvedValue({
    changelog: '- change',
    commits: 'abc feat: x',
    rangeLabel: 'commits since the last version bump',
  });
  h.generateReleaseNotes.mockReset();
});

describe('GET /api/projects/:id/release/preflight', () => {
  it('404s on a missing project', async () => {
    h.projectFindUnique.mockResolvedValue(null);
    const r = await app.inject({ method: 'GET', url: '/api/projects/nope/release/preflight' });
    expect(r.statusCode).toBe(404);
  });

  it('returns the preflight + saved releases + the zip folder (default = home)', async () => {
    h.releaseFindMany.mockResolvedValue([releaseRow()]);
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/release/preflight' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ isSga: true, currentVersion: '2.7.0', suggestedVersion: '2.7.1', releasing: false });
    expect(body.zipDir).toBe(os.homedir());
    expect(body.releases).toHaveLength(1);
    expect(body.releases[0]).toMatchObject({ id: 'r1', version: '2.7.1', zipExists: false });
  });

  it('echoes the persisted zip folder when set', async () => {
    h.settingFindUnique.mockResolvedValue({ key: 'releaseZipDir', value: JSON.stringify('C:/releases') });
    const r = await app.inject({ method: 'GET', url: '/api/projects/p1/release/preflight' });
    expect(r.json().zipDir).toBe('C:/releases');
  });
});

describe('POST /api/release/zip-dir', () => {
  it('persists a valid absolute folder (creating it) and returns the resolved path', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-zipset-'));
    const target = path.join(base, 'nested', 'releases');
    try {
      const r = await app.inject({ method: 'POST', url: '/api/release/zip-dir', payload: { dir: target } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, zipDir: path.resolve(target), isDefault: false });
      expect(fs.existsSync(target)).toBe(true); // created recursively
      expect(h.settingUpsert.mock.calls[0][0]).toMatchObject({
        where: { key: 'releaseZipDir' },
        create: { key: 'releaseZipDir', value: JSON.stringify(path.resolve(target)) },
      });
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('400s on a relative path and persists nothing', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/release/zip-dir', payload: { dir: 'relative/folder' } });
    expect(r.statusCode).toBe(400);
    expect(h.settingUpsert).not.toHaveBeenCalled();
  });

  it('an empty dir resets to the home-dir default', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/release/zip-dir', payload: { dir: '' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, zipDir: os.homedir(), isDefault: true });
    expect(h.settingDeleteMany).toHaveBeenCalledWith({ where: { key: 'releaseZipDir' } });
  });
});

describe('POST /api/projects/:id/release', () => {
  it('400s when the project is not the SGA shape', async () => {
    h.releasePreflight.mockResolvedValue({ ...CLEAN_PREFLIGHT, isSga: false, missing: ['VERSION.md'] });
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('VERSION.md');
    expect(h.buildReleaseZip).not.toHaveBeenCalled();
  });

  it('400s on a malformed version', async () => {
    const r = await app.inject({
      method: 'POST', url: '/api/projects/p1/release', payload: { version: 'lots' },
    });
    expect(r.statusCode).toBe(400);
    expect(h.buildReleaseZip).not.toHaveBeenCalled();
  });

  it('409s when the tree is dirty (beyond the version files) and includeDirty is not set', async () => {
    h.releasePreflight.mockResolvedValue({
      ...CLEAN_PREFLIGHT,
      dirty: [
        { path: 'bridge/server.js', status: 'modified' },
        { path: 'VERSION.md', status: 'modified' }, // exempt — release's own file
      ],
    });
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().dirty).toEqual([{ path: 'bridge/server.js', status: 'modified' }]);
    expect(h.buildReleaseZip).not.toHaveBeenCalled();
  });

  it('a dirty tree consisting ONLY of the version files needs no confirmation', async () => {
    h.releasePreflight.mockResolvedValue({
      ...CLEAN_PREFLIGHT,
      dirty: [{ path: 'VERSION.md', status: 'modified' }],
    });
    h.buildReleaseZip.mockResolvedValue({
      zipPath: 'C:/home/sgen-claude-chat-v2.7.1.zip', zipBytes: 999, headCommit: 'abc', archivedTree: 'stash1',
    });
    h.releaseCreate.mockResolvedValue(releaseRow());
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
    expect(r.statusCode).toBe(201);
  });

  it('builds the zip with the suggested version by default and records the row', async () => {
    h.buildReleaseZip.mockResolvedValue({
      zipPath: 'C:/home/sgen-claude-chat-v2.7.1.zip', zipBytes: 999, headCommit: 'abc', archivedTree: 'stash1',
    });
    h.releaseCreate.mockResolvedValue(releaseRow());
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
    expect(r.statusCode).toBe(201);
    expect(h.buildReleaseZip).toHaveBeenCalledWith('C:/repo/sgen', '2.7.1', os.homedir());
    expect(h.releaseCreate.mock.calls[0][0]).toMatchObject({
      data: { projectId: 'p1', version: '2.7.1', zipBytes: 999, dirtyIncluded: false },
    });
  });

  it('builds into the PERSISTED zip folder when the setting exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-zipdir-'));
    try {
      h.settingFindUnique.mockResolvedValue({ key: 'releaseZipDir', value: JSON.stringify(dir) });
      h.buildReleaseZip.mockResolvedValue({
        zipPath: path.join(dir, 'sgen-claude-chat-v2.7.1.zip'), zipBytes: 999, headCommit: 'abc', archivedTree: 's',
      });
      h.releaseCreate.mockResolvedValue(releaseRow());
      const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
      expect(r.statusCode).toBe(201);
      expect(h.buildReleaseZip).toHaveBeenCalledWith('C:/repo/sgen', '2.7.1', path.resolve(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors an explicit version + includeDirty and flags dirtyIncluded', async () => {
    h.releasePreflight.mockResolvedValue({
      ...CLEAN_PREFLIGHT,
      dirty: [{ path: 'bridge/server.js', status: 'modified' }],
    });
    h.buildReleaseZip.mockResolvedValue({
      zipPath: 'C:/home/sgen-claude-chat-v3.0.0.zip', zipBytes: 999, headCommit: 'abc', archivedTree: 'stash1',
    });
    h.releaseCreate.mockResolvedValue(releaseRow({ version: '3.0.0', dirtyIncluded: true }));
    const r = await app.inject({
      method: 'POST', url: '/api/projects/p1/release', payload: { version: '3.0.0', includeDirty: true },
    });
    expect(r.statusCode).toBe(201);
    expect(h.buildReleaseZip).toHaveBeenCalledWith('C:/repo/sgen', '3.0.0', os.homedir());
    expect(h.releaseCreate.mock.calls[0][0]).toMatchObject({ data: { dirtyIncluded: true } });
  });

  it('500s (with detail) when the zip build blows up', async () => {
    h.buildReleaseZip.mockRejectedValue(new Error('git exploded'));
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release', payload: {} });
    expect(r.statusCode).toBe(500);
    expect(r.json().detail).toContain('git exploded');
  });
});

describe('POST /api/projects/:id/release/commit', () => {
  it('commits the bump and returns the auto message + hash', async () => {
    h.commitVersionBump.mockResolvedValue({
      commit: 'abc123def', message: 'chore(release): bump to v2.7.1',
      files: ['VERSION.md', 'bridge/package.json', 'extension/manifest.json'],
    });
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release/commit' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, commit: 'abc123def', message: 'chore(release): bump to v2.7.1' });
    expect(h.commitVersionBump).toHaveBeenCalledWith('C:/repo/sgen');
  });

  it('409s when the version files match HEAD', async () => {
    h.commitVersionBump.mockRejectedValue(new Error('Nothing to commit — the three version files match HEAD.'));
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release/commit' });
    expect(r.statusCode).toBe(409);
  });

  it('404s on a missing project', async () => {
    h.projectFindUnique.mockResolvedValue(null);
    const r = await app.inject({ method: 'POST', url: '/api/projects/nope/release/commit' });
    expect(r.statusCode).toBe(404);
  });
});

describe('POST /api/projects/:id/release/push', () => {
  it('pushes the current branch and reports upstream creation', async () => {
    h.pushCurrentBranch.mockResolvedValue({ branch: 'main', upstreamCreated: true, detail: 'branch set up to track' });
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release/push' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, branch: 'main', upstreamCreated: true });
    expect(h.pushCurrentBranch).toHaveBeenCalledWith('C:/repo/sgen');
  });

  it("502s with git's own words when the push fails", async () => {
    h.pushCurrentBranch.mockRejectedValue(
      Object.assign(new Error('push failed'), { stderr: 'fatal: could not read from remote repository' }),
    );
    const r = await app.inject({ method: 'POST', url: '/api/projects/p1/release/push' });
    expect(r.statusCode).toBe(502);
    expect(r.json().detail).toContain('could not read from remote');
  });
});

describe('POST /api/releases/:id/notes', () => {
  it('404s on a missing release', async () => {
    h.releaseFindUnique.mockResolvedValue(null);
    const r = await app.inject({ method: 'POST', url: '/api/releases/nope/notes' });
    expect(r.statusCode).toBe(404);
  });

  it('generates and persists summary + notes', async () => {
    h.releaseFindUnique.mockResolvedValue({ ...releaseRow(), project: PROJECT });
    h.generateReleaseNotes.mockResolvedValue({ summary: '**SG Assistant 2.7.1** — better.', description: '- Fixed things.' });
    h.releaseUpdate.mockResolvedValue(releaseRow({ summary: '**SG Assistant 2.7.1** — better.', notes: '- Fixed things.' }));
    const r = await app.inject({ method: 'POST', url: '/api/releases/r1/notes' });
    expect(r.statusCode).toBe(200);
    expect(h.generateReleaseNotes.mock.calls[0][0]).toBe('C:/repo/sgen');
    expect(h.generateReleaseNotes.mock.calls[0][1]).toMatchObject({ product: 'SG Assistant', version: '2.7.1' });
    expect(h.releaseUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: 'r1' },
      data: { summary: '**SG Assistant 2.7.1** — better.', notes: '- Fixed things.' },
    });
    expect(r.json().summary).toContain('SG Assistant');
  });

  it('passes the previous release HEAD as the git-log boundary', async () => {
    h.releaseFindUnique.mockResolvedValue({ ...releaseRow(), project: PROJECT });
    h.releaseFindFirst.mockResolvedValue(releaseRow({ id: 'r0', headCommit: 'prev123' }));
    h.generateReleaseNotes.mockResolvedValue({ summary: 's', description: 'd' });
    h.releaseUpdate.mockResolvedValue(releaseRow({ summary: 's', notes: 'd' }));
    await app.inject({ method: 'POST', url: '/api/releases/r1/notes' });
    expect(h.collectNotesMaterial).toHaveBeenCalledWith('C:/repo/sgen', 'prev123');
  });

  it('502s on an AnalyzerError (claude failure), leaving the release intact', async () => {
    h.releaseFindUnique.mockResolvedValue({ ...releaseRow(), project: PROJECT });
    h.generateReleaseNotes.mockRejectedValue(new AnalyzerError('claude -p timed out'));
    const r = await app.inject({ method: 'POST', url: '/api/releases/r1/notes' });
    expect(r.statusCode).toBe(502);
    expect(h.releaseUpdate).not.toHaveBeenCalled();
  });
});

describe('GET /api/releases/:id/zip', () => {
  it('404s when the zip no longer exists on disk', async () => {
    h.releaseFindUnique.mockResolvedValue(releaseRow({ zipPath: 'C:/definitely/not/here.zip' }));
    const r = await app.inject({ method: 'GET', url: '/api/releases/r1/zip' });
    expect(r.statusCode).toBe(404);
  });

  it('streams a real zip with attachment headers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'narukami-zipserve-'));
    const zipPath = path.join(dir, 'sgen-claude-chat-v2.7.1.zip');
    fs.writeFileSync(zipPath, Buffer.from('PK\x03\x04fixture'));
    try {
      h.releaseFindUnique.mockResolvedValue(releaseRow({ zipPath }));
      const r = await app.inject({ method: 'GET', url: '/api/releases/r1/zip' });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('application/zip');
      expect(r.headers['content-disposition']).toContain('sgen-claude-chat-v2.7.1.zip');
      expect(r.rawPayload.subarray(0, 2).toString()).toBe('PK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/releases/:id', () => {
  it('deletes the row (not the file) and returns ok', async () => {
    h.releaseFindUnique.mockResolvedValue(releaseRow());
    const r = await app.inject({ method: 'DELETE', url: '/api/releases/r1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(h.releaseDelete).toHaveBeenCalledWith({ where: { id: 'r1' } });
  });
});
