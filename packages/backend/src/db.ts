import { PrismaClient } from './generated/prisma';

export const prisma = new PrismaClient();

/**
 * Additive columns that newer app versions expect but an OLDER-seeded database
 * won't have. Keep this in lockstep with any `ADD COLUMN` migration on an
 * existing table. Each is re-applied idempotently by {@link ensureSchema}.
 */
const ADDITIVE_COLUMNS: ReadonlyArray<{ table: string; column: string; ddl: string }> = [
  { table: 'Run', column: 'claudeSessionId', ddl: 'ALTER TABLE "Run" ADD COLUMN "claudeSessionId" TEXT' },
  { table: 'RunCommand', column: 'shell', ddl: `ALTER TABLE "RunCommand" ADD COLUMN "shell" TEXT NOT NULL DEFAULT 'powershell'` },
  { table: 'Run', column: 'shell', ddl: 'ALTER TABLE "Run" ADD COLUMN "shell" TEXT' },
];

/**
 * Columns left behind by a REMOVED feature. The packaged app never runs Prisma
 * migrations (see {@link ensureSchema}), so a column deleted from schema.prisma
 * would otherwise linger forever in every already-seeded database. Each is
 * dropped idempotently at boot, guarded by `PRAGMA table_info`.
 *
 * Unlike {@link ADDITIVE_COLUMNS} this DESTROYS data — list a column here only
 * once the feature that owned it is gone and its values are meaningless.
 */
const REMOVED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  // Code Map (the codebase-memory-mcp "Embed in Claude" toggle) — feature removed.
  { table: 'Project', column: 'codeMapEmbed' },
];

/**
 * Whole tables left behind by a REMOVED model. The table-level analogue of
 * {@link REMOVED_COLUMNS}: deleting a `model` from schema.prisma only reaches a
 * database that gets migrated, and the packaged app never migrates (see
 * {@link ensureSchema}) — so the table would linger forever in every install
 * seeded before the removal. Dropped idempotently via `DROP TABLE IF EXISTS`,
 * which takes the table's indexes with it.
 *
 * Like {@link REMOVED_COLUMNS} this DESTROYS data — list a table here only once
 * the feature that owned it is gone and its rows are meaningless.
 */
const REMOVED_TABLES: ReadonlyArray<string> = [
  // Per-project End-of-Day snapshot — superseded by the cross-project EodReport.
  // Never had a route or a call site outside the generated client.
  'EodEntry',
];

/**
 * Whole tables a newer app version adds that an OLDER-seeded database won't have.
 * Each statement is `CREATE TABLE/INDEX IF NOT EXISTS`, so it is idempotent. Keep
 * in lockstep with any new `model` in schema.prisma.
 */
const ADDITIVE_TABLES: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS "EodReport" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "day" TEXT NOT NULL,
     "markdown" TEXT NOT NULL,
     "projects" TEXT NOT NULL,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "EodReport_day_key" ON "EodReport"("day")`,
  `CREATE TABLE IF NOT EXISTS "Release" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "projectId" TEXT NOT NULL,
     "version" TEXT NOT NULL,
     "zipPath" TEXT NOT NULL,
     "zipBytes" INTEGER NOT NULL,
     "headCommit" TEXT,
     "dirtyIncluded" BOOLEAN NOT NULL DEFAULT 0,
     "summary" TEXT,
     "notes" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL,
     CONSTRAINT "Release_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
  `CREATE INDEX IF NOT EXISTS "Release_projectId_createdAt_idx" ON "Release"("projectId", "createdAt")`,
];

/**
 * Indexes added to an EXISTING table by a newer app version. A schema.prisma
 * `@@index` only reaches a database that gets migrated, and the packaged app
 * never migrates (see {@link ensureSchema}) — so every already-seeded install
 * needs the index created here. Applied AFTER {@link ADDITIVE_COLUMNS} because an
 * index can cover a column that same pass just added (Run.claudeSessionId).
 * Keep in lockstep with any new `@@index` in schema.prisma.
 */
const ADDITIVE_INDEXES: ReadonlyArray<string> = [
  `CREATE INDEX IF NOT EXISTS "Run_projectId_startedAt_idx" ON "Run"("projectId", "startedAt")`,
  `CREATE INDEX IF NOT EXISTS "Run_claudeSessionId_idx" ON "Run"("claudeSessionId")`,
];

type RawClient = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

/**
 * Boot-time, additive schema self-heal for EXISTING installs. The packaged app
 * ships a template SQLite DB and copies it ONCE on first launch — it never runs
 * Prisma migrations at runtime — so a column introduced by a newer app version is
 * missing from a DB that an older version seeded, and any query touching it would
 * fail with "no such column". For each additive column we check `PRAGMA
 * table_info` and apply the `ADD COLUMN` only when it's absent. Idempotent and
 * safe to run on every boot.
 *
 * It then drops any {@link REMOVED_COLUMNS} and {@link REMOVED_TABLES} still
 * present — the one case where this routine discards data, and only for columns
 * and tables whose owning feature is gone.
 */
export async function ensureSchema(client: RawClient = prisma): Promise<void> {
  // WAL journal mode: with several live shells each flushing RunLog rows every
  // 300ms while Argus/EOD read, the default rollback journal creates+deletes a
  // journal file and takes an exclusive lock per insert. WAL makes readers and
  // the writer coexist and is dramatically cheaper per commit. The setting is
  // persistent (stored in the DB file), so one statement at boot covers every
  // pooled connection. Best-effort like the rest of this self-heal.
  try {
    await client.$queryRawUnsafe(`PRAGMA journal_mode=WAL`);
  } catch (err) {
    process.stderr.write(`[narukami] ensureSchema(WAL) failed: ${String(err)}\n`);
  }
  // New whole tables first (idempotent CREATE ... IF NOT EXISTS).
  for (const ddl of ADDITIVE_TABLES) {
    try {
      await client.$executeRawUnsafe(ddl);
    } catch (err) {
      process.stderr.write(`[narukami] ensureSchema(table) failed: ${String(err)}\n`);
    }
  }
  // Then additive columns on existing tables.
  for (const { table, column, ddl } of ADDITIVE_COLUMNS) {
    try {
      const cols = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`,
      );
      if (cols.some((c) => c.name === column)) continue; // already present
      await client.$executeRawUnsafe(ddl);
    } catch (err) {
      // Best-effort: a self-heal failure must never block boot. Surface it so a
      // genuinely broken DB is visible rather than silently degraded.
      process.stderr.write(`[narukami] ensureSchema(${table}.${column}) failed: ${String(err)}\n`);
    }
  }
  // Then indexes, which may cover a column the pass above just added.
  for (const ddl of ADDITIVE_INDEXES) {
    try {
      await client.$executeRawUnsafe(ddl);
    } catch (err) {
      process.stderr.write(`[narukami] ensureSchema(index) failed: ${String(err)}\n`);
    }
  }
  // Finally, drop columns whose feature has been removed. Runs AFTER the additive
  // pass so the two can never fight over the same column name.
  for (const { table, column } of REMOVED_COLUMNS) {
    try {
      const cols = await client.$queryRawUnsafe<Array<{ name: string }>>(
        `PRAGMA table_info("${table}")`,
      );
      if (!cols.some((c) => c.name === column)) continue; // already gone
      await client.$executeRawUnsafe(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
    } catch (err) {
      process.stderr.write(
        `[narukami] ensureSchema(drop ${table}.${column}) failed: ${String(err)}\n`,
      );
    }
  }
  // And tables whose whole model has been removed. Last, so the additive pass
  // above can never re-create something this pass is about to drop.
  for (const table of REMOVED_TABLES) {
    try {
      await client.$executeRawUnsafe(`DROP TABLE IF EXISTS "${table}"`);
    } catch (err) {
      process.stderr.write(`[narukami] ensureSchema(drop table ${table}) failed: ${String(err)}\n`);
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
