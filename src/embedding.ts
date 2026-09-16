/**
 * Built-in embeddings: configured by the caller, computed on `put()`,
 * rebuilt by `reembed()`, searched by `recall({ locate })` and
 * `match({ semantic })`.
 *
 * The caller's `EmbeddingConfig` decides WHAT is embedded (`text`, `kinds`,
 * `maxChars`), because embedding every node of a busy graph is mostly waste:
 * runs and file paths are found by id, and only prose-bearing kinds reward a
 * vector. This file only knows how to turn the decision into rows.
 *
 * Storage is one row per node in `node_vectors`, holding the vector of the
 * version it was computed from. SQLite keeps a float32 BLOB and cosine runs
 * here, in JS, over every stored vector of the requested kinds — brute force,
 * which is fine at the sizes an agent memory reaches before anyone needs an
 * index. Postgres with pgvector keeps a `vector` and orders by `<=>` (cosine
 * distance) in SQL; without pgvector it keeps BYTEA and takes the JS path.
 *
 * A failed embedding never fails a write: the node is committed first, and a
 * model that is down loses a vector, not a fact. The failure is logged.
 */

import type { SqlParam, SqlValue } from './driver.js';
import type { HandleContext } from './graph.js';
import { SQL, rowToNode, num, type SqlRow } from './schema.js';
import type { EmbeddingConfig, NodeId, NodeRecord, ReembedOptions, ReembedResult } from './types.js';

export const DEFAULT_MAX_CHARS = 2000;
/** Texts per model call in `reembed()`. */
const BATCH = 64;

// ---------------------------------------------------------------------------
// The rule: which nodes, which text

/** The text the rule selects for a node, or null when the node is not to be
 *  embedded (kind not listed, or `text` declined). */
export function embeddingText(cfg: EmbeddingConfig, node: NodeRecord): string | null {
  if (cfg.kinds && !cfg.kinds.includes(node.kind)) return null;
  const raw = cfg.text ? cfg.text(node) : node.label;
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text.length === 0) return null;
  const max = cfg.maxChars ?? DEFAULT_MAX_CHARS;
  return text.length > max ? text.slice(0, max) : text;
}

/** How the HTTP server (and a config file) name a text rule without code. */
export type TextRuleSpec = 'label' | 'label+attrs' | { attrs: string[] };

/** A `text` function from a declarative spec: the label alone; the label
 *  plus every attr as `key: value` lines; or the label plus the listed attrs.
 *  Objects are JSON, so a nested value still reads as text. */
export function textRuleFrom(spec: TextRuleSpec | undefined): (node: NodeRecord) => string | null {
  if (spec === undefined || spec === 'label') return (n) => n.label;
  const pick = spec === 'label+attrs' ? undefined : new Set(spec.attrs);
  return (n) => {
    const lines = [n.label];
    for (const [k, v] of Object.entries(n.attrs)) {
      if (pick && !pick.has(k)) continue;
      if (v === null || v === undefined) continue;
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
    return lines.join('\n');
  };
}

// ---------------------------------------------------------------------------
// Vectors as stored

/** float32 little-endian, the densest form both engines take as bytes. */
export function encodeFloat32(v: number[]): Uint8Array {
  const f = new Float32Array(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Whatever the engine handed back — bytes (SQLite BLOB, Postgres BYTEA) or
 *  pgvector's text form `[0.1,0.2,…]`. */
export function decodeVector(raw: SqlValue): number[] {
  if (raw instanceof Uint8Array) {
    const bytes = raw.byteOffset % 4 === 0 ? raw : new Uint8Array(raw); // Float32Array needs 4-byte alignment
    return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
  }
  if (typeof raw === 'string') return raw.replace(/^\[|\]$/g, '').split(',').map(Number);
  throw new Error(`agent-graph: cannot decode a stored vector of type ${typeof raw}`);
}

/** The parameter to bind for a vector on this store. */
function vectorParam(ctx: HandleContext, v: number[]): SqlParam {
  return ctx.store.driver.features.vector ? `[${v.join(',')}]` : encodeFloat32(v);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Writing vectors

function checkVectors(cfg: EmbeddingConfig, texts: string[], vectors: unknown): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`embed() returned ${Array.isArray(vectors) ? vectors.length : typeof vectors} vectors for ${texts.length} texts`);
  }
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== cfg.dims || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new Error(`embed() returned a vector that is not ${cfg.dims} finite numbers`);
    }
  }
  return vectors as number[][];
}

/**
 * Embed the given nodes (their given versions) under the configured rule, in
 * batches. A node the rule declines has its vector removed, so the vector
 * table never says more than the rule allows. Throws on a failed model call
 * after committing the batches before it — the caller decides whether that
 * is fatal (`reembed`: yes; `put`: no, log it).
 */
export async function embedNodes(ctx: HandleContext, nodes: NodeRecord[]): Promise<ReembedResult> {
  const cfg = ctx.embedding;
  if (!cfg) throw new Error('agent-graph: no embedding configured on this graph (open it with { embedding })');
  const out: ReembedResult = { embedded: 0, cleared: 0, skipped: 0 };
  const selected: Array<{ node: NodeRecord; text: string }> = [];
  for (const node of nodes) {
    const text = embeddingText(cfg, node);
    if (text === null) {
      const { changes } = await ctx.store.driver.run(SQL.deleteVector, [node.id]);
      if (changes > 0) out.cleared++;
      else out.skipped++;
    } else {
      selected.push({ node, text });
    }
  }
  for (let i = 0; i < selected.length; i += BATCH) {
    const batch = selected.slice(i, i + BATCH);
    const vectors = checkVectors(cfg, batch.map((b) => b.text), await cfg.embed(batch.map((b) => b.text)));
    await ctx.store.transaction(async () => {
      for (let j = 0; j < batch.length; j++) {
        const { node } = batch[j];
        await ctx.store.driver.run(SQL.upsertVector, [node.id, node.version, cfg.dims, vectorParam(ctx, vectors[j])]);
      }
    });
    out.embedded += batch.length;
  }
  return out;
}

/** `Graph.reembed`: the latest version of every node the options select. */
export async function reembed(ctx: HandleContext, opts: ReembedOptions = {}): Promise<ReembedResult> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (opts.kinds && opts.kinds.length) {
    where.push(`kind IN (${opts.kinds.map(() => '?').join(', ')})`);
    params.push(...opts.kinds);
  }
  if (opts.since !== undefined) {
    where.push('recorded_at >= ?');
    params.push(opts.since);
  }
  const rows = await ctx.store.driver.all(`SELECT * FROM nodes${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id`, params);
  return embedNodes(ctx, rows.map((r) => rowToNode(r as SqlRow)));
}

// ---------------------------------------------------------------------------
// Searching

/**
 * Nearest node ids to `text`, most similar first, among nodes of `kinds` (or
 * any) that exist at `asOf`. The query text goes through the same `embed`
 * as the nodes did — a different model would make the distances meaningless.
 */
export async function semanticLocate(
  ctx: HandleContext,
  text: string,
  opts: { kinds?: string[]; asOf?: number; limit: number },
): Promise<NodeId[]> {
  const cfg = ctx.embedding;
  if (!cfg) throw new Error('agent-graph: `locate`/`semantic` given but no embedding (or locator) is configured on this graph');
  const [query] = checkVectors(cfg, [text], await cfg.embed([text]));
  const kindFilter = opts.kinds && opts.kinds.length ? ` AND n.kind IN (${opts.kinds.map(() => '?').join(', ')})` : '';
  const kindParams: SqlParam[] = opts.kinds && opts.kinds.length ? [...opts.kinds] : [];
  // Over-fetch: some candidates may not exist at `asOf` and fall out below.
  const fetch = opts.asOf === undefined ? opts.limit : opts.limit * 4;

  let ranked: NodeId[];
  if (ctx.store.driver.features.vector) {
    const rows = await ctx.store.driver.all(
      `SELECT v.id FROM node_vectors v JOIN nodes n ON n.id = v.id WHERE v.dims = ?${kindFilter} ORDER BY v.embedding <=> ?::vector LIMIT ?`,
      [cfg.dims, ...kindParams, `[${query.join(',')}]`, fetch],
    );
    ranked = rows.map((r) => r.id as string);
  } else {
    const rows = await ctx.store.driver.all(
      `SELECT v.id, v.embedding FROM node_vectors v JOIN nodes n ON n.id = v.id WHERE v.dims = ?${kindFilter}`,
      [cfg.dims, ...kindParams],
    );
    ranked = rows
      .map((r) => ({ id: r.id as string, score: cosine(query, decodeVector(r.embedding)) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, fetch)
      .map((r) => r.id);
  }
  if (opts.asOf === undefined) return ranked.slice(0, opts.limit);
  const out: NodeId[] = [];
  for (const id of ranked) {
    if (await ctx.store.nodeAt(id, opts.asOf)) out.push(id);
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Vector rows of a graph, for tests and tooling: id, version, dims. */
export async function vectorIndex(ctx: HandleContext): Promise<Array<{ id: NodeId; version: number; dims: number }>> {
  const rows = await ctx.store.driver.all(`SELECT id, version, dims FROM node_vectors ORDER BY id`);
  return rows.map((r) => ({ id: r.id as string, version: num(r.version), dims: num(r.dims) }));
}

// ---------------------------------------------------------------------------
// The one built-in provider

export interface OpenAiCompatibleOptions {
  /** Server root, e.g. `https://api.openai.com`, `http://localhost:11434`
   *  (Ollama), `http://vllm:8000`. `/v1/embeddings` is appended; a base that
   *  already ends in `/v1` is accepted. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  dims: number;
  /** Test seam. Default: global fetch. */
  fetch?: typeof fetch;
}

/**
 * `embed()` against any server speaking the OpenAI embeddings shape —
 * OpenAI, Ollama, vLLM, LM Studio, text-embeddings-inference. No SDK: one
 * POST, one JSON body. Returns the vectors in input order (the API returns
 * them indexed) and refuses a response whose dimension is not `dims`, so a
 * misconfigured model cannot quietly fill the table with incomparable rows.
 */
export function openAiCompatibleEmbedder(opts: OpenAiCompatibleOptions): Pick<EmbeddingConfig, 'embed' | 'dims'> {
  const root = opts.baseUrl.replace(/\/+$/, '');
  const url = `${root}${root.endsWith('/v1') ? '' : '/v1'}/embeddings`;
  const doFetch = opts.fetch ?? fetch;
  return {
    dims: opts.dims,
    async embed(texts) {
      if (texts.length === 0) return [];
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify({ model: opts.model, input: texts }) });
      if (!res.ok) {
        // The body may echo our input; the status and model are enough to act on.
        throw new Error(`embeddings request failed: HTTP ${res.status} from ${url} (model ${opts.model})`);
      }
      const body = (await res.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
      if (!Array.isArray(body.data)) throw new Error(`embeddings response has no data array (${url})`);
      const out: number[][] = new Array(texts.length);
      body.data.forEach((d, i) => {
        const at = typeof d.index === 'number' ? d.index : i;
        out[at] = d.embedding as number[];
      });
      for (let i = 0; i < out.length; i++) {
        if (!Array.isArray(out[i])) throw new Error(`embeddings response is missing vector #${i}`);
        if (out[i].length !== opts.dims) throw new Error(`model ${opts.model} returned ${out[i].length} dimensions, configured dims is ${opts.dims}`);
      }
      return out;
    },
  };
}
