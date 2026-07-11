import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from './generated/prisma';
import { ensureSchema } from './db';

/**
 * ensureSchema is the boot self-heal for installs seeded by an older app version.
 * These tests run it against throwaway SQLite DBs whose "Run" table predates the
 * claudeSessionId column.
 */
describe('ensureSchema (additive self-heal)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  async function oldSchemaClient(): Promise<PrismaClient> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nk-db-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'test.db').replace(/\\/g, '/');
    const c = new PrismaClient({ datasources: { db: { url: 'file:' + file } } });
    // Old-schema tables: deliberately WITHOUT the self-healed columns.
    await c.$executeRawUnsafe('CREATE TABLE "Run" ("id" TEXT PRIMARY KEY, "kind" TEXT, "pid" INTEGER)');
    await c.$executeRawUnsafe('CREATE TABLE "Project" ("id" TEXT PRIMARY KEY, "name" TEXT)');
    return c;
  }

  async function cols(c: PrismaClient, table: string): Promise<string[]> {
    const r = await c.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${table}")`);
    return r.map((x) => x.name);
  }

  it('adds every missing additive column (Run + Project) and is idempotent', async () => {
    const c = await oldSchemaClient();
    try {
      expect(await cols(c, 'Run')).not.toContain('claudeSessionId');
      expect(await cols(c, 'Project')).not.toContain('codeMapEmbed');
      await ensureSchema(c);
      expect(await cols(c, 'Run')).toContain('claudeSessionId'); // healed
      expect(await cols(c, 'Project')).toContain('codeMapEmbed'); // healed
      await ensureSchema(c); // second boot must be a clean no-op, not an error
      expect((await cols(c, 'Run')).filter((n) => n === 'claudeSessionId')).toHaveLength(1);
      expect((await cols(c, 'Project')).filter((n) => n === 'codeMapEmbed')).toHaveLength(1);
      // new whole table created for installs that predate it
      const tbls = await c.$queryRawUnsafe<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='EodReport'",
      );
      expect(tbls).toHaveLength(1);
    } finally {
      await c.$disconnect();
    }
  });

  it('leaves an already-migrated DB unchanged', async () => {
    const c = await oldSchemaClient();
    try {
      await c.$executeRawUnsafe('ALTER TABLE "Run" ADD COLUMN "claudeSessionId" TEXT');
      await c.$executeRawUnsafe('ALTER TABLE "Project" ADD COLUMN "codeMapEmbed" BOOLEAN NOT NULL DEFAULT 0');
      const before = { run: await cols(c, 'Run'), project: await cols(c, 'Project') };
      await ensureSchema(c);
      expect(await cols(c, 'Run')).toEqual(before.run);
      expect(await cols(c, 'Project')).toEqual(before.project);
    } finally {
      await c.$disconnect();
    }
  });
});
