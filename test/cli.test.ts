/**
 * CLI tests: spawn the built binary against a temporary database file.
 *
 * The binary is located relative to this test file so the suite works from
 * whichever output directory it was compiled into (dist/ or dist-b/).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function parse<T = Record<string, unknown>>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`not JSON: ${(err as Error).message}\n--- text ---\n${text}`);
  }
}

/** Drop node:sqlite's ExperimentalWarning (and similar) before judging stderr. */
function meaningfulStderr(text: string): string {
  return text
    .split('\n')
    .filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings|node --trace/.test(l))
    .join('\n');
}

describe('agent-graph CLI', () => {
  let dir: string;
  let db: string;
  // The suite's writer is a runtime (it records 'observed' facts), so it is --trusted.
  const base = () => ['--db', db, '--origin', 'test-cli', '--trusted'];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-graph-cli-'));
    db = join(dir, 'memory.sqlite');
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints usage with --help (exit 0) and with no arguments (exit 1)', async () => {
    const help = await runCli(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage:/);
    assert.match(help.stdout, /recall-many/);
    assert.match(help.stdout, /subgraph/);

    const none = await runCli([]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /Usage:/);
  });

  it('put two nodes, link them, recall, trace, stats', async () => {
    const a = await runCli([...base(), 'put', JSON.stringify({ id: 'ticket:1', kind: 'ticket', label: 'First ticket', provenance: 'observed' })]);
    assert.equal(a.code, 0, a.stderr);
    const nodeA = parse(a.stdout);
    assert.equal(nodeA.id, 'ticket:1');
    assert.equal(nodeA.version, 1);
    assert.equal(nodeA.origin, 'test-cli');
    assert.equal(nodeA.provenance, 'observed');

    const b = await runCli([...base(), 'put', JSON.stringify({ id: 'run:1', kind: 'run', label: 'Run one' })]);
    assert.equal(b.code, 0, b.stderr);

    const l = await runCli([...base(), 'link', JSON.stringify({ src: 'run:1', dst: 'ticket:1', rel: 'worked_on', provenance: 'observed' })]);
    assert.equal(l.code, 0, l.stderr);
    const edge = parse(l.stdout);
    assert.equal(edge.rel, 'worked_on');
    assert.equal(edge.src, 'run:1');
    assert.equal(edge.dst, 'ticket:1');
    assert.equal(typeof edge.id, 'string');

    const r = await runCli([...base(), 'recall', JSON.stringify({ seeds: ['ticket:1'], maxCost: 1 })]);
    assert.equal(r.code, 0, r.stderr);
    const recall = parse<{ hits: Array<{ node: { id: string }; cost: number; path: Array<{ rel: string }> }>; seeds: string[] }>(r.stdout);
    assert.deepEqual(recall.seeds, ['ticket:1']);
    assert.equal(recall.hits.length, 1);
    assert.equal(recall.hits[0].node.id, 'run:1');
    assert.equal(recall.hits[0].cost, 1);
    assert.deepEqual(recall.hits[0].path.map((e) => e.rel), ['worked_on']);

    // trace accepts a bare id in place of {"id": …}
    const t = await runCli([...base(), 'trace', 'ticket:1']);
    assert.equal(t.code, 0, t.stderr);
    const trace = parse<{ node: { id: string }; versions: unknown[]; edgesIn: Array<{ id: string }>; edgesOut: unknown[] }>(t.stdout);
    assert.equal(trace.node.id, 'ticket:1');
    assert.equal(trace.versions.length, 1);
    assert.equal(trace.edgesIn.length, 1);
    assert.equal(trace.edgesIn[0].id, edge.id);
    assert.equal(trace.edgesOut.length, 0);

    const tj = await runCli([...base(), 'trace', JSON.stringify({ id: 'ticket:1' })]);
    assert.equal(tj.code, 0, tj.stderr);
    assert.deepEqual(parse(tj.stdout), trace);

    // stats takes no argument and must not wait on stdin
    const s = await runCli([...base(), 'stats']);
    assert.equal(s.code, 0, s.stderr);
    const stats = parse<{ nodes: number; edges: number; liveEdges: number; kinds: Record<string, number>; rels: Record<string, number>; bytes: number }>(s.stdout);
    assert.equal(stats.nodes, 2);
    assert.equal(stats.edges, 1);
    assert.equal(stats.liveEdges, 1);
    assert.deepEqual(stats.kinds, { run: 1, ticket: 1 });
    assert.deepEqual(stats.rels, { worked_on: 1 });
    assert.ok(stats.bytes > 0);

    // get returns the node, or null for an unknown id
    const g = await runCli([...base(), 'get', 'ticket:1']);
    assert.equal(parse(g.stdout).label, 'First ticket');
    const gn = await runCli([...base(), 'get', 'ticket:missing']);
    assert.equal(gn.code, 0, gn.stderr);
    assert.equal(gn.stdout.trim(), 'null');
  });

  it('reads the JSON argument from stdin when omitted', async () => {
    const r = await runCli([...base(), 'recall'], JSON.stringify({ seeds: ['ticket:1'], maxCost: 1 }));
    assert.equal(r.code, 0, r.stderr);
    const recall = parse<{ hits: Array<{ node: { id: string } }> }>(r.stdout);
    assert.equal(recall.hits[0].node.id, 'run:1');

    const m = await runCli([...base(), 'recall-many'], JSON.stringify({ queries: [{ seeds: ['ticket:1'] }, { seeds: ['run:1'] }] }));
    assert.equal(m.code, 0, m.stderr);
    const many = parse<{ results: unknown[]; nodes: Record<string, unknown> }>(m.stdout);
    assert.equal(many.results.length, 2);
    assert.deepEqual(Object.keys(many.nodes).sort(), ['run:1', 'ticket:1']);
  });

  it('bad JSON → exit 1 and an error object on stderr, nothing on stdout', async () => {
    const r = await runCli([...base(), 'put', '{not json']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    const err = parse<{ error: { name: string; message: string } }>(meaningfulStderr(r.stderr));
    assert.equal(err.error.name, 'UsageError');
    assert.match(err.error.message, /invalid JSON/);
  });

  it('a graph error (GuardError) surfaces by name with exit 1', async () => {
    const r = await runCli([...base(), 'put', JSON.stringify({ id: 'note:leak', kind: 'note', label: 'creds', attrs: { key: 'ghp_' + 'a'.repeat(36) } })]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    const err = parse<{ error: { name: string; message: string; report?: { rejected: boolean } } }>(meaningfulStderr(r.stderr));
    assert.equal(err.error.name, 'GuardError');
    assert.match(err.error.message, /credential/);
    assert.equal(err.error.report?.rejected, true);
  });

  it('unknown command and missing --db are usage errors', async () => {
    const u = await runCli([...base(), 'frobnicate']);
    assert.equal(u.code, 1);
    assert.equal(parse<{ error: { name: string } }>(meaningfulStderr(u.stderr)).error.name, 'UsageError');

    const d = await runCli(['stats']);
    assert.equal(d.code, 1);
    assert.match(meaningfulStderr(d.stderr), /--db/);
  });

  it('--read-only refuses write commands and still serves reads', async () => {
    const w = await runCli(['--db', db, '--read-only', 'put', JSON.stringify({ id: 'x:1', kind: 'x', label: 'x' })]);
    assert.equal(w.code, 1);
    assert.match(meaningfulStderr(w.stderr), /read-only/);
    const s = await runCli(['--db', db, '--read-only', 'stats']);
    assert.equal(s.code, 0, s.stderr);
    assert.equal(parse<{ nodes: number }>(s.stdout).nodes, 2);
  });

  it("without --trusted, provenance 'observed' is a PermissionError; 'claimed' goes through", async () => {
    const w = await runCli(['--db', db, '--origin', 'agent', 'put', JSON.stringify({ id: 'note:1', kind: 'note', label: 'n', provenance: 'observed' })]);
    assert.equal(w.code, 1);
    assert.equal(w.stdout, '');
    const err = parse<{ error: { name: string; message: string } }>(meaningfulStderr(w.stderr));
    assert.equal(err.error.name, 'PermissionError');
    assert.match(err.error.message, /--trusted/);
    const ok = await runCli(['--db', db, '--origin', 'agent', 'put', JSON.stringify({ id: 'note:1', kind: 'note', label: 'n' })]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(parse(ok.stdout).provenance, 'claimed');
  });

  it('arguments are validated against the tool schema: a ValidationError names the field', async () => {
    const r = await runCli([...base(), 'link', JSON.stringify({ src: 'run:1', dst: 'ticket:1', rel: 'r', recordedAt: 'yesterday' })]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    const err = parse<{ error: { name: string; message: string } }>(meaningfulStderr(r.stderr));
    assert.equal(err.error.name, 'ValidationError');
    assert.match(err.error.message, /recordedAt/);
    assert.ok(!err.error.message.includes('yesterday'), 'the value is not echoed');
    const typo = await runCli([...base(), 'recall', JSON.stringify({ seed: ['ticket:1'] })]);
    assert.equal(parse<{ error: { name: string; message: string } }>(meaningfulStderr(typo.stderr)).error.name, 'ValidationError');
    assert.match(meaningfulStderr(typo.stderr), /seed/);
  });

  it('subgraph returns the induced nodes and edges', async () => {
    const r = await runCli([...base(), 'subgraph', JSON.stringify({ seeds: ['ticket:1'], maxCost: 1 })]);
    assert.equal(r.code, 0, r.stderr);
    const sg = parse<{ seeds: string[]; nodes: Array<{ id: string }>; edges: Array<{ rel: string }> }>(r.stdout);
    assert.deepEqual(sg.seeds, ['ticket:1']);
    assert.deepEqual(sg.nodes.map((n) => n.id).sort(), ['run:1', 'ticket:1']);
    assert.deepEqual(sg.edges.map((e) => e.rel), ['worked_on']);
  });
});
