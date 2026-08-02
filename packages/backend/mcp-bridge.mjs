#!/usr/bin/env node
// NARUKAMI cross-terminal MCP bridge.
//
// A tiny stdio JSON-RPC (MCP) server launched by a Claude Code session that
// NARUKAMI started. It exposes seven tools that let THIS Claude start, read,
// drive and await the OTHER terminals in the app, by calling back into the local
// backend:
//
//   list_terminals            -> GET  /api/terminals
//   read_terminal(id, lines)  -> GET  /api/terminals/:id/read
//   send_terminal(id, text)   -> POST /api/terminals/:id/send
//   spawn_terminal(project)   -> POST /api/projects/:id/shell | /claude (+ /name)
//   close_terminal(id)        -> POST /api/runs/:id/close
//   wait_for_terminal(id)     -> GET  /api/terminals/:id/idle (polled) + /read
//   read_browser_logs(proj)   -> GET  /api/projects/:id/browser-logs
//
// The first three can only poke at work a human already started; the spawn/wait
// pair is what makes an orchestrating session able to OPEN a shell in another
// project, run something in it, and know when it finished instead of guessing.
//
// Config (from the per-run --mcp-config env, see services/mcpConfig.ts):
//   NARUKAMI_BASE_URL   e.g. http://127.0.0.1:4000
//   NARUKAMI_TOKEN      bearer token for /api
//   NARUKAMI_SELF_RUN_ID this session's own run id (never send to yourself)
//
// There is no separate on/off switch in here: services/mcpConfig.ts only writes
// the --mcp-config file when NARUKAMI_ORCHESTRATION !== '0', so with the switch
// off this process is never spawned and EVERY tool below — old and new — is off
// with it. Adding a second gate here would be redundant, and would drift.
//
// stdio transport = newline-delimited JSON-RPC 2.0. stdout carries ONLY protocol
// messages; everything diagnostic goes to stderr.

const BASE_URL = (process.env.NARUKAMI_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.NARUKAMI_TOKEN || '';
const SELF = process.env.NARUKAMI_SELF_RUN_ID || '';
const SERVER_INFO = { name: 'narukami-terminals', version: '1.1.0' };
const DEFAULT_PROTOCOL = '2024-11-05';

// wait_for_terminal bounds. The idle floor/ceiling mirror MIN_IDLE_MS/MAX_IDLE_MS
// in routes/terminals.ts — sending anything outside them is a 400, so clamp here
// rather than hand the caller an opaque HTTP error. The poll floor is what keeps
// a wait from becoming a busy-loop against the local API.
const WAIT_IDLE_DEFAULT_MS = 1_500;
const WAIT_IDLE_MIN_MS = 100;
const WAIT_IDLE_MAX_MS = 600_000;
const WAIT_TIMEOUT_DEFAULT_MS = 120_000;
const WAIT_TIMEOUT_MIN_MS = 1_000;
const WAIT_TIMEOUT_MAX_MS = 600_000;
const WAIT_POLL_DEFAULT_MS = 750;
const WAIT_POLL_MIN_MS = 250;
const WAIT_POLL_MAX_MS = 10_000;
const WAIT_TAIL_LINES_DEFAULT = 80;
const WAIT_TAIL_LINES_MAX = 2_000;
// Per-poll HTTP deadline. fetch() has NO default timeout, so without this a
// backend that accepted the socket and then stalled would hang the wait loop
// forever — and "always terminates" is this tool's whole contract.
const WAIT_POLL_HTTP_TIMEOUT_MS = 15_000;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}
function log(...a) {
  process.stderr.write('[narukami-mcp] ' + a.join(' ') + '\n');
}

async function api(pathAndQuery, init = {}) {
  if (!BASE_URL) throw new Error('NARUKAMI_BASE_URL not set');
  const res = await fetch(BASE_URL + pathAndQuery, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json;
  try {
    json = body ? JSON.parse(body) : {};
  } catch {
    json = { error: body };
  }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `HTTP ${res.status}`;
    // Carry the status and the parsed body on the Error: some routes answer a
    // refusal with data the caller needs to act on (POST /claude 409 names the
    // live tab's runId), and that is lost if only the message survives.
    const err = new Error(String(detail));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

/** Trimmed string arg, or '' for anything that isn't a non-empty string. */
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Integer arg clamped into [min,max]; `fallback` for absent/non-numeric. */
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * The project id for a tool call. `project_id` wins; `project_path` is resolved
 * against GET /api/projects so an agent can start work in a project that has no
 * live terminal yet — list_terminals only ever shows projects someone is already
 * working in, which is exactly the case spawn_terminal exists to escape.
 * Throws (→ a tool error) rather than returning a falsy id, so a typo'd path can
 * never be mistaken for "no project given".
 */
async function resolveProjectId(args) {
  const direct = str(args?.project_id);
  if (direct) return direct;
  const wanted = str(args?.project_path);
  if (!wanted) throw new Error('project_id (or project_path) is required.');
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '').toLowerCase();
  const projects = await api('/api/projects');
  const hit = (Array.isArray(projects) ? projects : []).find((p) => norm(p.path) === norm(wanted));
  if (!hit) {
    throw new Error(
      `No registered project has the path ${wanted}. Register it in NARUKAMI first, or pass project_id.`,
    );
  }
  return hit.id;
}

const TOOLS = [
  {
    name: 'list_terminals',
    description:
      'List every currently-live terminal in NARUKAMI (shell / claude / command tabs across all projects). Use this first to find the id of the terminal you want to read or drive. The terminal whose id equals your own is marked as yourself — never send to it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_terminal',
    description:
      "Read the recent output (ANSI-stripped) of another terminal by id. Returns the last `lines` lines. Use this to observe what another terminal/agent is doing before or after sending it a command.",
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'The target terminal id (from list_terminals).' },
        lines: {
          type: 'number',
          description: 'How many trailing lines to return (default 120, max 2000).',
        },
      },
      required: ['terminal_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_terminal',
    description:
      "Send text to another terminal's input (stdin), as if typed. By default it presses Enter after the text (submit=true). Use this to run a command in a shell tab, or to send a message/prompt to another Claude session. You cannot send to yourself.",
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'The target terminal id (from list_terminals).' },
        text: { type: 'string', description: 'The text/keystrokes to send.' },
        submit: {
          type: 'boolean',
          description: 'Press Enter after the text (default true). Set false to type without submitting.',
        },
      },
      required: ['terminal_id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'spawn_terminal',
    description:
      "Open a NEW terminal tab in one of NARUKAMI's registered projects and return its id, so you can start work in another project instead of waiting for a human to open a shell there. kind='shell' opens PowerShell (or cmd) in the project dir; kind='claude' opens a Claude Code session in it — use that only when you actually want a second agent, since it costs tokens and can talk back to you. Identify the project by project_id (from list_terminals) or by project_path (its absolute path on disk). A brand-new shell needs a moment to print its prompt: call wait_for_terminal before send_terminal, and wait again after the command. ELEVATED/admin shells are deliberately NOT available here — they fire a UAC prompt that needs a human at the keyboard, and an unattended agent must not cross that privilege boundary; ask the user to open one from the NARUKAMI UI if you truly need it.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Target project id (from list_terminals).' },
        project_path: {
          type: 'string',
          description: "The project's absolute path on disk. Use instead of project_id when the project has no live terminal to read an id from.",
        },
        kind: {
          type: 'string',
          enum: ['shell', 'claude'],
          description: "'shell' (default) for a command shell, 'claude' for a new Claude Code session.",
        },
        shell: {
          type: 'string',
          enum: ['powershell', 'cmd'],
          description: "Which shell to open for kind='shell' (default powershell; Windows only for cmd). Ignored for kind='claude'.",
        },
        continue: {
          type: 'boolean',
          description: "kind='claude' only: resume that project's most recent NARUKAMI Claude session instead of starting blank. Fails with the live tab's id if that session is already open.",
        },
        label: {
          type: 'string',
          description: "Optional tab name shown in the dock, e.g. 'suite: web'. Say what the tab is FOR — a human is watching this dock.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'close_terminal',
    description:
      'Close a terminal tab by id: stops its process and removes it from the dock (its logs are kept as history). Use this to clean up a shell YOU spawned once you are done reading its output — do not close tabs a human opened, and do not close a tab another agent is still working in. You cannot close yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'The terminal id to close (from list_terminals or spawn_terminal).' },
      },
      required: ['terminal_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_terminal',
    description:
      "Block until a terminal goes quiet (or exits, or the timeout elapses), then return its final state plus its trailing output. Use this after send_terminal instead of polling read_terminal in a loop — that burns a turn per poll and usually reads a half-finished run. It ALWAYS returns, and `reason` says why: 'idle' (still live, produced nothing for idle_ms), 'exited' (the process is gone; exit_code is set) or 'timeout' (still working when the clock ran out — the tail shows how far it got, and you can simply wait again). By default it will not report 'idle' until it has seen the terminal produce NEW output since the wait began, so a stale prompt from before your send is never mistaken for your command finishing; set require_new_output=false for a command you expect to print absolutely nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        terminal_id: { type: 'string', description: 'The terminal to wait on.' },
        idle_ms: {
          type: 'number',
          description: `How long the terminal must stay silent to count as idle (default ${WAIT_IDLE_DEFAULT_MS}, min ${WAIT_IDLE_MIN_MS}, max ${WAIT_IDLE_MAX_MS}). Raise it for a build that pauses between phases.`,
        },
        timeout_ms: {
          type: 'number',
          description: `Give up after this long and return reason='timeout' (default ${WAIT_TIMEOUT_DEFAULT_MS}, max ${WAIT_TIMEOUT_MAX_MS}).`,
        },
        poll_ms: {
          type: 'number',
          description: `Interval between idle checks (default ${WAIT_POLL_DEFAULT_MS}, min ${WAIT_POLL_MIN_MS}, max ${WAIT_POLL_MAX_MS}).`,
        },
        tail_lines: {
          type: 'number',
          description: `How many trailing output lines to return when the wait ends (default ${WAIT_TAIL_LINES_DEFAULT}, max ${WAIT_TAIL_LINES_MAX}).`,
        },
        require_new_output: {
          type: 'boolean',
          description: 'Require output produced after the wait started before reporting idle (default true).',
        },
      },
      required: ['terminal_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_browser_logs',
    description:
      "Read the console messages, uncaught exceptions and failed network requests that NARUKAMI's preview browser captured for a project. Use this right after you change a component and the preview reloads: it is how you SEE the exception your edit caused instead of asking the human to paste it. Returns events newer than `since` plus a `next_seq` — pass that back as `since` on the next call so a poll loop never re-reads the same events (start at 0 / omit it for the first call). Filter with level='error' when you only care about breakage. Read-only: nothing here can click, navigate or reload the preview.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project whose preview logs to read (from list_terminals).' },
        project_path: {
          type: 'string',
          description: "The project's absolute path on disk. Use instead of project_id.",
        },
        since: {
          type: 'number',
          description: 'Cursor, NOT a timestamp: return only events with seq greater than this. Use the previous call\'s next_seq. Default 0 (from the beginning of the ring).',
        },
        level: {
          type: 'string',
          enum: ['error', 'warn', 'info', 'log', 'network'],
          description: 'Return only events at this level. Omit for everything.',
        },
        limit: {
          type: 'number',
          description: 'Max events to return, 1-300 (default 200). An over-limit read returns the NEWEST ones.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
];

function textResult(id, text, isError = false) {
  result(id, { content: [{ type: 'text', text }], isError });
}

async function callTool(id, name, args) {
  try {
    if (name === 'list_terminals') {
      const data = await api('/api/terminals');
      const terminals = (data.terminals || []).map((t) => ({
        ...t,
        self: t.id === SELF || undefined,
      }));
      textResult(id, JSON.stringify({ terminals, yourId: SELF }, null, 2));
      return;
    }

    if (name === 'read_terminal') {
      const tid = String(args?.terminal_id || '');
      if (!tid) return textResult(id, 'terminal_id is required.', true);
      const lines = Number.isFinite(args?.lines) ? args.lines : undefined;
      const q = lines ? `?lines=${encodeURIComponent(Math.floor(lines))}` : '';
      const data = await api(`/api/terminals/${encodeURIComponent(tid)}/read${q}`);
      const header = data.live ? '(live)' : '(ended — showing persisted history)';
      textResult(id, `${header}\n${data.text ?? ''}`);
      return;
    }

    if (name === 'send_terminal') {
      const tid = String(args?.terminal_id || '');
      const text = typeof args?.text === 'string' ? args.text : '';
      if (!tid) return textResult(id, 'terminal_id is required.', true);
      if (!text) return textResult(id, 'text is required.', true);
      if (tid === SELF) return textResult(id, 'Refusing to send to yourself.', true);
      const submit = args?.submit !== false;
      const data = await api(`/api/terminals/${encodeURIComponent(tid)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text, submit, from: SELF }),
      });
      textResult(id, `Sent ${data.sent ?? text.length} chars to ${tid} (submitted=${data.submitted}).`);
      return;
    }

    if (name === 'spawn_terminal') {
      // The bridge holds the same loopback token the UI does, so nothing stops
      // it POSTing admin:true — refuse explicitly rather than relying on the
      // input schema, which only a well-behaved client enforces. Elevation fires
      // a UAC dialog no unattended agent can answer.
      if (args?.admin === true || args?.elevated === true) {
        return textResult(
          id,
          'Refusing: elevated (admin) shells cannot be opened through this bridge. Elevation needs a human to answer a UAC prompt — ask the user to open an admin shell from the NARUKAMI UI.',
          true,
        );
      }

      const kind = args?.kind === undefined ? 'shell' : String(args.kind);
      if (kind !== 'shell' && kind !== 'claude') {
        return textResult(id, "kind must be 'shell' or 'claude'.", true);
      }
      const projectId = await resolveProjectId(args);

      let created;
      try {
        if (kind === 'shell') {
          created = await api(`/api/projects/${enc(projectId)}/shell`, {
            method: 'POST',
            body: JSON.stringify({ shell: args?.shell === 'cmd' ? 'cmd' : 'powershell' }),
          });
        } else {
          created = await api(`/api/projects/${enc(projectId)}/claude`, {
            method: 'POST',
            body: JSON.stringify(args?.continue === true ? { continue: true } : {}),
          });
        }
      } catch (err) {
        // A Continue that would collide with a still-open tab answers 409 and
        // names it. Hand that id back: the useful move is to talk to that tab,
        // not to retry the spawn.
        if (err?.status === 409 && err.body?.runId) {
          return textResult(
            id,
            `${err.message} The live tab's terminal_id is ${err.body.runId} — use send_terminal on it instead of spawning another.`,
            true,
          );
        }
        throw err;
      }

      // Fail closed on a response shape that isn't the documented 201: without
      // the id there is now an ORPHAN tab in the dock, and reporting
      // `terminal_id: undefined` would send the caller off to poke at it.
      if (!created?.runId) {
        throw new Error(
          `The API accepted the spawn but returned no runId: ${JSON.stringify(created)}. Check the NARUKAMI dock for a stray tab.`,
        );
      }

      const label = str(args?.label);
      let labelError;
      if (label) {
        try {
          await api(`/api/runs/${enc(created.runId)}/name`, {
            method: 'POST',
            body: JSON.stringify({ name: label }),
          });
        } catch (err) {
          // The tab exists either way — report the naming failure instead of
          // throwing it, which would read as "the spawn failed".
          labelError = err?.message || String(err);
        }
      }

      textResult(
        id,
        JSON.stringify(
          {
            terminal_id: created.runId,
            kind,
            project_id: projectId,
            pid: created.pid ?? null,
            ...(created.sessionId ? { claude_session_id: created.sessionId } : {}),
            ...(created.resumed === undefined ? {} : { resumed: created.resumed }),
            ...(created.notice ? { notice: created.notice } : {}),
            ...(label ? { label } : {}),
            ...(labelError ? { label_error: labelError } : {}),
            next:
              kind === 'shell'
                ? 'Call wait_for_terminal on this id before send_terminal — the shell has not printed its prompt yet.'
                : 'Call wait_for_terminal on this id before send_terminal — Claude Code is still starting up.',
          },
          null,
          2,
        ),
      );
      return;
    }

    if (name === 'close_terminal') {
      const tid = str(args?.terminal_id);
      if (!tid) return textResult(id, 'terminal_id is required.', true);
      if (tid === SELF) {
        return textResult(id, 'Refusing to close yourself — that would kill this session mid-turn.', true);
      }
      const data = await api(`/api/runs/${enc(tid)}/close`, { method: 'POST' });
      textResult(id, `Closed ${tid} (process stopped=${data.stopped === true}).`);
      return;
    }

    if (name === 'wait_for_terminal') {
      const tid = str(args?.terminal_id);
      if (!tid) return textResult(id, 'terminal_id is required.', true);
      const idleMs = clampInt(args?.idle_ms, WAIT_IDLE_MIN_MS, WAIT_IDLE_MAX_MS, WAIT_IDLE_DEFAULT_MS);
      const timeoutMs = clampInt(
        args?.timeout_ms,
        WAIT_TIMEOUT_MIN_MS,
        WAIT_TIMEOUT_MAX_MS,
        WAIT_TIMEOUT_DEFAULT_MS,
      );
      const pollMs = clampInt(args?.poll_ms, WAIT_POLL_MIN_MS, WAIT_POLL_MAX_MS, WAIT_POLL_DEFAULT_MS);
      const tailLines = clampInt(args?.tail_lines, 1, WAIT_TAIL_LINES_MAX, WAIT_TAIL_LINES_DEFAULT);
      const requireNewOutput = args?.require_new_output !== false;

      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let state = null;
      let baseline; // lastOutputAt as of the first poll
      let sawNewOutput = false;
      let polls = 0;
      let reason = 'timeout';

      for (;;) {
        state = await api(`/api/terminals/${enc(tid)}/idle?ms=${idleMs}`, {
          signal: AbortSignal.timeout(WAIT_POLL_HTTP_TIMEOUT_MS),
        });
        polls += 1;
        if (polls === 1) baseline = state.lastOutputAt;
        else if (state.lastOutputAt !== baseline) sawNewOutput = true;

        // Exit wins over idle: an ended run reports idle:true unconditionally,
        // and "it finished" is the more actionable answer.
        if (state.exited === true) {
          reason = 'exited';
          break;
        }
        if (state.idle === true && (sawNewOutput || !requireNewOutput)) {
          reason = 'idle';
          break;
        }
        // The deadline is checked AFTER a poll, so the reported state is always
        // one this loop actually observed — and every branch out of here either
        // breaks or sleeps a positive amount, so the loop cannot spin.
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollMs, remaining));
      }

      let tail = '';
      let tailError;
      try {
        const read = await api(`/api/terminals/${enc(tid)}/read?lines=${tailLines}`, {
          signal: AbortSignal.timeout(WAIT_POLL_HTTP_TIMEOUT_MS),
        });
        tail = read.text ?? '';
      } catch (err) {
        // The wait's own answer is the valuable part; don't discard it because
        // the follow-up read failed.
        tailError = err?.message || String(err);
      }

      const summary = JSON.stringify(
        {
          terminal_id: tid,
          reason,
          waited_ms: Date.now() - startedAt,
          polls,
          live: state?.live === true,
          idle: state?.idle === true,
          exited: state?.exited === true,
          exit_code: state?.exitCode ?? null,
          last_output_at: state?.lastOutputAt ?? null,
          idle_ms_observed: state?.idleMs ?? 0,
          saw_new_output: sawNewOutput,
          idle_threshold_ms: idleMs,
          ...(tailError ? { tail_error: tailError } : {}),
        },
        null,
        2,
      );
      textResult(id, `${summary}\n--- last ${tailLines} lines of ${tid} ---\n${tail}`);
      return;
    }

    if (name === 'read_browser_logs') {
      const projectId = await resolveProjectId(args);
      const q = [];
      // `since` is a cursor: 0 and absent mean the same thing to the route, so
      // only send it when it is a real non-negative integer.
      const since = Number(args?.since);
      if (Number.isInteger(since) && since >= 0) q.push(`since=${since}`);
      const level = str(args?.level);
      if (level) q.push(`level=${enc(level)}`);
      const limit = Number(args?.limit);
      if (Number.isFinite(limit)) q.push(`limit=${Math.floor(limit)}`);
      const data = await api(
        `/api/projects/${enc(projectId)}/browser-logs${q.length ? `?${q.join('&')}` : ''}`,
      );
      const events = data.events || [];
      textResult(
        id,
        JSON.stringify(
          {
            project_id: projectId,
            count: events.length,
            next_seq: data.nextSeq ?? 0,
            events,
            ...(events.length === 0
              ? { note: 'No preview events past that cursor. The preview may not be open, or nothing new has been logged.' }
              : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    error(id, -32601, `Unknown tool: ${name}`);
  } catch (err) {
    textResult(id, `Tool call failed: ${err?.message || String(err)}`, true);
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'notifications/initialized':
    case 'initialized':
      return; // notification, no reply
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call':
      void callTool(id, params?.name, params?.arguments || {});
      return;
    default:
      if (isRequest) error(id, -32601, `Method not found: ${method}`);
  }
}

// --- stdin framing: newline-delimited JSON ---
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('dropping non-JSON line');
      continue;
    }
    try {
      handle(msg);
    } catch (err) {
      log('handler error:', err?.message || String(err));
    }
  }
});
process.stdin.on('end', () => process.exit(0));

log(`bridge up (self=${SELF || 'unknown'}, base=${BASE_URL || 'unset'})`);
