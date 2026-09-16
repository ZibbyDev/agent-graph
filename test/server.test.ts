/**
 * HTTP server tests: spawn the built binary over a temp directory of SQLite
 * files and speak the contract. A tiny node:http stub plays the embedding
 * model, so the per-request `embedding` config is exercised end to end
 * without a real one.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseServerArgs, schemaFor } from '../src/server.js';
import { fakeVector } from './suites/embedding.suite.js';

const BIN = fileURLToPath(new URL('../src/server.js', import.meta.url));

interface Spawned {
  child: ChildProcess;
  port: number;
  stderr: string[];
}

/** Start the binary and wait for its `{"listening":…}` line. */
function startServer(args: string[]): Promise<Spawned> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: string[] = [];
    let out = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => stderr.push(d));
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      out += d;
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      const line = JSON.parse(out.slice(0, nl)) as { listening: { port: number } };
      resolve({ child, port: line.listening.port, stderr });
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${stderr.join('')}`)));
  });
}

function stop(s: Spawned): Promise<void> {
  return new Promise((resolve) => {
    s.child.once('exit', () => resolve());
    s.child.kill('SIGTERM');
  });
}

async function call(port: number, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** An OpenAI-compatible embeddings endpoint backed by the fake hash model. */
function embeddingStub(): Promise<{ server: Server; port: number; requests: Array<{ auth: string | undefined; model: string; input: string[] }> }> {
  const requests: Array<{ auth: string | undefined; model: string; input: string[] }> = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
      res.writeHead(404).end();
      return;
    }
    let text = '';
    req.setEncoding('utf8').on('data', (d: string) => (text += d)).on('end', () => {
      const body = JSON.parse(text) as { model: string; input: string[] };
      requests.push({ auth: req.headers.authorization, model: body.model, input: body.input });
      const data = body.input.map((t, index) => ({ index, embedding: fakeVector(t) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data, model: body.model }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port, requests })));
}

describe('agent-graph-server', () => {
  let dir: string;
  let s: Spawned;
  let stub: Awaited<ReturnType<typeof embeddingStub>>;
  const G = 'tenant-a:agent-1';
  const post = (op: string, body: unknown) => call(s.port, 'POST', `/graph/${op}`, body);
  const err = (r: { json: Record<string, unknown> }) => r.json.error as { name: string; message: string };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-graph-server-'));
    s = await startServer(['--driver', 'sqlite', '--sqlite-dir', dir, '--port', '0']);
    stub = await embeddingStub();
  });
  after(async () => {
    await stop(s);
    stub.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /health', async () => {
    const r = await call(s.port, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.driver, 'sqlite');
    assert.match(String(r.json.version), /^\d+\.\d+\.\d+/);
  });

  it('put, link, recall; two graphIds are two files that do not see each other', async () => {
    const p1 = await post('put', { graphId: G, origin: 'rt', trusted: true, id: 'ticket:1', kind: 'ticket', label: 'First', provenance: 'observed' });
    assert.equal(p1.status, 200, JSON.stringify(p1.json));
    assert.equal(p1.json.origin, 'rt');
    assert.equal(p1.json.provenance, 'observed');
    const p2 = await post('put', { graphId: G, origin: 'rt', id: 'run:1', kind: 'run', label: 'Run one' });
    assert.equal(p2.status, 200);
    const l = await post('link', { graphId: G, origin: 'rt', src: 'run:1', dst: 'ticket:1', rel: 'worked_on' });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    assert.equal(l.json.rel, 'worked_on');

    // A read needs no origin.
    const r = await post('recall', { graphId: G, seeds: ['ticket:1'], maxCost: 1 });
    assert.equal(r.status, 200);
    const hits = r.json.hits as Array<{ node: { id: string }; path: Array<{ id: string }> }>;
    assert.equal(hits.length, 1);
    assert.equal(hits[0].node.id, 'run:1');
    assert.equal(hits[0].path[0].id, l.json.id);
    const t = await post('trace', { graphId: G, id: 'ticket:1' });
    assert.equal((t.json.edgesIn as unknown[]).length, 1);
    const te = await post('trace_edge', { graphId: G, id: l.json.id });
    assert.equal((te.json.chain as unknown[]).length, 1);
    const many = await post('recall_many', { graphId: G, queries: [{ seeds: ['ticket:1'] }, { seeds: ['run:1'] }] });
    assert.equal((many.json.results as unknown[]).length, 2);
    const sg = await post('subgraph', { graphId: G, seeds: ['ticket:1'], maxCost: 1 });
    assert.equal((sg.json.edges as unknown[]).length, 1);
    const get = await post('get', { graphId: G, id: 'ticket:1' });
    assert.equal(get.json.label, 'First');
    const m = await post('match', { graphId: G, kind: 'run' });
    assert.equal((m.json as unknown as unknown[]).length, 1);

    // Another graph id: its own file, empty.
    const other = await post('stats', { graphId: 'tenant-b' });
    assert.equal(other.status, 200);
    assert.equal(other.json.nodes, 0);
    assert.equal((await post('get', { graphId: 'tenant-b', id: 'ticket:1' })).json, null);
    assert.equal((await post('stats', { graphId: G })).json.nodes, 2);
    assert.ok(existsSync(join(dir, `${G}.sqlite`)));
    assert.ok(existsSync(join(dir, 'tenant-b.sqlite')));
  });

  it('per-request embedding: the model URL, key and text rule travel with the request; semantic locate hits the right node', async () => {
    const embedding = { baseUrl: `http://127.0.0.1:${stub.port}`, apiKey: 'test-key', model: 'fake', dims: 16, text: 'label+attrs', kinds: ['note'] };
    const E = 'tenant-a:agent-embed';
    const base = { graphId: E, origin: 'rt', embedding };
    await post('put', { ...base, id: 'note:pricing', kind: 'note', label: 'Rounding', attrs: { text: 'the pricing service rounds half-up' } });
    await post('put', { ...base, id: 'note:checkout', kind: 'note', label: 'Coupon', attrs: { text: 'applied at checkout before tax' } });
    await post('put', { ...base, id: 'file:1', kind: 'file', label: 'pricing rounding half-up' });
    assert.equal(stub.requests.length, 2, 'files are not in kinds, so two model calls');
    assert.deepEqual(stub.requests[0], { auth: 'Bearer test-key', model: 'fake', input: ['Rounding\ntext: the pricing service rounds half-up'] });

    const r = await post('recall', { ...base, locate: 'pricing rounds half-up', maxCost: 1, limit: 1, includeSeeds: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.seeds, ['note:pricing']);
    assert.deepEqual(r.json.seedSources, [{ id: 'note:pricing', via: 'locate' }]);
    const m = await post('match', { ...base, semantic: 'coupon at checkout' });
    assert.equal((m.json as unknown as Array<{ id: string }>)[0].id, 'note:checkout');

    // The same graph without an embedding config is the same data, minus the model.
    const plain = await post('stats', { graphId: E });
    assert.equal(plain.json.nodes, 3);
    const noModel = await post('recall', { graphId: E, locate: 'x' });
    assert.equal(noModel.status, 500, 'no embedding on this handle: a plain error');
    assert.match(err(noModel).message, /no embedding/);

    // reembed rebuilds under a different rule.
    const re = await post('reembed', { ...base, embedding: { ...embedding, text: 'label', kinds: ['note', 'file'] } });
    assert.equal(re.status, 200, JSON.stringify(re.json));
    assert.deepEqual(re.json, { embedded: 3, cleared: 0, skipped: 0 });
  });

  it('400 / 403 / 404 paths, each with a named error', async () => {
    const noGraph = await post('stats', {});
    assert.equal(noGraph.status, 400);
    assert.equal(err(noGraph).name, 'ValidationError');
    assert.match(err(noGraph).message, /graphId/);
    const badId = await post('stats', { graphId: '../escape' });
    assert.equal(badId.status, 400);
    assert.match(err(badId).message, /graphId must match/);
    const badArg = await post('link', { graphId: G, origin: 'rt', src: 'run:1', dst: 'ticket:1', rel: 'r', recordedAt: 'yesterday' });
    assert.equal(badArg.status, 400);
    assert.equal(err(badArg).name, 'ValidationError');
    assert.match(err(badArg).message, /recordedAt/);
    const noOrigin = await post('put', { graphId: G, id: 'x', kind: 'k', label: 'x' });
    assert.equal(noOrigin.status, 400);
    assert.match(err(noOrigin).message, /origin is required for put/);
    const guard = await post('put', { graphId: G, origin: 'rt', id: 'leak', kind: 'k', label: 'x', attrs: { t: 'ghp_' + 'A'.repeat(36) } });
    assert.equal(guard.status, 400);
    assert.equal(err(guard).name, 'GuardError');
    assert.ok(!err(guard).message.includes('AAAA'));
    const notJson = await call(s.port, 'POST', '/graph/stats', '{not json');
    assert.equal(notJson.status, 400);
    const badEmbedding = await post('stats', { graphId: G, embedding: { baseUrl: 'http://x', model: 'm' } });
    assert.equal(badEmbedding.status, 400);
    assert.match(err(badEmbedding).message, /embedding\.dims/);

    const observed = await post('put', { graphId: G, origin: 'agent', id: 'x', kind: 'k', label: 'x', provenance: 'observed' });
    assert.equal(observed.status, 403);
    assert.equal(err(observed).name, 'PermissionError');
    const trace = await post('trace', { graphId: G, id: 'ticket:1' });
    const edgeId = (trace.json.edgesIn as Array<{ id: string }>)[0].id;
    const notMine = await post('supersede', { graphId: G, origin: 'someone-else', edgeId });
    assert.equal(notMine.status, 403);
    const readOnly = await post('put', { graphId: G, origin: 'rt', readOnly: true, id: 'x', kind: 'k', label: 'x' });
    assert.equal(readOnly.status, 403);
    assert.match(err(readOnly).message, /read-only/);

    const unknown = await post('frobnicate', { graphId: G });
    assert.equal(unknown.status, 404);
    assert.equal(err(unknown).name, 'NotFound');
    const route = await call(s.port, 'GET', '/graph/stats');
    assert.equal(route.status, 404);
    const missing = await post('link', { graphId: G, origin: 'rt', src: 'run:1', dst: 'nope', rel: 'r' });
    assert.equal(missing.status, 500, 'a plain graph error (dangling endpoint) is a 500 by contract');
    assert.match(err(missing).message, /does not exist/);
  });

  it('drop needs confirm, then removes the file; the id starts empty afterwards', async () => {
    const D = 'tenant-a:to-drop';
    await post('put', { graphId: D, origin: 'rt', id: 'n', kind: 'k', label: 'n' });
    assert.ok(existsSync(join(dir, `${D}.sqlite`)));
    const refused = await post('drop', { graphId: D });
    assert.equal(refused.status, 400);
    assert.match(err(refused).message, /confirm/);
    const dropped = await post('drop', { graphId: D, confirm: true });
    assert.deepEqual(dropped.json, { dropped: true, graphId: D });
    assert.ok(!existsSync(join(dir, `${D}.sqlite`)));
    assert.equal((await post('stats', { graphId: D })).json.nodes, 0);
  });

  it('--auth-token gates every route except /health', async () => {
    const guarded = await startServer(['--driver', 'sqlite', '--sqlite-dir', dir, '--port', '0', '--auth-token', 'secret']);
    try {
      assert.equal((await call(guarded.port, 'GET', '/health')).status, 200);
      const none = await call(guarded.port, 'POST', '/graph/stats', { graphId: G });
      assert.equal(none.status, 401);
      assert.equal(err(none).name, 'AuthError');
      const wrong = await call(guarded.port, 'POST', '/graph/stats', { graphId: G }, 'secrex');
      assert.equal(wrong.status, 401);
      const ok = await call(guarded.port, 'POST', '/graph/stats', { graphId: G }, 'secret');
      assert.equal(ok.status, 200);
      assert.equal(ok.json.nodes, 2, 'same directory, same graph');
    } finally {
      await stop(guarded);
    }
  });

  it('argument parsing and the schema-name rule', () => {
    assert.deepEqual(parseServerArgs(['--driver', 'postgres', '--pg', 'postgres://x', '--port=1', '--host', '0.0.0.0', '--auth-token', 't']), {
      driver: 'postgres', pg: 'postgres://x', port: 1, host: '0.0.0.0', authToken: 't', help: false,
    });
    assert.throws(() => parseServerArgs(['--driver', 'mysql']), /sqlite or postgres/);
    assert.throws(() => parseServerArgs(['--bogus']), /unknown argument/);
    assert.equal(schemaFor('tenant-a:agent-1'), 'tenant-a:agent-1', 'short ids are used verbatim');
    const long = 'x'.repeat(100);
    assert.equal(schemaFor(long).length, 57);
    assert.ok(Buffer.byteLength(schemaFor(long)) <= 63);
    assert.notEqual(schemaFor(long), schemaFor('x'.repeat(99)), 'two long ids sharing a prefix map to different schemas');
  });
});
