#!/usr/bin/env node
/**
 * agent-graph-server — the graph as a sidecar: plain `node:http`, JSON in,
 * JSON out, many graphs per process.
 *
 *   agent-graph-server --driver sqlite   --sqlite-dir <dir> [--port 8787] [--host 127.0.0.1] [--auth-token <t>]
 *   agent-graph-server --driver postgres --pg <connectionString> [...]
 *
 * Contract (fixed — a platform is built against it):
 *
 *   GET  /health            → { ok: true, driver, version }
 *   POST /graph/<op>        → the tool result as JSON
 *
 * `<op>` is a tools.ts tool name without its `graph_` prefix (put, link,
 * supersede, match, get, recall, recall_many, subgraph, trace, trace_edge,
 * stats, reembed), plus `drop` (delete the graph's file/schema; needs
 * `confirm: true`). The body is an ENVELOPE around the tool's arguments:
 *
 *   { graphId, origin?, trusted?, privileged?, readOnly?, embedding?, ...toolArgs }
 *
 * `graphId` is required and selects the storage — one SQLite file or one
 * Postgres schema per id. The server does not know whose graph it is: the
 * caller derived the id (from a tenant, an agent, a project) and is trusted to
 * have done so, exactly as the gbrain sidecar is. `origin` names the writer;
 * a write without one is refused, a read without one is fine. `embedding` is
 * PER REQUEST, never per process — one server serves tenants with different
 * models — and a graph is cached per (graphId, embedding fingerprint) so the
 * connection and the rule stay together.
 *
 * Errors: { error: { name, message } } with 400 for ValidationError /
 * GuardError, 403 PermissionError, 404 unknown op, 401 bad token, 500 else.
 *
 * The tool surface is tools.ts's: the same `run` and the same validator the
 * CLI and the MCP server use. There is no second list of operations here.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAiCompatibleEmbedder, textRuleFrom, type TextRuleSpec } from './embedding.js';
import { dropGraph, openGraph } from './graph.js';
import { errorToJson, packageVersion, UsageError } from './surface.js';
import { findTool } from './tools.js';
import { canonical } from './traverse.js';
import { ValidationError, type EmbeddingConfig, type Graph, type JsonSchema, type OpenTarget } from './types.js';
import { validateArgs } from './validate.js';

export const GRAPH_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_BODY = 16 * 1024 * 1024;
/** Separator inside a cache key; cannot occur in a graph id. */
const KEY_SEP = '|';

export interface ServerOptions {
  driver: 'sqlite' | 'postgres';
  /** sqlite: directory holding one `<graphId>.sqlite` per graph. */
  sqliteDir?: string;
  /** postgres: connection string; one schema per graph. */
  pg?: string;
  authToken?: string;
  log?: (line: string) => void;
}

/** The per-request embedding configuration, as the body carries it. */
interface EmbeddingSpec {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dims: number;
  text?: TextRuleSpec;
  kinds?: string[];
  maxChars?: number;
}

/** The envelope, validated with the same interpreter as the tool schemas. The
 *  tool arguments are whatever else is in the body (`additionalProperties`
 *  stays open here; the tool's own schema closes it). */
const ENVELOPE: JsonSchema = {
  type: 'object',
  properties: {
    graphId: { type: 'string' },
    origin: { type: 'string' },
    trusted: { type: 'boolean' },
    privileged: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    confirm: { type: 'boolean' },
    embedding: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string' },
        apiKey: { type: 'string' },
        model: { type: 'string' },
        dims: { type: 'integer', minimum: 1 },
        text: {
          anyOf: [
            { type: 'string', enum: ['label', 'label+attrs'] },
            { type: 'object', properties: { attrs: { type: 'array', items: { type: 'string' } } }, required: ['attrs'], additionalProperties: false },
          ],
        },
        kinds: { type: 'array', items: { type: 'string' } },
        maxChars: { type: 'integer', minimum: 1 },
      },
      required: ['baseUrl', 'model', 'dims'],
      additionalProperties: false,
    },
  },
  required: ['graphId'],
  additionalProperties: true,
};
const ENVELOPE_KEYS = Object.keys(ENVELOPE.properties as object);

/** A Postgres schema name is at most 63 bytes; a graph id may be 128. Ids
 *  that fit are used verbatim (so a DBA recognises them); longer ones keep a
 *  readable prefix and a hash of the whole, so two long ids cannot collide. */
export function schemaFor(graphId: string): string {
  if (Buffer.byteLength(graphId) <= 63) return graphId;
  return `${graphId.slice(0, 40)}_${createHash('sha256').update(graphId).digest('hex').slice(0, 16)}`;
}

function embeddingFrom(spec: EmbeddingSpec | undefined): EmbeddingConfig | undefined {
  if (!spec) return undefined;
  const provider = openAiCompatibleEmbedder({ baseUrl: spec.baseUrl, apiKey: spec.apiKey, model: spec.model, dims: spec.dims });
  const cfg: EmbeddingConfig = { embed: provider.embed, dims: spec.dims, text: textRuleFrom(spec.text) };
  if (spec.kinds) cfg.kinds = spec.kinds;
  if (spec.maxChars !== undefined) cfg.maxChars = spec.maxChars;
  return cfg;
}

class HttpError extends Error {
  constructor(public readonly status: number, name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/**
 * The server, separate from `listen()` so a test can drive it in-process and
 * `main()` can wire signals. Graphs open lazily on first use and stay open
 * until `close()`: the process is the sidecar's lifetime.
 */
export class GraphServer {
  readonly http: Server;
  private readonly graphs = new Map<string, Promise<Graph>>();
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ServerOptions) {
    if (opts.driver === 'sqlite' && !opts.sqliteDir) throw new UsageError('--sqlite-dir <dir> is required with --driver sqlite');
    if (opts.driver === 'postgres' && !opts.pg) throw new UsageError('--pg <connectionString> is required with --driver postgres');
    this.log = opts.log ?? (() => {});
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.log(`unhandled: ${(err as Error).stack ?? String(err)}`);
        if (!res.headersSent) send(res, 500, { error: errorToJson(err) });
        else res.end();
      });
    });
  }

  target(graphId: string): OpenTarget {
    return this.opts.driver === 'sqlite'
      ? join(this.opts.sqliteDir!, `${graphId}.sqlite`)
      : { driver: 'postgres', connectionString: this.opts.pg!, schema: schemaFor(graphId) };
  }

  /** The trust root for a (graph, embedding) pair; every request derives a
   *  narrower handle from it. Keyed by a hash so the api key in the spec
   *  never sits in a map key that could be logged. */
  private graph(graphId: string, spec: EmbeddingSpec | undefined): Promise<Graph> {
    const key = `${graphId}${KEY_SEP}${createHash('sha256').update(canonical(spec ?? null)).digest('hex')}`;
    let g = this.graphs.get(key);
    if (!g) {
      g = openGraph(this.target(graphId), { privileged: true, embedding: embeddingFrom(spec), log: (line) => this.log(`${graphId}: ${line}`) });
      this.graphs.set(key, g);
      g.catch(() => this.graphs.delete(key));
    }
    return g;
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.opts.authToken) return true;
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/.exec(header);
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(this.opts.authToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true, driver: this.opts.driver, version: packageVersion() });
      return;
    }
    if (!this.authorized(req)) {
      send(res, 401, { error: { name: 'AuthError', message: 'missing or invalid bearer token' } });
      return;
    }
    const m = /^\/graph\/([a-z_]+)$/.exec(url.pathname);
    if (!m || req.method !== 'POST') {
      send(res, 404, { error: { name: 'NotFound', message: `no route ${req.method} ${url.pathname} (POST /graph/<op>, GET /health)` } });
      return;
    }
    const op = m[1];
    try {
      const body = await readJson(req);
      send(res, 200, await this.dispatch(op, body));
    } catch (err) {
      send(res, statusOf(err), { error: errorToJson(err) });
    }
  }

  private async dispatch(op: string, body: Record<string, unknown>): Promise<unknown> {
    validateArgs('request', ENVELOPE, body);
    const graphId = body.graphId as string;
    if (!GRAPH_ID.test(graphId)) throw new ValidationError('request: graphId must match ^[A-Za-z0-9_.:-]{1,128}$');
    const spec = body.embedding as EmbeddingSpec | undefined;
    const origin = body.origin as string | undefined;
    const toolArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (!ENVELOPE_KEYS.includes(k)) toolArgs[k] = v;

    if (op === 'drop') {
      if (body.confirm !== true) throw new ValidationError('drop: confirm must be true — this deletes the graph');
      return this.drop(graphId);
    }
    const tool = findTool(`graph_${op}`);
    if (!tool) throw new HttpError(404, 'NotFound', `unknown op '${op}'`);
    // A write is stamped with its origin; without one there is nothing to
    // stamp. A read has no writer, so it may go nameless.
    if (!tool.readOnly && !origin) throw new ValidationError(`request: origin is required for ${op}`);
    const root = await this.graph(graphId, spec);
    const handle = root.as(origin ?? 'anonymous', {
      trusted: body.trusted === true,
      privileged: body.privileged === true,
      readOnly: body.readOnly === true,
    });
    const result = await tool.run(handle, toolArgs);
    return result ?? null;
  }

  private async drop(graphId: string): Promise<{ dropped: true; graphId: string }> {
    const prefix = `${graphId}${KEY_SEP}`;
    for (const [key, g] of this.graphs) {
      if (!key.startsWith(prefix)) continue;
      this.graphs.delete(key);
      await g.then((graph) => graph.close()).catch(() => {});
    }
    await dropGraph(this.target(graphId));
    return { dropped: true, graphId };
  }

  listen(port: number, host: string): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, host, () => {
        const addr = this.http.address();
        resolve(typeof addr === 'object' && addr ? { host: addr.address, port: addr.port } : { host, port });
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    const open = [...this.graphs.values()];
    this.graphs.clear();
    await Promise.all(open.map((g) => g.then((graph) => graph.close()).catch(() => {})));
  }
}

function statusOf(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  const name = err instanceof Error ? err.name : '';
  if (name === 'ValidationError' || name === 'GuardError' || name === 'UsageError') return 400;
  if (name === 'PermissionError') return 403;
  return 500;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ValidationError(`request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text.length === 0) return resolve({});
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return reject(new ValidationError(`request body is not JSON: ${(err as Error).message}`));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new ValidationError('request body must be a JSON object'));
      resolve(parsed as Record<string, unknown>);
    });
  });
}

// ---------------------------------------------------------------------------
// Binary

export interface ServerArgs extends ServerOptions {
  port: number;
  host: string;
  help: boolean;
}

export function parseServerArgs(argv: string[]): ServerArgs {
  const out: ServerArgs = { driver: 'sqlite', port: 8787, host: '127.0.0.1', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${key} requires a value`);
      return next;
    };
    switch (key) {
      case '--driver': {
        const d = value();
        if (d !== 'sqlite' && d !== 'postgres') throw new UsageError(`--driver must be sqlite or postgres, got ${d}`);
        out.driver = d;
        break;
      }
      case '--sqlite-dir': out.sqliteDir = value(); break;
      case '--pg': out.pg = value(); break;
      case '--port': {
        const p = Number(value());
        if (!Number.isInteger(p) || p < 0 || p > 65535) throw new UsageError('--port must be an integer 0..65535');
        out.port = p;
        break;
      }
      case '--host': out.host = value(); break;
      case '--auth-token': out.authToken = value(); break;
      case '--help': case '-h': out.help = true; break;
      default: throw new UsageError(`unknown argument ${arg}`);
    }
  }
  return out;
}

export function usage(): string {
  return [
    `agent-graph-server ${packageVersion()} — HTTP server for agent-graph (one process, many graphs)`,
    '',
    'Usage:',
    '  agent-graph-server --driver sqlite   --sqlite-dir <dir> [--port 8787] [--host 127.0.0.1] [--auth-token <t>]',
    '  agent-graph-server --driver postgres --pg <connectionString> [--port 8787] [--host 127.0.0.1] [--auth-token <t>]',
    '',
    'Routes:',
    '  GET  /health          { ok, driver, version }',
    '  POST /graph/<op>      body { graphId, origin?, trusted?, privileged?, readOnly?, embedding?, ...toolArgs }',
    '                        <op>: put link supersede match get recall recall_many subgraph trace trace_edge stats reembed drop',
    '',
    'graphId selects the SQLite file (<dir>/<graphId>.sqlite) or the Postgres schema; the caller derives it.',
    'embedding: { baseUrl, apiKey?, model, dims, text?: "label" | "label+attrs" | { attrs: [...] }, kinds?, maxChars? } per request.',
    'On start, one JSON line {"listening":{host,port,driver,version}} is written to stdout; diagnostics go to stderr.',
  ].join('\n');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseServerArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const log = (line: string) => process.stderr.write(`[agent-graph-server] ${line}\n`);
  const server = new GraphServer({ ...args, log });
  const bound = await server.listen(args.port, args.host);
  process.stdout.write(JSON.stringify({ listening: { ...bound, driver: args.driver, version: packageVersion() } }) + '\n');
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close().then(() => process.exit(0), (err: unknown) => { log(`close failed: ${(err as Error).message}`); process.exit(1); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
    process.stderr.write(JSON.stringify({ error: errorToJson(err) }) + '\n');
    if (err instanceof UsageError) process.stderr.write(usage() + '\n');
    process.exitCode = 1;
  });
}
