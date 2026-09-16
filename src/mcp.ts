#!/usr/bin/env node
/**
 * agent-graph-mcp — a Model Context Protocol server over stdio.
 *
 *   agent-graph-mcp --db <path> [--origin <o>] [--privileged] [--trusted] [--read-only]
 *
 * Hand-rolled, no SDK: the protocol surface this server needs is small
 * (initialize, ping, tools/list, tools/call, and empty resources/prompts
 * lists), and a dependency-free package should stay that way.
 *
 * Transport is newline-delimited JSON-RPC 2.0: one message per line on stdin,
 * one per line on stdout. NOTHING else is ever written to stdout — every
 * diagnostic goes to stderr — because the client parses stdout as protocol.
 * Notifications (no `id`) never receive a response. Requests are answered in
 * arrival order, one at a time, so a client that pipelines calls gets
 * deterministic ordering.
 *
 * The graph is opened once at startup and closed when stdin ends or on
 * SIGINT/SIGTERM.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openGraph } from './index.js';
import { errorToJson, graphOptionsFrom, packageVersion, parseHandleArgs, UsageError } from './surface.js';
import { toolsFor, type ToolDefinition } from './tools.js';
import type { Graph } from './types.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'] as const;
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcResponse['error'] = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function asObject(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * The server, independent of the transport so it can be tested by calling
 * `handle()` directly as well as through stdio.
 */
export class McpServer {
  private readonly tools: ToolDefinition[];

  constructor(
    private readonly graph: Graph,
    readOnly: boolean,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.tools = toolsFor(readOnly);
  }

  /** Process one decoded message. Returns the response, or undefined for a
   *  notification (which must not be answered). */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return fail(null, INVALID_REQUEST, 'request must be a JSON object');
    }
    const req = message as JsonRpcRequest;
    const hasId = req.id !== undefined && req.id !== null;
    const id: JsonRpcId = hasId ? (req.id as JsonRpcId) : null;
    if (typeof req.method !== 'string') {
      return hasId ? fail(id, INVALID_REQUEST, '"method" must be a string') : undefined;
    }
    const isNotification = !hasId;
    try {
      const result = await this.dispatch(req.method, req.params);
      return isNotification ? undefined : ok(id, result);
    } catch (err) {
      if (isNotification) {
        this.log(`notification ${req.method} failed: ${(err as Error).message}`);
        return undefined;
      }
      if (err instanceof RpcError) return fail(id, err.code, err.message, err.data);
      const e = errorToJson(err);
      return fail(id, INTERNAL_ERROR, `${e.name}: ${e.message}`);
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    const p = asObject(params);
    switch (method) {
      case 'initialize': {
        const requested = p.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-graph', version: packageVersion() },
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        };
      case 'tools/call':
        return this.callTool(p);
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  /** Tool errors are RESULTS with `isError: true`, not protocol errors: the
   *  model is meant to read them and recover (a GuardError says what to
   *  strip, a PermissionError which origin owns the edge, a ValidationError
   *  which field does not fit its schema). Only an unknown tool or a
   *  non-object `arguments` are protocol errors. */
  private async callTool(p: Record<string, unknown>): Promise<unknown> {
    const name = p.name;
    if (typeof name !== 'string') throw new RpcError(INVALID_PARAMS, '"name" must be a string');
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${name}`);
    const rawArgs = p.arguments ?? {};
    if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      throw new RpcError(INVALID_PARAMS, '"arguments" must be an object');
    }
    try {
      const result = await tool.run(this.graph, rawArgs as Record<string, unknown>);
      return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (err) {
      const e = errorToJson(err);
      const text = e.report !== undefined ? `${e.name}: ${e.message}\n${JSON.stringify(e.report)}` : `${e.name}: ${e.message}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
}

/**
 * Drive a server over stdio. Lines are decoded as they arrive; each one is
 * handled to completion before the next, and every response is one line.
 */
export function serveStdio(server: McpServer, onEnd: () => void): void {
  const write = (msg: JsonRpcResponse | JsonRpcResponse[]) => {
    process.stdout.write(JSON.stringify(msg) + '\n');
  };

  let buffer = '';
  let queue: Promise<void> = Promise.resolve();

  const processLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch (err) {
      write(fail(null, PARSE_ERROR, `parse error: ${(err as Error).message}`));
      return;
    }
    // A JSON-RPC batch (an array) is answered with an array of the responses
    // to its requests; a batch of only notifications gets nothing back.
    if (Array.isArray(decoded)) {
      if (decoded.length === 0) {
        write(fail(null, INVALID_REQUEST, 'empty batch'));
        return;
      }
      const responses: JsonRpcResponse[] = [];
      for (const item of decoded) {
        const r = await server.handle(item);
        if (r) responses.push(r);
      }
      if (responses.length > 0) write(responses);
      return;
    }
    const response = await server.handle(decoded);
    if (response) write(response);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      queue = queue.then(() => processLine(line));
    }
  });
  process.stdin.on('end', () => {
    const tail = buffer;
    buffer = '';
    queue = queue.then(() => (tail.trim().length > 0 ? processLine(tail) : undefined)).then(onEnd);
  });
  process.stdin.on('error', () => {
    queue = queue.then(onEnd);
  });
}

export function usage(): string {
  return [
    `agent-graph-mcp ${packageVersion()} — Model Context Protocol server (stdio) for agent-graph`,
    '',
    'Usage:',
    '  agent-graph-mcp --db <path> [--origin <o>] [--privileged] [--trusted] [--read-only]',
    '',
    'Options:',
    '  --db <path>      SQLite file (created on first write). ":memory:" for a throwaway graph.',
    '  --origin <o>     Origin stamped on every write made through this server (e.g. "claude", "codex").',
    '  --privileged     Allow superseding other origins\' edges and re-labelling their nodes (implies --trusted).',
    '  --trusted        The server acts for a runtime that saw things happen: allow provenance "observed". Off = only "claimed".',
    '  --read-only      Expose only the read tools.',
    '',
    'Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to stderr.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseHandleArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (args.rest.length > 0) throw new UsageError(`unexpected arguments: ${args.rest.join(' ')}`);
  if (!args.db) throw new UsageError('--db <path> is required');

  const log = (line: string) => process.stderr.write(`[agent-graph-mcp] ${line}\n`);
  const graph = await openGraph(args.db, { ...graphOptionsFrom(args), log });
  const server = new McpServer(graph, args.readOnly, log);

  let closed = false;
  const shutdown = (code: number) => {
    if (closed) return;
    closed = true;
    graph.close().then(
      // Let anything already queued on stdout drain before exiting: on some
      // platforms pipe writes are asynchronous and a bare exit would truncate
      // the last response.
      () => process.stdout.write('', () => process.exit(code)),
      (err: unknown) => {
        log(`close failed: ${(err as Error).message}`);
        process.stdout.write('', () => process.exit(code));
      },
    );
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  serveStdio(server, () => shutdown(0));
  log(`serving ${args.db}${args.readOnly ? ' (read-only)' : ''}${args.trusted || args.privileged ? ' (trusted)' : ''}${args.origin ? ` as ${args.origin}` : ''}`);
}

function invokedAsBinary(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsBinary()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // Startup failures (bad flags, unopenable database) go to stderr as the
    // same error object the CLI uses; the client sees a clean exit 1.
    process.stderr.write(JSON.stringify({ error: errorToJson(err) }) + '\n');
    if (err instanceof UsageError) process.stderr.write(usage() + '\n');
    process.exitCode = 1;
  });
}
