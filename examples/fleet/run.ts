#!/usr/bin/env node
/**
 * The acceptance demo: a manager's four questions about a small agent fleet,
 * each answered by the graph and by hand-written SQL over a flat events table
 * built from the same facts, printed side by side.
 *
 *   npm run example
 *
 * Nothing here is hidden behind a helper the reader would have to trust: the
 * graph queries are in `questions.ts` next to the SQL they are compared with.
 */

import { buildFlat } from './baseline.js';
import { ADA, buildGraph, CLAIM_EDGE_1, D, fmtTime, NOW, T } from './fixture.js';
import {
  claimsGraph,
  claimsSql,
  q1Graph,
  q1q4Many,
  q1Sql,
  q2Graph,
  q2Sql,
  q3Graph,
  q3Sql,
  q4Graph,
  q4Sql,
  qPlannedFor,
  ROUND2_EARLY,
  type Hop,
} from './questions.js';

const out = (s = '') => process.stdout.write(s + '\n');
const short = (id: string): string => id.replace(/^file:github\.com\/acme\/shop\//, '').replace(/^(?:ticket:acme\/|member:|run:|note:)/, '');
const list = (xs: string[]): string => (xs.length ? xs.map(short).join(', ') : 'none');
const pathStr = (hops: Hop[] | undefined): string =>
  hops && hops.length
    ? short(hops[0].from) + hops.map((h) => (h.forward ? ` →${h.rel}[${h.provenance}]→ ${short(h.to)}` : ` ←${h.rel}[${h.provenance}]← ${short(h.to)}`)).join('')
    : '';

function heading(tag: string, question: string): void {
  out();
  out(`━━ ${tag}  ${question}`);
}

function section(label: 'graph' | 'sql' | 'note', lines: string[]): void {
  const tag = label.padEnd(5);
  lines.forEach((l, i) => out(`  ${i === 0 ? tag : '     '} › ${l}`));
}

async function main(): Promise<void> {
  const fx = buildGraph();
  const g = fx.graph;
  const db = buildFlat(fx.facts);

  out(`agent-graph fleet demo — ${g.stats().nodes} nodes, ${g.stats().edges} edges over three rounds; asking at ${fmtTime(NOW)}`);
  out(`Fleet: Ada, Bo, Cy on acme/shop. T = ${T} "Apply coupon at checkout"; D = ${D} "expose discount API".`);

  // ── Q1 ──────────────────────────────────────────────────────────────────
  heading('Q1', `Which files did Ada touch across the last three rounds, and do they overlap the files ${short(T)} plans to touch?`);
  const g1 = await q1Graph(g, ADA);
  const s1 = q1Sql(db, ADA);
  section('graph', [
    `Ada touched ${g1.touched.length} files: ${g1.touched.map((t) => `${short(t.file)} (${short(t.run)}, ${fmtTime(t.at)})`).join('; ')}`,
    `${short(T)} plans to touch: ${list(g1.planned.map((p) => p.file))} (${g1.planned[0] ? `${short(g1.planned[0].run)}, dispatched ${fmtTime(g1.planned[0].at)}` : '—'})`,
    `overlap: ${list(g1.overlap)}`,
    `evidence for the overlap: ${pathStr(g1.touched.find((t) => t.file === g1.overlap[0])?.path)}`,
  ]);
  section('sql', [
    `Ada touched ${s1.touched.length} files: ${s1.touched.map((t) => `${short(t.file)} (${short(t.run)}, ${fmtTime(t.at)})`).join('; ')}`,
    `${short(T)} plans to touch: ${list(s1.planned.map((p) => p.file))}`,
    `overlap: ${list(s1.overlap)}`,
  ]);
  section('note', [
    'same set of files; the graph hit also carries the PATH (member ← run → file) with the provenance of each hop, so "Ada touched it" is traceable to the run that observed it — the SQL needed a self-join we wrote knowing the schema.',
  ]);

  // ── Q2 ──────────────────────────────────────────────────────────────────
  heading('Q2', `${short(T)} was returned twice — where did it get stuck each time?`);
  const g2 = await q2Graph(g);
  const s2 = q2Sql(db);
  section('graph', g2.returns.map((r, i) => `return ${i + 1}: ${fmtTime(r.at)} by ${short(r.run)} [${r.provenance}] — "${r.reason}"`));
  section('sql', s2.returns.map((r, i) => `return ${i + 1}: ${fmtTime(r.at)} by ${short(r.run)} — "${r.reason}"`));
  section('note', [
    'identical answers. The graph one is a `returned` edge per event with its own id, origin and provenance — a later run can supersede a wrong reason without losing the original; the flat row can only be overwritten.',
  ]);

  // ── Q3 ──────────────────────────────────────────────────────────────────
  heading('Q3', `${short(T)} depends on ${short(D)} — who worked on ${short(D)} last round and what was the outcome?`);
  const g3 = await q3Graph(g);
  const s3 = q3Sql(db);
  section('graph', [
    `${short(T)} depends on: ${list(g3.dependsOn)}`,
    ...g3.lastRound.map((r) => `last round: ${short(r.member)} (${short(r.run)}) — outcome ${r.outcome}${r.pr ? `, ${r.pr}` : ''}`),
    `evidence: ${pathStr(g3.lastRound[0]?.path)}`,
  ]);
  section('sql', [
    `${short(T)} depends on: ${list(s3.dependsOn)}`,
    ...s3.lastRound.map((r) => `last round: ${short(r.member)} (${short(r.run)}) — outcome ${r.outcome}${r.pr ? `, ${r.pr}` : ''}`),
  ]);
  section('note', [
    'same answer; "last round" was one recordedBetween window on the graph walk versus a BETWEEN on one of three joined tables. Change the question to "two rounds back" and only the window changes.',
  ]);

  // ── Q4 ──────────────────────────────────────────────────────────────────
  heading('Q4', `Is anyone editing right now the files ${short(T)} plans to touch?`);
  const g4 = await q4Graph(g);
  const s4 = q4Sql(db);
  section('graph', [
    `planned files: ${list(g4.planned)}`,
    ...(g4.editing.length
      ? g4.editing.map((e) => `YES — ${short(e.run)} has ${short(e.file)} open since ${fmtTime(e.since)} (status ${e.status}); ${pathStr(e.path)}`)
      : ['no one']),
  ]);
  section('sql', [
    `planned files: ${list(s4.planned)}`,
    ...(s4.editing.length ? s4.editing.map((e) => `YES — ${short(e.run)} has ${short(e.file)} open since ${fmtTime(e.since)} (status ${e.status})`) : ['no one']),
  ]);
  section('note', [
    'same run found. On the graph it fell out of validAt=now filtering the walk (a closed edit window is simply not traversed; Cy\'s earlier edit of the same file this round is excluded); the SQL restates the window predicate by hand.',
  ]);

  // ── recallMany ──────────────────────────────────────────────────────────
  heading('+recallMany', 'Q1 + Q4 in ONE call: three queries, one database load, one deduplicated node map');
  const many = await q1q4Many(g, ADA);
  section('graph', [
    `results: ${many.raw.results.length} (touched-by-Ada, planned-for-${short(T)}, editing-now); shared nodes: ${Object.keys(many.raw.nodes).length}`,
    `Q1 overlap again: ${list(many.q1.overlap)}; Q4 again: ${many.q4.editing.map((e) => `${short(e.run)} on ${short(e.file)}`).join(', ') || 'no one'}`,
    `the planned-files query is shared by both questions, so it ran once.`,
  ]);

  // ── asOf ────────────────────────────────────────────────────────────────
  heading('+asOf', `What did we believe about ${short(D)} in round 2 (asOf) versus now — the superseded claim`);
  const early = await claimsGraph(g, ROUND2_EARLY);
  const live = await claimsGraph(g);
  const earlySql = claimsSql(db, ROUND2_EARLY);
  const liveSql = claimsSql(db);
  section('graph', [
    `asOf ${fmtTime(ROUND2_EARLY)}: ${early.notes.map((n) => `"${n.label}" (via ${short(n.via)})`).join('; ') || 'nothing'}`,
    `live view:            ${live.notes.map((n) => `"${n.label}" (via ${short(n.via)}, supersedes ${n.supersedes ? 'the round-1 claim' : 'nothing'})`).join('; ') || 'nothing'}`,
    `chain: ${g.traceEdge(fx.edgeIds[CLAIM_EDGE_1]).chain.map((e) => `${short(e.src)}→${short(e.dst)}${e.supersededAt ? ` (retired ${fmtTime(e.supersededAt)})` : ' (live)'}`).join('  ⇒  ')}`,
    `who could correct it: ${fx.denied.map((d) => `${d.by} was refused (${d.error.split(':')[0]}); the privileged manager handle recorded the correction`).join('; ')}`,
  ]);
  section('sql', [
    `asOf ${fmtTime(ROUND2_EARLY)}: ${earlySql.notes.map((n) => `"${n.label}" (via ${short(n.via)})`).join('; ') || 'nothing'}`,
    `live view:            ${liveSql.notes.map((n) => `"${n.label}" (via ${short(n.via)})`).join('; ') || 'nothing'}`,
  ]);
  section('note', [
    'the flat table answers only because we added superseded_at/supersedes columns knowing this question was coming, and it has no notion of who may retire whose assertion. In the graph every edge has both, and the chain is one traceEdge().',
  ]);

  // ── subgraph ────────────────────────────────────────────────────────────
  heading('+subgraph', `the visualiser's input for "the area around ${short(T)}'s plan"`);
  const sg = await g.subgraph({ ...qPlannedFor(T), kinds: undefined, maxCost: 2 });
  section('graph', [
    `${sg.nodes.length} nodes, ${sg.edges.length} live edges among them (all of them, not just the walked paths): ` +
      `${Object.entries(sg.nodes.reduce<Record<string, number>>((m, n) => ((m[n.kind] = (m[n.kind] ?? 0) + 1), m), {})).map(([k, n]) => `${n} ${k}`).join(', ')}`,
    `rels present: ${[...new Set(sg.edges.map((e) => e.rel))].sort().join(', ')}`,
  ]);

  out();
  g.close();
  db.close();
}

main().catch((err: unknown) => {
  process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
