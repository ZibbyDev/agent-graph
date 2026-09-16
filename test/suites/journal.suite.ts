/**
 * Journal → replay, dump → load, journal → SQL. The property under test is
 * always the same: a graph rebuilt from the exported form is INDISTINGUISHABLE
 * from the original — same stats, same node versions, same edge ids, same
 * supersession chain — and rebuilding twice changes nothing.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GuardError, journalToSql, PermissionError, type Graph, type GraphDump, type JournalOp } from '../../src/index.js';
import { clock, type Harness } from './harness.js';

export function journalSuite(h: Harness): void {
  /** A small story with every op kind, two origins, a merge and a correction.
   *  Returns the journal it produced and the graph, still open. */
  async function story() {
    const c = clock();
    const journal: JournalOp[] = [];
    const root = await h.open({ origin: 'runtime', privileged: true, now: c.now, journal: (op) => journal.push(op) });
    const a = root.as('run:a', { trusted: true });
    const b = root.as('run:b');
    await a.put({ id: 'ticket:1', kind: 'ticket', label: 'First', attrs: { p: 1 }, provenance: 'observed' });
    c.tick();
    await a.put({ id: 'file:x', kind: 'file', label: 'x.ts', provenance: 'observed' });
    await b.put({ id: 'file:x', kind: 'file', label: 'x.ts', attrs: { note: 'b saw it too' } }); // cross-origin add → merged version 2
    c.tick();
    const e1 = await a.link({ src: 'ticket:1', dst: 'file:x', rel: 'touched', cost: 2, scope: 'main', attrs: { lines: 3 }, provenance: 'observed', validFrom: 5 });
    const e2 = await b.link({ src: 'file:x', dst: 'ticket:1', rel: 'notes', directed: false, id: 'edge:b-note' });
    c.tick();
    const e3 = await a.supersede(e1.id, { src: 'ticket:1', dst: 'file:x', rel: 'touched', cost: 1, provenance: 'observed' });
    c.tick();
    await b.supersede(e2.id);
    await a.put({ id: 'ticket:1', kind: 'ticket', label: 'First (renamed)', recordedAt: c.t + 5 });
    return { root, a, b, c, journal, e1, e2, e3 };
  }

  /** Everything observable about a graph, in a deterministic shape. */
  async function fingerprint(g: Graph) {
    const stats = await g.stats();
    const ids = (await g.match({ limit: 1000 })).map((n) => n.id).sort();
    const versions = [];
    const edges = [];
    for (const id of ids) {
      const tr = await g.trace(id);
      versions.push(tr.versions.map(({ id: nid, version, kind, label, attrs, origin, provenance, recordedAt, createdBy, createdAt, flags }) => ({ nid, version, kind, label, attrs, origin, provenance, recordedAt, createdBy, createdAt, flags })));
      edges.push(...tr.edgesOut);
    }
    edges.sort((x, y) => (x.id < y.id ? -1 : 1));
    const chains = [];
    for (const e of edges) chains.push((await g.traceEdge(e.id)).chain.map((x) => x.id));
    return { stats: { ...stats, bytes: 0 }, versions, edges, chains };
  }

  describe('journal', () => {
    test('captures every write, after commit, in order, with every field explicit', async () => {
      const { journal, e1, e2, e3, a, c } = await story();
      assert.deepEqual(journal.map((op) => op.op), ['put', 'put', 'put', 'link', 'link', 'supersede', 'supersede', 'put']);

      const p1 = journal[0] as Extract<JournalOp, { op: 'put' }>;
      assert.deepEqual(p1, {
        op: 'put',
        input: { id: 'ticket:1', kind: 'ticket', label: 'First', attrs: { p: 1 }, origin: 'run:a', provenance: 'observed', recordedAt: 1_000_000 },
        version: 1,
      });
      const merged = journal[2] as Extract<JournalOp, { op: 'put' }>;
      assert.equal(merged.version, 2);
      assert.deepEqual(merged.input.attrs, { note: 'b saw it too' }, 'the merged attrs AS STORED, not the raw request');
      assert.equal(merged.input.origin, 'run:b');
      assert.equal(merged.input.provenance, 'claimed', 'no inherited provenance');

      const l1 = journal[3] as Extract<JournalOp, { op: 'link' }>;
      assert.deepEqual(l1.input, {
        id: e1.id, src: 'ticket:1', dst: 'file:x', rel: 'touched', cost: 2, directed: true, scope: 'main', attrs: { lines: 3 },
        origin: 'run:a', provenance: 'observed', validFrom: 5, validTo: null, recordedAt: e1.recordedAt,
      });
      const l2 = journal[4] as Extract<JournalOp, { op: 'link' }>;
      assert.equal(l2.input.id, 'edge:b-note', 'a pre-minted id is journaled as given');
      assert.equal(l2.input.directed, false);
      assert.equal(l2.input.cost, 1, 'defaults are made explicit');

      const s1 = journal[5] as Extract<JournalOp, { op: 'supersede' }>;
      assert.equal(s1.edgeId, e1.id);
      assert.equal(s1.at, e3.recordedAt);
      assert.equal(s1.replacement?.id, e3.id);
      assert.equal(s1.replacement?.provenance, 'observed');
      assert.ok(!('supersedes' in (s1.replacement ?? {})), 'the op kind says it; the field is not repeated');
      const s2 = journal[6] as Extract<JournalOp, { op: 'supersede' }>;
      assert.deepEqual(s2, { op: 'supersede', edgeId: e2.id, at: s2.at });
      assert.equal((await a.getEdge(e2.id))?.supersededAt, s2.at);

      const p4 = journal[7] as Extract<JournalOp, { op: 'put' }>;
      assert.equal(p4.input.recordedAt, c.t + 5, 'an explicit recordedAt is kept');
      assert.deepEqual(p4.input.attrs, { p: 1 }, "the owner's omitted attrs are the kept ones");

      // A refused write journals nothing.
      const before = journal.length;
      await assert.rejects(a.put({ id: 'ticket:1', kind: 'ticket', label: 'x', attrs: { t: 'ghp_' + 'A'.repeat(36) } }), GuardError);
      await assert.rejects(a.supersede(e1.id), /already superseded/);
      assert.equal(journal.length, before);
    });

    test('is inherited by as() and not invoked during replay', async () => {
      const { root, journal } = await story();
      const fresh: JournalOp[] = [];
      const target = await h.open({ origin: 'ops', privileged: true, journal: (op) => fresh.push(op) });
      await target.replay(journal);
      assert.deepEqual(fresh, [], 'no echo');
      // A live write through a derived handle afterwards does journal.
      await target.as('run:z').put({ id: 'z', kind: 'k', label: 'Z' });
      assert.equal(fresh.length, 1);
      assert.equal((fresh[0] as Extract<JournalOp, { op: 'put' }>).input.origin, 'run:z');
      await root.close();
      await target.close();
    });
  });

  describe('replay', () => {
    test('a fresh graph replayed from the journal is indistinguishable from the original', async () => {
      const { root, journal } = await story();
      const target = await h.open({ origin: 'ops', privileged: true, now: () => 42 });
      const r = await target.replay(journal);
      assert.deepEqual(r, { applied: journal.length, skipped: 0 });
      assert.deepEqual(await fingerprint(target), await fingerprint(root));
      // Spot checks a fingerprint could hide.
      assert.equal((await target.get('file:x'))?.createdBy, 'run:a');
      assert.equal((await target.get('file:x'))?.version, 2);
      assert.deepEqual((await target.get('file:x'))?.attrs, { note: 'b saw it too' });
      assert.equal((await target.trace('ticket:1')).versions[0].recordedAt, 1_000_000, "the journal's clock, not the target's");
      assert.equal((await target.getEdge('edge:b-note'))?.origin, 'run:b');
      assert.equal((await target.getEdge('edge:b-note'))?.supersededAt, (await root.getEdge('edge:b-note'))?.supersededAt);
      await root.close();
      await target.close();
    });

    test('replaying twice, or an overlapping journal, skips everything already there', async () => {
      const { root, journal } = await story();
      const target = await h.open({ origin: 'ops', privileged: true });
      await target.replay(journal);
      const again = await target.replay(journal);
      assert.deepEqual(again, { applied: 0, skipped: journal.length });
      const overlap = await target.replay(journal.slice(3));
      assert.deepEqual(overlap, { applied: 0, skipped: journal.length - 3 });
      assert.deepEqual(await fingerprint(target), await fingerprint(root));
      // Replaying the ORIGINAL's own journal onto itself is a no-op too.
      assert.deepEqual(await root.replay(journal), { applied: 0, skipped: journal.length });
      assert.deepEqual(await fingerprint(root), await fingerprint(target));
      await root.close();
      await target.close();
    });

    test("two writers' journals merged by recordedAt give the same graph in either merge order", async () => {
      const c = clock();
      const ja: JournalOp[] = [];
      const jb: JournalOp[] = [];
      const ga = await h.open({ origin: 'run:a', trusted: true, now: c.now, journal: (op) => ja.push(op) });
      const gb = await h.open({ origin: 'run:b', trusted: true, now: c.now, journal: (op) => jb.push(op) });
      // Interleaved in time, distinct ids, each writer on its own database.
      await ga.put({ id: 'a1', kind: 'k', label: 'A1' }); c.tick();
      await gb.put({ id: 'b1', kind: 'k', label: 'B1' }); c.tick();
      await ga.put({ id: 'a2', kind: 'k', label: 'A2' }); c.tick();
      await gb.put({ id: 'b2', kind: 'k', label: 'B2' }); c.tick();
      const ea = await ga.link({ src: 'a1', dst: 'a2', rel: 'r', id: 'edge:a' }); c.tick();
      await gb.link({ src: 'b1', dst: 'b2', rel: 'r', id: 'edge:b' }); c.tick();
      await ga.supersede(ea.id, { src: 'a2', dst: 'a1', rel: 'r', id: 'edge:a2' }); c.tick();
      await gb.put({ id: 'b1', kind: 'k', label: 'B1 again' });
      await ga.close();
      await gb.close();

      const at = (op: JournalOp) => (op.op === 'supersede' ? op.at : op.input.recordedAt ?? 0);
      const merged1 = [...ja, ...jb].sort((x, y) => at(x) - at(y));
      const merged2 = [...jb, ...ja].sort((x, y) => at(x) - at(y));
      const t1 = await h.open({ origin: 'ops', privileged: true });
      const t2 = await h.open({ origin: 'ops', privileged: true });
      assert.deepEqual(await t1.replay(merged1), { applied: 8, skipped: 0 });
      assert.deepEqual(await t2.replay(merged2), { applied: 8, skipped: 0 });
      assert.deepEqual(await fingerprint(t1), await fingerprint(t2));
      assert.equal((await t1.stats()).nodes, 4);
      assert.equal((await t1.get('b1'))?.version, 2);
      assert.deepEqual((await t1.traceEdge('edge:a')).chain.map((e) => e.id), ['edge:a', 'edge:a2']);
      await t1.close();
      await t2.close();
    });

    test('needs a privileged AND trusted handle; guards still run; a broken op names its index', async () => {
      const { root, journal } = await story();
      const untrusted = await h.open({ origin: 'agent' });
      await assert.rejects(untrusted.replay(journal), (e: unknown) => e instanceof PermissionError && /privileged: true, trusted: true/.test((e as Error).message));
      const trustedOnly = await h.open({ origin: 'rt', trusted: true });
      await assert.rejects(trustedOnly.replay(journal), PermissionError);
      const ro = await h.open({ origin: 'ops', privileged: true, readOnly: true });
      await assert.rejects(ro.replay(journal), /read-only/);

      const target = await h.open({ origin: 'ops', privileged: true });
      const poisoned: JournalOp[] = [
        journal[0],
        { op: 'put', input: { id: 'leak', kind: 'k', label: 'x', attrs: { t: 'ghp_' + 'B'.repeat(36) }, origin: 'run:a', provenance: 'claimed', recordedAt: 5 }, version: 1 },
        journal[1],
      ];
      await assert.rejects(
        target.replay(poisoned),
        (e: unknown) => e instanceof GuardError && /^replay: op #1 \(put\): put: attrs looks like a credential/.test((e as Error).message) && !(e as Error).message.includes('BBBB'),
      );
      assert.equal((await target.get('ticket:1'))?.version, 1, 'ops before the bad one stay applied');
      assert.equal(await target.get('leak'), undefined);
      assert.equal(await target.get('file:x'), undefined, 'ops after it were not reached');
      // Fix the journal, replay again: the first op is skipped, the rest applied.
      assert.deepEqual(await target.replay([journal[0], journal[1]]), { applied: 1, skipped: 1 });

      // A link whose endpoint op is missing is an error, not a silent skip.
      await assert.rejects((await h.open({ origin: 'ops', privileged: true })).replay([journal[3]]), /op #0 \(link\).*does not exist/);
      // An op without its explicit fields is refused rather than stamped with the target's clock.
      await assert.rejects(
        (await h.open({ origin: 'ops', privileged: true })).replay([{ op: 'put', input: { id: 'n', kind: 'k', label: 'L', origin: 'o', provenance: 'claimed' }, version: 1 }]),
        /explicit recordedAt/,
      );
      await root.close();
      await target.close();
    });
  });

  describe('dump / load', () => {
    test('dump → load onto a fresh database reproduces the graph; loading again is a no-op', async () => {
      const { root, a } = await story();
      // A recall so the access table has rows to carry too.
      await a.recall({ seeds: ['ticket:1'], maxCost: 2 });
      const dump = await root.dump();
      assert.equal(dump.schemaVersion, 1);
      assert.equal(dump.nodes.length, 2);
      assert.equal(dump.nodeVersions.length, 4);
      assert.equal(dump.edges.length, 3);
      assert.ok(dump.access.length > 0);
      assert.equal(typeof dump.nodes[0].attrs, 'string', 'attrs are the stored JSON strings');
      assert.deepEqual(Object.keys(dump.edges[0]), ['id', 'src', 'dst', 'rel', 'cost', 'directed', 'scope', 'attrs', 'origin', 'provenance', 'valid_from', 'valid_to', 'recorded_at', 'superseded_at', 'supersedes', 'superseded_by', 'flags']);
      assert.equal(typeof dump.edges[0].recorded_at, 'number', 'epochs are numbers whichever engine stored them');

      const target = await h.open({ origin: 'ops', privileged: true });
      const total = dump.nodes.length + dump.nodeVersions.length + dump.edges.length + dump.access.length;
      assert.deepEqual(await target.load(dump), { inserted: total, skipped: 0 });
      assert.deepEqual(await fingerprint(target), await fingerprint(root));
      assert.deepEqual(await target.dump(), dump, 'a dump of the copy is the same dump');
      assert.deepEqual(await target.load(dump), { inserted: 0, skipped: total });
      assert.deepEqual(await target.dump(), dump);

      // A newer dump wins the `nodes` row; an older one does not undo it.
      const older = await h.open({ origin: 'ops', privileged: true });
      await older.load(dump);
      const newer = await h.open({ origin: 'ops', privileged: true });
      await newer.load(dump);
      await newer.as('run:a', { trusted: true }).put({ id: 'ticket:1', kind: 'ticket', label: 'newest', recordedAt: 9_000_000 });
      const newerDump = await newer.dump();
      const r1 = await older.load(newerDump);
      assert.equal(r1.inserted, 2, 'one new version row, one updated nodes row');
      assert.equal((await older.get('ticket:1'))?.label, 'newest');
      const r2 = await older.load(dump);
      assert.deepEqual(r2, { inserted: 0, skipped: total }, 'the older nodes row does not win');
      assert.equal((await older.get('ticket:1'))?.label, 'newest');
      await root.close();
      await target.close();
      await older.close();
      await newer.close();
    });

    test('load is privileged, atomic, guarded, and refuses a newer schema', async () => {
      const { root } = await story();
      const dump = await root.dump();
      await assert.rejects((await h.open({ origin: 'x', trusted: true })).load(dump), (e: unknown) => e instanceof PermissionError && /privileged/.test((e as Error).message));
      await assert.rejects((await h.open({ origin: 'x', privileged: true, readOnly: true })).load(dump), /read-only/);
      await assert.rejects((await h.open({ origin: 'x', privileged: true })).load({ ...dump, schemaVersion: 99 }), /newer/);

      const target = await h.open({ origin: 'x', privileged: true });
      const poisoned: GraphDump = {
        ...dump,
        edges: [...dump.edges, { ...dump.edges[0], id: 'edge:leak', attrs: JSON.stringify({ t: 'ghp_' + 'C'.repeat(36) }) }],
      };
      await assert.rejects(
        target.load(poisoned),
        (e: unknown) => e instanceof GuardError && /^load edges: attrs looks like a credential/.test((e as Error).message) && !(e as Error).message.includes('CCCC'),
      );
      assert.equal((await target.stats()).nodes, 0, 'atomic: the nodes loaded before the bad edge were rolled back');
      assert.equal((await target.stats()).edges, 0);
      await root.close();
      await target.close();
    });
  });

  describe('journalToSql', () => {
    test('renders each op as the statements the store runs; executing them equals replaying', async () => {
      const { root, journal } = await story();
      const replayed = await h.open({ origin: 'ops', privileged: true });
      await replayed.replay(journal);

      // Statements in the store's own dialect (SQLite flavour) run through the
      // driver, which renders them for its engine — the same path the store
      // itself takes, so the rows must come out identical.
      const db = await h.rawDriver();
      for (const op of journal) {
        for (const s of journalToSql(op)) await db.run(s.sql, s.params);
      }
      const expected = await replayed.dump();
      const rows = async (table: string, order: string) => (await db.all(`SELECT * FROM ${table} ORDER BY ${order}`)).map((r) => ({ ...r }));
      assert.deepEqual(await rows('node_versions', 'id, version'), expected.nodeVersions);
      assert.deepEqual(await rows('nodes', 'id'), expected.nodes);
      assert.deepEqual(await rows('edges', 'id'), expected.edges);
      await db.close();

      // Shape: put = history insert + latest upsert; link = one insert;
      // supersede = replacement insert then the retire UPDATE (or just the UPDATE).
      assert.deepEqual(journalToSql(journal[0]).map((s) => s.sql.split(' ')[0] + ' ' + s.sql.split(' ')[2]), ['INSERT node_versions', 'INSERT nodes']);
      assert.equal(journalToSql(journal[3]).length, 1);
      const sup = journalToSql(journal[5]);
      assert.equal(sup.length, 2);
      assert.match(sup[0].sql, /^INSERT INTO edges/);
      assert.match(sup[1].sql, /^UPDATE edges SET superseded_at/);
      assert.equal(journalToSql(journal[6]).length, 1);
      assert.match(journalToSql(journal[6])[0].sql, /^UPDATE edges/);
      // The Postgres rendering of the same op: numbered placeholders, same params.
      const pg = journalToSql(journal[3], 'postgres')[0];
      assert.ok(!pg.sql.includes('?'), 'no bare placeholders');
      assert.match(pg.sql, /\$17\)/);
      assert.deepEqual(pg.params, journalToSql(journal[3])[0].params);
      // Pure: no graph involved, and an op missing its explicit clock is refused.
      assert.throws(() => journalToSql({ op: 'put', input: { id: 'n', kind: 'k', label: 'L', origin: 'o', provenance: 'claimed' }, version: 1 }), /explicit recordedAt/);
      await root.close();
      await replayed.close();
    });
  });
}
