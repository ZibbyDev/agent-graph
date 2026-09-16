/**
 * MCP server tests: spawn the built binary and speak newline-delimited
 * JSON-RPC over its stdio.
 *
 * The binary is located relative to this test file so the suite works from
 * whichever output directory it was compiled into (dist/ or dist-b/).
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

const ALL_TOOLS = [
  'graph_put',
  'graph_link',
  'graph_supersede',
  'graph_match',
  'graph_get',
  'graph_recall',
  'graph_recall_many',
  'graph_subgraph',
  'graph_trace',
  'graph_trace_edge',
  'graph_stats',
].sort();
const READ_TOOLS = ALL_TOOLS.filter((n) => !['graph_put', 'graph_link', 'graph_supersede'].includes(n));

interface Response {
  jsonrpc: string;
  id: number | string | null;
  result?: Record<string, unknown> | undefined;
  error?: { code: number; message: string };
}

/** A client over one server process: sends lines, resolves responses by id,
 *  and keeps every raw stdout line so a test can assert the channel is clean. */
class Client {
  readonly child: ChildProcessWithoutNullStreams;
  readonly rawLines: string[] = [];
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number | string, (r: Response) => void>();
  readonly exited: Promise<number | null>;

  constructor(args: string[]) {
    this.child = spawn(process.execPath, [MCP, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        this.rawLines.push(line);
        const msg = JSON.parse(line) as Response;
        const waiter = msg.id !== null ? this.waiting.get(msg.id) : this.waiting.get('__null__');
        if (waiter) waiter(msg);
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', () => {});
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
  }

  /** Send a request and await its response. */
  request(method: string, params?: unknown): Promise<Response> {
    const id = this.nextId++;
    return this.send({ jsonrpc: '2.0', id, method, params }, id);
  }

  /** Send a raw line (possibly malformed) and await the response under `key`. */
  send(message: unknown, key: number | string): Promise<Response> {
    return new Promise((resolve) => {
      this.waiting.set(key, resolve);
      const line = typeof message === 'string' ? message : JSON.stringify(message);
      this.child.stdin.write(line + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async close(): Promise<number | null> {
    this.child.stdin.end();
    return this.exited;
  }
}

function resultText(r: Response): string {
  const content = (r.result as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0].type, 'text');
  return content[0].text;
}

describe('agent-graph MCP server', () => {
  let dir: string;
  let db: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-graph-mcp-'));
    db = join(dir, 'memory.sqlite');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the protocol end to end and keeps stdout to JSON lines', async () => {
    const c = new Client(['--db', db, '--origin', 'test-mcp']);

    // initialize echoes a supported protocol version…
    const init = await c.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.error, undefined);
    assert.equal(init.result?.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result?.capabilities, { tools: {} });
    assert.equal((init.result?.serverInfo as { name: string }).name, 'agent-graph');
    assert.match((init.result?.serverInfo as { version: string }).version, /^\d+\.\d+\.\d+/);

    // …and a notification gets no reply (checked at the end by counting lines).
    c.notify('notifications/initialized');
    const linesAfterInit = c.rawLines.length;

    const ping = await c.request('ping');
    assert.deepEqual(ping.result, {});

    const list = await c.request('tools/list');
    const tools = list.result?.tools as Array<{ name: string; description: string; inputSchema: { type: string } }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
    for (const t of tools) {
      assert.ok(t.description.length > 40, `${t.name} has a real description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} schema is an object`);
    }
    // The time-axis fields are documented where a model will read them.
    const recall = tools.find((t) => t.name === 'graph_recall')!;
    const props = (recall.inputSchema as unknown as { properties: Record<string, { description: string }> }).properties;
    for (const f of ['validAt', 'asOf', 'recordedBetween']) assert.match(props[f].description, /time/i, `${f} explains its time axis`);

    // tools/call: put, put, link, recall.
    const put1 = await c.request('tools/call', { name: 'graph_put', arguments: { id: 'ticket:1', kind: 'ticket', label: 'First', provenance: 'observed' } });
    assert.equal(put1.result?.isError, undefined);
    assert.equal(JSON.parse(resultText(put1)).origin, 'test-mcp');
    const put2 = await c.request('tools/call', { name: 'graph_put', arguments: { id: 'run:1', kind: 'run', label: 'Run one' } });
    assert.equal(put2.result?.isError, undefined);
    const link = await c.request('tools/call', { name: 'graph_link', arguments: { src: 'run:1', dst: 'ticket:1', rel: 'worked_on', provenance: 'observed', cost: 1 } });
    assert.equal(link.result?.isError, undefined);
    const edge = JSON.parse(resultText(link)) as { id: string; rel: string };
    assert.equal(edge.rel, 'worked_on');

    const rec = await c.request('tools/call', { name: 'graph_recall', arguments: { seeds: ['ticket:1'], maxCost: 1 } });
    const recallResult = JSON.parse(resultText(rec)) as { hits: Array<{ node: { id: string }; path: Array<{ id: string }> }> };
    assert.equal(recallResult.hits.length, 1);
    assert.equal(recallResult.hits[0].node.id, 'run:1');
    assert.equal(recallResult.hits[0].path[0].id, edge.id);

    // A GuardError is a tool result with isError, naming the error.
    const leak = await c.request('tools/call', {
      name: 'graph_put',
      arguments: { id: 'note:leak', kind: 'note', label: 'creds', attrs: { pat: 'ghp_' + 'A'.repeat(36) } },
    });
    assert.equal(leak.error, undefined, 'tool failures are results, not protocol errors');
    assert.equal(leak.result?.isError, true);
    assert.match(resultText(leak), /^GuardError: /);
    assert.match(resultText(leak), /credential/);
    // …and nothing was written.
    const get = await c.request('tools/call', { name: 'graph_get', arguments: { id: 'note:leak' } });
    assert.equal(resultText(get), 'null');

    // Unknown tool → invalid params; unknown method → method not found.
    const badTool = await c.request('tools/call', { name: 'graph_nope', arguments: {} });
    assert.equal(badTool.error?.code, -32602);
    const unknown = await c.request('no/such/method');
    assert.equal(unknown.error?.code, -32601);

    // Empty lists for the capabilities we do not offer.
    assert.deepEqual((await c.request('resources/list')).result, { resources: [] });
    assert.deepEqual((await c.request('prompts/list')).result, { prompts: [] });

    // Malformed JSON → parse error with a null id.
    const parseErr = await c.send('{"jsonrpc":"2.0","id":99,"method":', '__null__');
    assert.equal(parseErr.id, null);
    assert.equal(parseErr.error?.code, -32700);

    // The notification produced no line: every stdout line is one JSON-RPC
    // message, and there are exactly as many as there were requests.
    const requestsSent = 14; // initialize, ping, list, put, put, link, recall, leak, get, badTool, unknown, resources, prompts, parseErr
    assert.equal(c.rawLines.length, requestsSent, 'one stdout line per request, none for the notification');
    assert.equal(linesAfterInit, 1);
    for (const line of c.rawLines) {
      const msg = JSON.parse(line) as Response;
      assert.equal(msg.jsonrpc, '2.0');
      assert.ok('id' in msg);
    }

    assert.equal(await c.close(), 0, 'exits cleanly when stdin ends');
  });

  it('falls back to the latest protocol version for an unknown one', async () => {
    const c = new Client(['--db', ':memory:']);
    const init = await c.request('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(init.result?.protocolVersion, '2025-06-18');
    const bare = await c.request('initialize', {});
    assert.equal(bare.result?.protocolVersion, '2025-06-18');
    await c.close();
  });

  it('--read-only lists only the read tools and refuses writes as unknown tools', async () => {
    const c = new Client(['--db', db, '--read-only']);
    await c.request('initialize', { protocolVersion: '2025-06-18' });
    const list = await c.request('tools/list');
    const names = (list.result?.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, READ_TOOLS);
    assert.ok(names.includes('graph_subgraph'));

    const put = await c.request('tools/call', { name: 'graph_put', arguments: { id: 'x:1', kind: 'x', label: 'x' } });
    assert.equal(put.error?.code, -32602);

    // Reads still work against the data the first test wrote.
    const stats = await c.request('tools/call', { name: 'graph_stats', arguments: {} });
    assert.equal(JSON.parse(resultText(stats)).nodes, 2);
    await c.close();
  });

  it('answers a JSON-RPC batch with a batch', async () => {
    const c = new Client(['--db', ':memory:']);
    const responses = await new Promise<Response[]>((resolve) => {
      c.child.stdout.once('data', () => {
        // The client tokeniser has already pushed the line by the time this
        // fires on the next tick.
        setImmediate(() => resolve(JSON.parse(c.rawLines[0]) as Response[]));
      });
      c.child.stdin.write(
        JSON.stringify([
          { jsonrpc: '2.0', id: 'a', method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 'b', method: 'nope' },
        ]) + '\n',
      );
    });
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0], { jsonrpc: '2.0', id: 'a', result: {} });
    assert.equal(responses[1].error?.code, -32601);
    await c.close();
  });
});
