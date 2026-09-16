/**
 * The storage seam.
 *
 * `Store` (graph.ts) speaks ONE dialect of SQL — the SQLite flavour written
 * in schema.ts and traverse.ts — and hands every statement to a `Driver`.
 * The driver owns the connection, renders the statement for its engine
 * (`renderSql` in schema.ts: `?` → `$n`, `INSERT OR IGNORE` → `ON CONFLICT
 * DO NOTHING`, epoch columns to BIGINT, …) and runs it. Two drivers ship:
 * `node:sqlite` (the default, zero dependencies, one file per graph) and
 * Postgres (the optional `pg` package, one schema per graph).
 *
 * Every method may return a Promise, because Postgres is asynchronous and the
 * public API must not change shape with the driver. The SQLite driver returns
 * Promises too, for one reason: SERIALISATION. Once a write is `await`ed, two
 * concurrent callers (two HTTP requests on the same graph) can interleave, and
 * a second `BEGIN` inside an open transaction is an error on SQLite and a
 * silent merge of two units of work on Postgres. `Serializer` below gives a
 * transaction exclusive use of the connection and lets the statements issued
 * FROM INSIDE it pass, recognised by their async context — so the store can
 * write `await this.driver.run(...)` inside `transaction()` without knowing
 * which side of the lock it is on.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type Dialect = 'sqlite' | 'postgres';

export type MaybePromise<T> = T | Promise<T>;

/** A bound parameter. `Uint8Array` is a vector blob (see embedding.ts). */
export type SqlParam = string | number | null | Uint8Array;

/** A raw row as the engine returns it — column name → value. Engines differ
 *  (Postgres hands back BIGINT as text, SQLite may hand back bigint); each
 *  driver normalises integers to `number` before the row leaves it. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

/** What the engine can do beyond plain SQL. Read by the store to pick a
 *  code path (e.g. pgvector's `<=>` against an in-JS cosine). */
export interface DriverFeatures {
  /** A native vector column type with a distance operator (pgvector). */
  vector: boolean;
}

export interface Driver {
  readonly dialect: Dialect;
  readonly features: DriverFeatures;
  /** Run one or more statements with no parameters and no result (DDL). */
  exec(sql: string): MaybePromise<void>;
  all(sql: string, params?: SqlParam[]): MaybePromise<SqlRow[]>;
  run(sql: string, params?: SqlParam[]): MaybePromise<{ changes: number }>;
  /** Run `fn` atomically with exclusive use of the connection. Nested calls
   *  join the outer transaction (no savepoints — every public write is one
   *  unit and the inner call only exists for code sharing). */
  transaction<T>(fn: () => MaybePromise<T>): Promise<T>;
  /** Column names of `table` in definition order — the schema tripwire. */
  columns(table: string): MaybePromise<string[]>;
  /** Bytes the graph occupies (file size; relation sizes). 0 when unknowable. */
  storageBytes(): MaybePromise<number>;
  close(): MaybePromise<void>;
  /** Delete the graph's storage — the file, or the schema. Closes first. */
  destroy(): MaybePromise<void>;
}

/**
 * One connection, one caller at a time. `exclusive(fn)` queues `fn` behind
 * whatever holds the connection; a call made from inside the holder's own
 * async context (its transaction body) passes straight through, which is how
 * the statements of a transaction reach the connection while everyone else
 * waits for its COMMIT.
 */
export class Serializer {
  private readonly context = new AsyncLocalStorage<object>();
  private tail: Promise<void> = Promise.resolve();
  private holder: object | undefined;
  private depth = 0;

  /** True when called from inside an open transaction on this connection. */
  inTransaction(): boolean {
    return this.depth > 0 && this.context.getStore() === this.holder;
  }

  async exclusive<T>(fn: () => MaybePromise<T>): Promise<T> {
    const ctx = this.context.getStore();
    if (ctx !== undefined && ctx === this.holder) return fn();
    let release!: () => void;
    const prev = this.tail;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    const token = {};
    this.holder = token;
    try {
      return await this.context.run(token, fn);
    } finally {
      this.holder = undefined;
      release();
    }
  }

  /** BEGIN / fn / COMMIT, ROLLBACK on throw; a nested call runs `fn` inside
   *  the enclosing transaction. */
  async transaction<T>(
    fn: () => MaybePromise<T>,
    begin: () => MaybePromise<void>,
    commit: () => MaybePromise<void>,
    rollback: () => MaybePromise<void>,
  ): Promise<T> {
    if (this.inTransaction()) return fn();
    return this.exclusive(async () => {
      await begin();
      this.depth++;
      try {
        const out = await fn();
        await commit();
        return out;
      } catch (err) {
        try {
          await rollback();
        } catch {
          // The original error is the one worth reporting; a failed ROLLBACK
          // on a connection that is already broken adds nothing.
        }
        throw err;
      } finally {
        this.depth--;
      }
    });
  }
}

/** Quote an identifier for Postgres (`"` doubled). Used for schema names,
 *  which come from a graph id and may hold `.`, `:` or `-`. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
