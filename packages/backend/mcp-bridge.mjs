#!/usr/bin/env node
// NARUKAMI cross-terminal MCP bridge.
//
// A tiny stdio JSON-RPC (MCP) server launched by a Claude Code session that
// NARUKAMI started. It exposes three tools that let THIS Claude read and drive
// the OTHER live terminals in the app, by calling back into the local backend:
//
//   list_terminals            -> GET  /api/terminals
//   read_terminal(id, lines)  -> GET  /api/terminals/:id/read
//   send_terminal(id, text)   -> POST /api/terminals/:id/send
//
// Config (from the per-run --mcp-config env, see services/mcpConfig.ts):
//   NARUKAMI_BASE_URL   e.g. http://127.0.0.1:4000
//   NARUKAMI_TOKEN      bearer token for /api
//   NARUKAMI_SELF_RUN_ID this session's own run id (never send to yourself)
//
// stdio transport = newline-delimited JSON-RPC 2.0. stdout carries ONLY protocol
// messages; everything diagnostic goes to stderr.

const BASE_URL = (process.env.NARUKAMI_BASE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.NARUKAMI_TOKEN || '';
const SELF = process.env.NARUKAMI_SELF_RUN_ID || '';
const SERVER_INFO = { name: 'narukami-terminals', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2024-11-05';

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
    throw new Error(String(detail));
  }
  return json;
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
