/**
 * The four manager questions, answered two ways over the same facts:
 *
 *   graph — `recall` / `recallMany` with seeds, rels, a cost budget and the
 *           time filters the question actually needs;
 *   flat  — hand-written SQL over the `events` / `entities` tables.
 *
 * Every function returns plain data so `run.ts` can print it and
 * `test/example.test.ts` can assert on it. The graph answers also carry the
 * evidence the flat ones cannot: the path walked, each hop's provenance and
 * origin, and (for claims) the supersession chain.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { EdgeRecord, Graph, RecallHit, RecallManyResult, RecallQuery } from '../../src/types.js';
import { all } from './baseline.js';
import { D, HOUR, NOW, R1, R2, R3, T } from './fixture.js';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** One edge of a hit's path, oriented the way the walk crossed it: `from` is
 *  the node the walk stood on, `to` the node it reached, `forward` whether
 *  that matches the edge's own src→dst. */
export interface Hop {
  rel: string;
  from: string;
  to: string;
  forward: boolean;
  provenance: string;
  origin: string;
}

export interface TouchedFile {
  file: string;
  run: string;
  at: number;
  path?: Hop[];
}

export interface Q1 {
  member: string;
  touched: TouchedFile[];
  planned: Array<{ file: string; run: string; at: number; path?: Hop[] }>;
  overlap: string[];
}

export interface Q2 {
  ticket: string;
  returns: Array<{ run: string; at: number; reason: string; provenance?: string; edgeId?: string }>;
}

export interface Q3 {
  ticket: string;
  dependsOn: string[];
  lastRound: Array<{ run: string; member: string; outcome: string; pr?: string; path?: Hop[] }>;
}

export interface Q4 {
  ticket: string;
  planned: string[];
  editing: Array<{ run: string; file: string; since: number; status: string; path?: Hop[] }>;
}

export interface ClaimView {
  asOf: number;
  notes: Array<{ note: string; label: string; via: string; edgeId?: string; supersedes?: string | null; supersededBy?: string | null }>;
}

// ---------------------------------------------------------------------------
// Queries — the graph side is the reference; the same query objects are reused
// by the recallMany demo so the two are guaranteed to agree.
// ---------------------------------------------------------------------------

/** Files a member touched across all three rounds: member ←performed_by← run →touched→ file. */
export function qTouchedBy(member: string): RecallQuery {
  return { seeds: [member], rels: ['performed_by', 'touched'], maxCost: 2, kinds: ['file'], recordedBetween: [R1, NOW] };
}

/** Files a ticket's run plans to touch: ticket ←worked_on← run →plans_to_touch→ file. */
export function qPlannedFor(ticket: string): RecallQuery {
  return { seeds: [ticket], rels: ['worked_on', 'plans_to_touch'], maxCost: 2, kinds: ['file'] };
}

/** Runs editing the planned files at `now`: ticket ←worked_on← run →plans_to_touch→ file ←touched← run,
 *  with `validAt` so only edges whose window contains `now` are walked. */
export function qEditingNow(ticket: string, now: number): RecallQuery {
  return { seeds: [ticket], rels: ['worked_on', 'plans_to_touch', 'touched'], maxCost: 3, kinds: ['run'], validAt: now };
}

function hops(hit: RecallHit): Hop[] {
  const out: Hop[] = [];
  let at = hit.seed;
  for (const e of hit.path) {
    const forward = e.src === at;
    const to = forward ? e.dst : e.src;
    out.push({ rel: e.rel, from: at, to, forward, provenance: e.provenance, origin: e.origin });
    at = to;
  }
  return out;
}

function last(hit: RecallHit): EdgeRecord {
  return hit.path[hit.path.length - 1];
}

// ---------------------------------------------------------------------------
// Q1 — which files did member X touch, and do they overlap T's plan?
// ---------------------------------------------------------------------------

function q1FromHits(member: string, touched: RecallHit[], planned: RecallHit[]): Q1 {
  const touchedFiles = touched
    .map((h) => ({ file: h.node.id, run: last(h).src, at: last(h).validFrom ?? last(h).recordedAt, path: hops(h) }))
    .sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  const plannedFiles = planned
    .map((h) => ({ file: h.node.id, run: last(h).src, at: last(h).recordedAt, path: hops(h) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const plannedSet = new Set(plannedFiles.map((p) => p.file));
  const overlap = [...new Set(touchedFiles.filter((t) => plannedSet.has(t.file)).map((t) => t.file))].sort();
  return { member, touched: touchedFiles, planned: plannedFiles, overlap };
}

export async function q1Graph(g: Graph, member: string, ticket = T): Promise<Q1> {
  const [touched, planned] = await Promise.all([g.recall(qTouchedBy(member)), g.recall(qPlannedFor(ticket))]);
  return q1FromHits(member, touched.hits, planned.hits);
}

export function q1Sql(db: DatabaseSync, member: string, ticket = T): Q1 {
  const touched = all(
    db,
    `SELECT e.dst AS file, e.src AS run, COALESCE(e.valid_from, e.t) AS at
       FROM events e
       JOIN events p ON p.src = e.src AND p.verb = 'performed_by' AND p.dst = ?
      WHERE e.verb = 'touched' AND e.t BETWEEN ? AND ?
      ORDER BY at, file`,
    member, R1, NOW,
  ).map((r) => ({ file: r.file as string, run: r.run as string, at: r.at as number }));
  const planned = all(
    db,
    `SELECT DISTINCT pl.dst AS file, pl.src AS run, pl.t AS at
       FROM events pl
       JOIN events w ON w.src = pl.src AND w.verb = 'worked_on' AND w.dst = ?
      WHERE pl.verb = 'plans_to_touch'
      ORDER BY file`,
    ticket,
  ).map((r) => ({ file: r.file as string, run: r.run as string, at: r.at as number }));
  const plannedSet = new Set(planned.map((p) => p.file));
  const overlap = [...new Set(touched.filter((t) => plannedSet.has(t.file)).map((t) => t.file))].sort();
  return { member, touched, planned, overlap };
}

// ---------------------------------------------------------------------------
// Q2 — T was returned twice: where did it get stuck each time?
// ---------------------------------------------------------------------------

export async function q2Graph(g: Graph, ticket = T): Promise<Q2> {
  const r = await g.recall({ seeds: [ticket], rels: ['returned'], direction: 'in', maxCost: 1, kinds: ['run'] });
  const returns = r.hits
    .map((h) => {
      const e = last(h);
      return { run: h.node.id, at: e.recordedAt, reason: String(e.attrs.reason ?? ''), provenance: e.provenance, edgeId: e.id };
    })
    .sort((a, b) => a.at - b.at);
  return { ticket, returns };
}

export function q2Sql(db: DatabaseSync, ticket = T): Q2 {
  const returns = all(
    db,
    `SELECT src AS run, t AS at, json_extract(attrs, '$.reason') AS reason
       FROM events WHERE verb = 'returned' AND dst = ? ORDER BY t`,
    ticket,
  ).map((r) => ({ run: r.run as string, at: r.at as number, reason: String(r.reason ?? '') }));
  return { ticket, returns };
}

// ---------------------------------------------------------------------------
// Q3 — T depends on D: who worked on D last round, and what was the outcome?
// ---------------------------------------------------------------------------

/** "Last round" relative to NOW (round 3) is round 2. */
export const LAST_ROUND: [number, number] = [R2, R3 - 1];

export async function q3Graph(g: Graph, ticket = T): Promise<Q3> {
  const deps = await g.recall({ seeds: [ticket], rels: ['depends_on'], direction: 'out', maxCost: 2, kinds: ['ticket'] });
  const dependsOn = deps.hits.map((h) => h.node.id).sort();
  const lastRound: Q3['lastRound'] = [];
  for (const dep of dependsOn) {
    // Runs that worked on the dependency during the window, and who performed
    // them, in one walk: ticket ←worked_on← run →performed_by→ member.
    const r = await g.recall({
      seeds: [dep], rels: ['worked_on', 'performed_by'], maxCost: 2, kinds: ['run', 'member'], recordedBetween: LAST_ROUND,
    });
    const runs = r.hits.filter((h) => h.node.kind === 'run');
    const memberOf = new Map<string, string>();
    for (const h of r.hits) {
      if (h.node.kind === 'member') memberOf.set(last(h).src, h.node.id);
    }
    for (const run of runs) {
      lastRound.push({
        run: run.node.id,
        member: memberOf.get(run.node.id) ?? '?',
        outcome: String(run.node.attrs.outcome ?? run.node.attrs.status ?? 'unknown'),
        pr: typeof run.node.attrs.pr === 'string' ? run.node.attrs.pr : undefined,
        path: hops(run),
      });
    }
  }
  return { ticket, dependsOn, lastRound };
}

export function q3Sql(db: DatabaseSync, ticket = T): Q3 {
  const dependsOn = all(db, `SELECT dst FROM events WHERE verb = 'depends_on' AND src = ? ORDER BY dst`, ticket).map((r) => r.dst as string);
  const lastRound = all(
    db,
    `SELECT w.src AS run, p.dst AS member,
            COALESCE(json_extract(r.attrs, '$.outcome'), json_extract(r.attrs, '$.status')) AS outcome,
            json_extract(r.attrs, '$.pr') AS pr
       FROM events d
       JOIN events w ON w.verb = 'worked_on' AND w.dst = d.dst AND w.t BETWEEN ? AND ?
       JOIN events p ON p.verb = 'performed_by' AND p.src = w.src
       JOIN entities r ON r.id = w.src
      WHERE d.verb = 'depends_on' AND d.src = ?
      ORDER BY w.t`,
    LAST_ROUND[0], LAST_ROUND[1], ticket,
  ).map((r) => ({ run: r.run as string, member: r.member as string, outcome: String(r.outcome ?? 'unknown'), pr: (r.pr as string | null) ?? undefined }));
  return { ticket, dependsOn, lastRound };
}

// ---------------------------------------------------------------------------
// Q4 — is anyone editing, right now, the files T plans to touch?
// ---------------------------------------------------------------------------

function q4FromHits(ticket: string, planned: RecallHit[], editing: RecallHit[]): Q4 {
  const plannedFiles = planned.map((h) => h.node.id).sort();
  const open = editing
    .filter((h) => last(h).rel === 'touched')
    .map((h) => {
      const e = last(h);
      return { run: h.node.id, file: e.dst, since: e.validFrom ?? e.recordedAt, status: String(h.node.attrs.status ?? ''), path: hops(h) };
    })
    .sort((a, b) => a.since - b.since);
  return { ticket, planned: plannedFiles, editing: open };
}

export async function q4Graph(g: Graph, ticket = T, now = NOW): Promise<Q4> {
  const [planned, editing] = await Promise.all([g.recall(qPlannedFor(ticket)), g.recall(qEditingNow(ticket, now))]);
  return q4FromHits(ticket, planned.hits, editing.hits);
}

export function q4Sql(db: DatabaseSync, ticket = T, now = NOW): Q4 {
  const planned = all(
    db,
    `SELECT DISTINCT pl.dst AS file FROM events pl
       JOIN events w ON w.src = pl.src AND w.verb = 'worked_on' AND w.dst = ?
      WHERE pl.verb = 'plans_to_touch' ORDER BY file`,
    ticket,
  ).map((r) => r.file as string);
  const editing = all(
    db,
    `SELECT e.src AS run, e.dst AS file, COALESCE(e.valid_from, e.t) AS since,
            json_extract(r.attrs, '$.status') AS status
       FROM events e
       JOIN entities r ON r.id = e.src
      WHERE e.verb = 'touched'
        AND (e.valid_from IS NULL OR e.valid_from <= ?)
        AND (e.valid_to IS NULL OR e.valid_to > ?)
        AND e.dst IN (
          SELECT pl.dst FROM events pl
            JOIN events w ON w.src = pl.src AND w.verb = 'worked_on' AND w.dst = ?
           WHERE pl.verb = 'plans_to_touch')
      ORDER BY since`,
    now, now, ticket,
  ).map((r) => ({ run: r.run as string, file: r.file as string, since: r.since as number, status: String(r.status ?? '') }));
  return { ticket, planned, editing };
}

// ---------------------------------------------------------------------------
// Q1 + Q4 in one call
// ---------------------------------------------------------------------------

export async function q1q4Many(g: Graph, member: string, ticket = T, now = NOW): Promise<{ q1: Q1; q4: Q4; raw: RecallManyResult }> {
  const raw = await g.recallMany([qTouchedBy(member), qPlannedFor(ticket), qEditingNow(ticket, now)]);
  const [touched, planned, editing] = raw.results;
  return { q1: q1FromHits(member, touched.hits, planned.hits), q4: q4FromHits(ticket, planned.hits, editing.hits), raw };
}

// ---------------------------------------------------------------------------
// asOf — the claim about D as the graph knew it in round 2, before and after
// the correction
// ---------------------------------------------------------------------------

/** One hour into round 2: Ada's claim stands, Bo's correction has not landed. */
export const ROUND2_EARLY = R2 + 1 * HOUR;

export async function claimsGraph(g: Graph, asOf?: number, ticket = D): Promise<ClaimView> {
  const q: RecallQuery = { seeds: [ticket], rels: ['worked_on', 'notes'], maxCost: 2, kinds: ['note'] };
  if (asOf !== undefined) q.asOf = asOf;
  const r = await g.recall(q);
  const notes = r.hits.map((h) => {
    const e = last(h);
    return { note: h.node.id, label: h.node.label, via: e.src, edgeId: e.id, supersedes: e.supersedes, supersededBy: e.supersededBy };
  });
  return { asOf: asOf ?? NOW, notes };
}

export function claimsSql(db: DatabaseSync, asOf = NOW, ticket = D): ClaimView {
  const notes = all(
    db,
    `SELECT n.dst AS note, x.label AS label, n.src AS via
       FROM events n
       JOIN events w ON w.src = n.src AND w.verb = 'worked_on' AND w.dst = ?
       JOIN entities x ON x.id = n.dst
      WHERE n.verb = 'notes' AND n.t <= ? AND (n.superseded_at IS NULL OR n.superseded_at > ?)
      ORDER BY n.t`,
    ticket, asOf, asOf,
  ).map((r) => ({ note: r.note as string, label: r.label as string, via: r.via as string }));
  return { asOf, notes };
}
