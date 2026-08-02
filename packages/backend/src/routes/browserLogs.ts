import type { FastifyInstance } from 'fastify';
import { prisma } from '../db';
import {
  BROWSER_LOG_LEVELS,
  BROWSER_LOG_LIMIT_DEFAULT,
  BROWSER_LOG_LIMIT_MAX,
  readBrowserEvents,
} from '../services/browserLogs';

/** A query param that was omitted, or supplied empty (`?since=`), counts as unset. */
function unset(v: unknown): boolean {
  return v === undefined || v === '';
}

/**
 * Non-negative integers only, and only as a SINGLE value: a repeated param
 * (`?since=1&since=2`) arrives as an array, which Number() would happily turn
 * into NaN or — worse, for a one-element array — a silent success.
 */
function asCount(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * The agent-facing half of the preview capture. The desktop shell pushes the
 * Browser tab's console + network events into an in-memory ring (see
 * services/browserLogs.ts); this is where a Claude tab reads them back, so it
 * can see the exception its own edit caused without a human relaying it.
 *
 * Read-only by design: nothing here can drive the preview, and the events are
 * whatever the page already printed.
 */
export async function browserLogRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/api/projects/:id/browser-logs',
    async (req, reply) => {
      const project = await prisma.project.findUnique({ where: { id: req.params.id } });
      if (!project) return reply.code(404).send({ error: 'Project not found.' });

      const q = req.query ?? {};

      let since = 0;
      if (!unset(q.since)) {
        const parsed = asCount(q.since);
        if (parsed === null) {
          return reply.code(400).send({ error: 'since must be a non-negative integer sequence number.' });
        }
        since = parsed;
      }

      let limit = BROWSER_LOG_LIMIT_DEFAULT;
      if (!unset(q.limit)) {
        const parsed = asCount(q.limit);
        if (parsed === null || parsed < 1 || parsed > BROWSER_LOG_LIMIT_MAX) {
          return reply
            .code(400)
            .send({ error: `limit must be an integer in [1,${BROWSER_LOG_LIMIT_MAX}].` });
        }
        limit = parsed;
      }

      let level: string | undefined;
      if (!unset(q.level)) {
        if (typeof q.level !== 'string' || !(BROWSER_LOG_LEVELS as readonly string[]).includes(q.level)) {
          return reply
            .code(400)
            .send({ error: `level must be one of: ${BROWSER_LOG_LEVELS.join(', ')}.` });
        }
        level = q.level;
      }

      return readBrowserEvents(project.id, { since, level, limit });
    },
  );
}
