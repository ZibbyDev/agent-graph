/**
 * A small agent fleet over three rounds, as one list of FACTS.
 *
 * The same facts feed two stores — the agent-graph (`buildGraph`) and a flat
 * SQLite `events` table (`baseline.ts`) — so the comparison in `run.ts` is
 * between two ways of ASKING, not two sets of data.
 *
 * The scenario (an online shop, repo `acme/shop`, three members):
 *
 *   round 1  Ada takes ticket 100 (discount API), touches pricing.ts and the
 *            README, returns it ("rounding rule undefined") and leaves a
 *            CLAIM: "the discount API must be rate-limited".
 *            Cy takes ticket 101 (coupon at checkout), touches checkout.ts,
 *            returns it: blocked on ticket 100.
 *   round 2  Bo finishes ticket 100 (merged, PR #412). His run finds Ada's
 *            claim wrong; he cannot supersede her edge (PermissionError, kept
 *            in `denied`), so the manager's privileged handle records the
 *            correction in his name.
 *            Cy retries 101, touches checkout.ts + cart.ts, returns it again:
 *            rounding tests fail. Ada merges ticket 103 (orders API).
 *   round 3  The manager dispatches 101 to Ada with a PLAN to touch
 *            checkout.ts, cart.ts, pricing.ts. Bo is editing pricing.ts RIGHT
 *            NOW (ticket 102, open edge). Cy touched pricing.ts earlier this
 *            round and finished (closed edge).
 *
 * Time is driven by a controllable clock so every write lands in its round.
 */

import { openGraph } from '../../src/index.js';
import type { Graph, Provenance } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Clock and rounds
// ---------------------------------------------------------------------------

export const HOUR = 36e5;
export const DAY = 24 * HOUR;

/** Round starts, 09:00 UTC on three consecutive days. */
export const R1 = Date.UTC(2026, 8, 1, 9);
export const R2 = R1 + DAY;
export const R3 = R1 + 2 * DAY;
/** The instant the manager asks the questions: six hours into round 3. */
export const NOW = R3 + 6 * HOUR;

export const ROUNDS = [
  { n: 1, start: R1, end: R2 - 1 },
  { n: 2, start: R2, end: R3 - 1 },
  { n: 3, start: R3, end: NOW },
] as const;

export function roundOf(t: number): number {
  if (t >= R3) return 3;
  if (t >= R2) return 2;
  return 1;
}

export function fmtTime(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z (round ${roundOf(t)})`;
}

/** A clock the graph reads; the fixture moves it so each fact is recorded at
 *  the instant it happened. */
export class Clock {
  constructor(public t: number) {}
  now = (): number => this.t;
  set(t: number): void {
    this.t = t;
  }
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

export const ADA = 'member:ada';
export const BO = 'member:bo';
export const CY = 'member:cy';
export const MANAGER = 'manager';

export const REPO = 'repo:github.com/acme/shop';
export const EPIC = 'epic:checkout-v2';

export const F_CHECKOUT = 'file:github.com/acme/shop/src/checkout.ts';
export const F_CART = 'file:github.com/acme/shop/src/cart.ts';
export const F_PRICING = 'file:github.com/acme/shop/src/pricing.ts';
export const F_ORDERS = 'file:github.com/acme/shop/src/api/orders.ts';
export const F_README = 'file:github.com/acme/shop/README.md';

/** T — the ticket the manager is asking about. */
export const T = 'ticket:acme/101';
/** D — the ticket T depends on. */
export const D = 'ticket:acme/100';
export const T102 = 'ticket:acme/102';
export const T103 = 'ticket:acme/103';
export const T104 = 'ticket:acme/104';

export const RUN_R1_ADA = 'run:r1-ada';
export const RUN_R1_CY = 'run:r1-cy';
export const RUN_R2_BO = 'run:r2-bo';
export const RUN_R2_CY = 'run:r2-cy';
export const RUN_R2_ADA = 'run:r2-ada';
export const RUN_R3_ADA = 'run:r3-ada';
export const RUN_R3_BO = 'run:r3-bo';
export const RUN_R3_CY = 'run:r3-cy';

export const NOTE_CLAIM_1 = 'note:r1-ada/discount-rate-limit';
export const NOTE_CLAIM_2 = 'note:r2-bo/discount-idempotent';

/** Fixture-local handles for the two edges the supersession chain relates. */
export const CLAIM_EDGE_1 = 'claim-1';
export const CLAIM_EDGE_2 = 'claim-2';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface NodeFact {
  at: number;
  /** Origin writing the fact. */
  by: string;
  node: { id: string; kind: string; label: string; attrs?: Record<string, unknown>; provenance: Provenance };
}

export interface EdgeFact {
  at: number;
  by: string;
  edge: {
    /** Fixture-local handle so a later fact can refer to this edge. */
    key?: string;
    src: string;
    dst: string;
    rel: string;
    cost?: number;
    scope?: string | null;
    attrs?: Record<string, unknown>;
    provenance: Provenance;
    validFrom?: number | null;
    validTo?: number | null;
    /** Explicit origin, for a privileged handle writing in someone's name. */
    origin?: string;
  };
}

export interface SupersedeFact {
  at: number;
  by: string;
  privileged?: boolean;
  /** When set, the fixture EXPECTS the write to be refused with this error
   *  name and records the refusal instead of failing. */
  expectDenied?: string;
  supersede: { key: string; replacement?: EdgeFact['edge'] };
}

export type Fact = NodeFact | EdgeFact | SupersedeFact;

const observed = 'observed' as const;
const claimed = 'claimed' as const;

function node(at: number, by: string, id: string, kind: string, label: string, attrs: Record<string, unknown> = {}, provenance: Provenance = observed): NodeFact {
  return { at, by, node: { id, kind, label, attrs, provenance } };
}

function edge(at: number, by: string, e: EdgeFact['edge']): EdgeFact {
  return { at, by, edge: e };
}

function fileLabel(id: string): string {
  return id.slice('file:github.com/acme/shop/'.length);
}

/**
 * One run's observed facts as the runtime would write them: the run node, who
 * performed it, which ticket, which files (with the edit window), and the
 * outcome. Finished runs are written at their end, when the windows are
 * known; a running run has open windows (validTo null).
 */
function run(opts: {
  id: string;
  member: string;
  ticket: string;
  start: number;
  end: number | null;
  touched: Array<{ file: string; from: number; to: number | null }>;
  status: 'done' | 'running';
  outcome?: string;
  pr?: string;
}): Fact[] {
  const at = opts.end ?? opts.start;
  const attrs: Record<string, unknown> = { status: opts.status, startedAt: opts.start };
  if (opts.end !== null) attrs.finishedAt = opts.end;
  if (opts.outcome) attrs.outcome = opts.outcome;
  if (opts.pr) attrs.pr = opts.pr;
  const facts: Fact[] = [
    node(opts.start, opts.id, opts.id, 'run', `${opts.id.slice(4)} (${opts.member.slice(7)} on ${opts.ticket.slice(12)})`, { status: 'running', startedAt: opts.start }),
    edge(opts.start, opts.id, { src: opts.id, dst: opts.member, rel: 'performed_by', provenance: observed, validFrom: opts.start, validTo: opts.end }),
    edge(opts.start, opts.id, { src: opts.id, dst: opts.ticket, rel: 'worked_on', provenance: observed, validFrom: opts.start, validTo: opts.end }),
  ];
  for (const t of opts.touched) {
    facts.push(node(t.from, opts.id, t.file, 'file', fileLabel(t.file)));
    facts.push(edge(t.from, opts.id, { src: opts.id, dst: t.file, rel: 'touched', cost: 1, provenance: observed, validFrom: t.from, validTo: t.to }));
  }
  if (opts.end !== null) {
    // The run's final state: a second version of the same node.
    facts.push(node(at, opts.id, opts.id, 'run', `${opts.id.slice(4)} (${opts.member.slice(7)} on ${opts.ticket.slice(12)})`, attrs));
  }
  return facts;
}

export function fleetFacts(): Fact[] {
  const facts: Fact[] = [];
  const push = (...f: Fact[]) => facts.push(...f);

  // --- Round 1 dispatch: the manager sets up the board ----------------------
  const d1 = R1;
  push(
    node(d1, MANAGER, REPO, 'repo', 'acme/shop'),
    node(d1, MANAGER, EPIC, 'epic', 'Checkout v2'),
    node(d1, MANAGER, ADA, 'member', 'Ada'),
    node(d1, MANAGER, BO, 'member', 'Bo'),
    node(d1, MANAGER, CY, 'member', 'Cy'),
    node(d1, MANAGER, D, 'ticket', 'Pricing service: expose discount API'),
    node(d1, MANAGER, T, 'ticket', 'Apply coupon at checkout'),
    node(d1, MANAGER, T102, 'ticket', 'Rounding fix in pricing'),
    node(d1, MANAGER, T103, 'ticket', 'Orders API pagination'),
    node(d1, MANAGER, T104, 'ticket', 'Document pricing rounding'),
    edge(d1, MANAGER, { src: T, dst: D, rel: 'depends_on', cost: 2, provenance: observed, attrs: { reason: 'checkout needs the discount endpoint' } }),
    edge(d1, MANAGER, { src: T, dst: EPIC, rel: 'in_epic', cost: 4, provenance: observed }),
    edge(d1, MANAGER, { src: D, dst: EPIC, rel: 'in_epic', cost: 4, provenance: observed }),
    edge(d1, MANAGER, { src: T102, dst: EPIC, rel: 'in_epic', cost: 4, provenance: observed }),
  );
  // Files the repo is known to contain; `in_repo` is the hub edge (cost 10).
  for (const f of [F_CHECKOUT, F_CART, F_PRICING, F_ORDERS, F_README]) {
    push(node(d1, MANAGER, f, 'file', fileLabel(f)));
    push(edge(d1, MANAGER, { src: f, dst: REPO, rel: 'in_repo', cost: 10, provenance: observed }));
  }

  // --- Round 1 -------------------------------------------------------------
  // Ada on D: returns it, and leaves a claim that will turn out to be wrong.
  push(
    ...run({
      id: RUN_R1_ADA, member: ADA, ticket: D, start: R1 + 1 * HOUR, end: R1 + 4 * HOUR, status: 'done', outcome: 'returned',
      touched: [
        { file: F_PRICING, from: R1 + 1.5 * HOUR, to: R1 + 3.5 * HOUR },
        { file: F_README, from: R1 + 3 * HOUR, to: R1 + 3.5 * HOUR },
      ],
    }),
    edge(R1 + 4 * HOUR, RUN_R1_ADA, { src: RUN_R1_ADA, dst: D, rel: 'returned', provenance: observed, attrs: { reason: 'spec unclear: discount rounding rule is not defined' } }),
    node(R1 + 3.8 * HOUR, RUN_R1_ADA, NOTE_CLAIM_1, 'note', 'Discount API must be rate-limited before checkout may call it', { text: 'The discount endpoint recomputes the whole cart; checkout must rate-limit calls to it or the pricing service will fall over.' }, claimed),
    edge(R1 + 3.8 * HOUR, RUN_R1_ADA, { key: CLAIM_EDGE_1, src: RUN_R1_ADA, dst: NOTE_CLAIM_1, rel: 'notes', scope: 'main', provenance: claimed }),
  );
  // Cy on T: blocked by D.
  push(
    ...run({
      id: RUN_R1_CY, member: CY, ticket: T, start: R1 + 2 * HOUR, end: R1 + 5 * HOUR, status: 'done', outcome: 'returned',
      touched: [{ file: F_CHECKOUT, from: R1 + 2.5 * HOUR, to: R1 + 4.5 * HOUR }],
    }),
    edge(R1 + 5 * HOUR, RUN_R1_CY, { src: RUN_R1_CY, dst: T, rel: 'returned', provenance: observed, attrs: { reason: 'blocked: ticket 100 discount API is not available yet' } }),
  );

  // --- Round 2 -------------------------------------------------------------
  // Bo finishes D. His run finds Ada's claim wrong.
  push(
    ...run({
      id: RUN_R2_BO, member: BO, ticket: D, start: R2 + 1 * HOUR, end: R2 + 5 * HOUR, status: 'done', outcome: 'merged', pr: 'acme/shop#412',
      touched: [
        { file: F_PRICING, from: R2 + 1.5 * HOUR, to: R2 + 4.5 * HOUR },
        { file: F_README, from: R2 + 4 * HOUR, to: R2 + 4.5 * HOUR },
      ],
    }),
    node(R2 + 3 * HOUR, RUN_R2_BO, NOTE_CLAIM_2, 'note', 'Discount API is idempotent; no rate limit needed, rounding is half-up', { text: 'The endpoint is a pure function of (cart, coupon) and cached; no rate limit. Finance confirmed half-up rounding on the final amount.' }, claimed),
    // Bo's own handle may not retire Ada's assertion…
    { at: R2 + 3 * HOUR, by: RUN_R2_BO, expectDenied: 'PermissionError', supersede: { key: CLAIM_EDGE_1 } },
    // …so the manager's privileged handle records the correction, in Bo's name.
    {
      at: R2 + 3 * HOUR, by: MANAGER, privileged: true,
      supersede: { key: CLAIM_EDGE_1, replacement: { key: CLAIM_EDGE_2, src: RUN_R2_BO, dst: NOTE_CLAIM_2, rel: 'notes', scope: 'main', provenance: claimed, origin: RUN_R2_BO } },
    },
  );
  // Cy retries T: tests fail on rounding.
  push(
    ...run({
      id: RUN_R2_CY, member: CY, ticket: T, start: R2 + 2 * HOUR, end: R2 + 6 * HOUR, status: 'done', outcome: 'returned',
      touched: [
        { file: F_CHECKOUT, from: R2 + 2.5 * HOUR, to: R2 + 5.5 * HOUR },
        { file: F_CART, from: R2 + 4 * HOUR, to: R2 + 5.5 * HOUR },
      ],
    }),
    edge(R2 + 6 * HOUR, RUN_R2_CY, { src: RUN_R2_CY, dst: T, rel: 'returned', provenance: observed, attrs: { reason: 'tests failing: coupon total rounds half-up in pricing.ts but bankers in checkout.ts' } }),
  );
  // Ada merges ticket 103.
  push(
    ...run({
      id: RUN_R2_ADA, member: ADA, ticket: T103, start: R2 + 1 * HOUR, end: R2 + 3 * HOUR, status: 'done', outcome: 'merged', pr: 'acme/shop#415',
      touched: [{ file: F_ORDERS, from: R2 + 1.2 * HOUR, to: R2 + 2.8 * HOUR }],
    }),
  );

  // --- Round 3 -------------------------------------------------------------
  // Dispatch: T goes to Ada with a plan. The plan is recorded at dispatch time,
  // before any edit, which is what lets a manager see overlaps in advance.
  const d3 = R3;
  push(
    node(d3, MANAGER, RUN_R3_ADA, 'run', 'r3-ada (ada on 101)', { status: 'running', startedAt: d3 }),
    edge(d3, MANAGER, { src: RUN_R3_ADA, dst: ADA, rel: 'performed_by', provenance: observed, validFrom: d3, validTo: null }),
    edge(d3, MANAGER, { src: RUN_R3_ADA, dst: T, rel: 'worked_on', provenance: observed, validFrom: d3, validTo: null }),
  );
  for (const f of [F_CHECKOUT, F_CART, F_PRICING]) {
    push(edge(d3, MANAGER, { src: RUN_R3_ADA, dst: f, rel: 'plans_to_touch', cost: 1, provenance: claimed, validFrom: d3, validTo: null, attrs: { source: 'dispatch plan' } }));
  }
  // Bo is editing pricing.ts right now (open edge, status running).
  push(
    ...run({
      id: RUN_R3_BO, member: BO, ticket: T102, start: R3 + 0.5 * HOUR, end: null, status: 'running',
      touched: [{ file: F_PRICING, from: R3 + 1 * HOUR, to: null }],
    }),
  );
  // Cy touched pricing.ts earlier this round and is done (closed edge).
  push(
    ...run({
      id: RUN_R3_CY, member: CY, ticket: T104, start: R3 + 0.5 * HOUR, end: R3 + 2.5 * HOUR, status: 'done', outcome: 'merged', pr: 'acme/shop#420',
      touched: [
        { file: F_PRICING, from: R3 + 0.6 * HOUR, to: R3 + 2 * HOUR },
        { file: F_README, from: R3 + 1 * HOUR, to: R3 + 2.4 * HOUR },
      ],
    }),
  );

  // Facts are applied in time order, whatever order they were declared in.
  return facts.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Building the graph from the facts
// ---------------------------------------------------------------------------

export interface Fixture {
  graph: Graph;
  clock: Clock;
  facts: Fact[];
  /** Real edge ids the graph minted, by fixture-local key. */
  edgeIds: Record<string, string>;
  /** Refusals the fixture expected and captured (the PermissionError demo). */
  denied: Array<{ by: string; key: string; error: string }>;
}

/**
 * Apply the facts to a fresh graph, moving the clock to each fact's instant
 * so recordedAt (knowledge time) follows the story. Every write goes through
 * a handle opened as the fact's origin, exactly as the real runtime would.
 *
 * The root handle is the RUNTIME: privileged (it derives a handle per origin)
 * and therefore trusted (the facts are things it observed). Each member's
 * handle is derived trusted but not privileged — which is exactly why Bo's
 * attempt to retire Ada's claim is refused below.
 */
export async function buildGraph(path = ':memory:'): Promise<Fixture> {
  const facts = fleetFacts();
  const clock = new Clock(R1);
  const root = await openGraph(path, { origin: MANAGER, privileged: true, now: clock.now });
  const handles = new Map<string, Graph>();
  const as = (origin: string, privileged = false): Graph => {
    const k = `${origin}|${privileged}`;
    let h = handles.get(k);
    if (!h) {
      h = root.as(origin, { privileged, trusted: true });
      handles.set(k, h);
    }
    return h;
  };

  const edgeIds: Record<string, string> = {};
  const denied: Fixture['denied'] = [];

  for (const fact of facts) {
    clock.set(fact.at);
    if ('node' in fact) {
      await as(fact.by).put(fact.node);
    } else if ('edge' in fact) {
      const { key, ...input } = fact.edge;
      const rec = await as(fact.by).link(input);
      if (key) edgeIds[key] = rec.id;
    } else {
      const target = edgeIds[fact.supersede.key];
      if (!target) throw new Error(`fixture: no edge recorded under key ${fact.supersede.key}`);
      const handle = as(fact.by, fact.privileged ?? false);
      const replacement = fact.supersede.replacement;
      try {
        const rec = replacement ? await handle.supersede(target, stripKey(replacement)) : await handle.supersede(target);
        if (fact.expectDenied) throw new Error(`fixture: expected ${fact.expectDenied} for ${fact.by} superseding ${fact.supersede.key}`);
        if (replacement?.key) edgeIds[replacement.key] = rec.id;
      } catch (err) {
        if (!fact.expectDenied || (err as Error).name !== fact.expectDenied) throw err;
        denied.push({ by: fact.by, key: fact.supersede.key, error: `${(err as Error).name}: ${(err as Error).message}` });
      }
    }
  }

  // The story ends at NOW; the graph's default asOf is its clock.
  clock.set(NOW);
  return { graph: root, clock, facts, edgeIds, denied };
}

function stripKey(e: EdgeFact['edge']): Omit<EdgeFact['edge'], 'key'> {
  const { key: _key, ...rest } = e;
  return rest;
}
