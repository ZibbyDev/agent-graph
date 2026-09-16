/** The recall suite over SQLite, plus what only a FILE-backed SQLite graph
 *  can show: persistence across reopen, the file size in stats, and the
 *  access table read back by a second connection. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';
import { dropGraph, openGraph } from '../src/index.js';
import { clock, sqliteHarness } from './suites/harness.js';
import { hub, recallSuite } from './suites/recall.suite.js';

const h = sqliteHarness();
recallSuite(h);
after(() => h.cleanup());

describe('file-backed sqlite', () => {
  test('access counts land in the file; a read-only reopen sees the data and the size; dropGraph removes the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-graph-'));
    const path = join(dir, 'g.sqlite');
    try {
      const c = clock();
      const g = await openGraph(path, { origin: 'run:a', trusted: true, now: c.now });
      const edges = await hub(g, c);
      await g.recall({ seeds: ['ticket:1'], maxCost: 2 });
      await g.close();

      const db = new DatabaseSync(path);
      const rows = db.prepare('SELECT edge_id, count, last_at FROM access ORDER BY edge_id').all() as Array<{ edge_id: string; count: number; last_at: number }>;
      db.close();
      const byId = Object.fromEntries(rows.map((r) => [r.edge_id, r.count]));
      assert.deepEqual(byId, { [edges.t1a.id]: 2, [edges.t1b.id]: 1, [edges.t7a.id]: 1 });

      const ro = await openGraph(path, { origin: 'reader', readOnly: true, now: c.now });
      const s = await ro.stats();
      assert.ok(s.bytes > 0, 'file-backed database reports its size');
      assert.equal(s.edges, 27);
      const r = await ro.recall({ seeds: ['ticket:7'], maxCost: 2 });
      assert.ok(r.hits.length >= 3);
      await ro.close();
      const db2 = new DatabaseSync(path);
      assert.equal(Number((db2.prepare('SELECT COUNT(*) AS n FROM access').get() as { n: number }).n), 3, 'the read-only recall added no rows');
      db2.close();

      await dropGraph(path);
      assert.throws(() => new DatabaseSync(path, { readOnly: true }), 'the file is gone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
