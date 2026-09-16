/**
 * The Postgres driver. Optional: `pg` is a peer dependency loaded lazily, so
 * a SQLite-only install keeps zero runtime dependencies and never touches it.
 *
 * One Postgres SCHEMA per graph is the tenancy unit: `openGraph({ driver:
 * 'postgres', connectionString, schema })` creates the schema if needed and
 * puts it first on `search_path`, so the unqualified table names the store
 * uses resolve there. One `pg.Client` (not a pool) per graph: the store
 * serialises its statements anyway, and a pool would make `SET search_path`
 * per-connection state that a transaction could lose.
 *
 * pgvector is used when present: `CREATE EXTENSION IF NOT EXISTS vector` is
 * attempted (it needs privileges the role may not have — failure is fine),
 * then the `vector` type is looked up wherever it lives and that schema is
 * added to `search_path`. Without it, embeddings are BYTEA and cosine runs in
 * JS (embedding.ts) — same behaviour, slower at scale.
 */

import { Serializer, quoteIdent, type Driver, type DriverFeatures, type SqlParam, type SqlRow, type SqlValue } from '../driver.js';
import { renderSql } from '../schema.js';

export interface PostgresTarget {
  driver: 'postgres';
  connectionString: string;
  /** Schema to hold this graph. Created if missing. Required for `destroy()`. */
  schema?: string;
}

/** The slice of `pg.Client` this driver uses; typed here so the public .d.ts
 *  never references the optional package. */
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null; fields: Array<{ name: string; dataTypeID: number }> }>;
}

const INT8_OID = 20;
const NUMERIC_OID = 1700;

async function loadPg(): Promise<{ Client: new (config: { connectionString: string }) => PgClient }> {
  try {
    const mod = (await import('pg')) as unknown as { default?: { Client: unknown }; Client?: unknown };
    const Client = (mod.default ?? mod).Client as new (config: { connectionString: string }) => PgClient;
    if (typeof Client !== 'function') throw new Error('module "pg" has no Client export');
    return { Client };
  } catch (err) {
    throw new Error(`agent-graph: the postgres driver needs the optional "pg" package (npm install pg): ${(err as Error).message}`);
  }
}

export class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;
  readonly features: DriverFeatures = { vector: false };
  private readonly gate = new Serializer();
  private closed = false;

  private constructor(private readonly client: PgClient, readonly schema: string | undefined) {}

  static async open(target: PostgresTarget): Promise<PostgresDriver> {
    const { Client } = await loadPg();
    const client = new Client({ connectionString: target.connectionString });
    await client.connect();
    const driver = new PostgresDriver(client, target.schema);
    try {
      await driver.prepareSearchPath();
    } catch (err) {
      await client.end().catch(() => {});
      throw err;
    }
    return driver;
  }

  private async prepareSearchPath(): Promise<void> {
    if (this.schema !== undefined) {
      if (Buffer.byteLength(this.schema) > 63) throw new Error(`agent-graph: postgres schema name exceeds 63 bytes: ${this.schema.slice(0, 20)}…`);
      await this.client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(this.schema)}`);
    }
    // Best effort: the extension may be absent from the server, or the role
    // may lack CREATE. Either way the type lookup below decides.
    try {
      await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      // Postgres aborts nothing here — we are not in a transaction.
    }
    const found = await this.client.query(
      `SELECT n.nspname AS schema FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'vector' LIMIT 1`,
    );
    const vectorSchema = found.rows[0]?.schema as string | undefined;
    this.features.vector = vectorSchema !== undefined;
    const path = [...new Set([this.schema, vectorSchema, 'public'].filter((s): s is string => s !== undefined))];
    await this.client.query(`SET search_path TO ${path.map(quoteIdent).join(', ')}`);
  }

  private render(sql: string): string {
    return renderSql(sql, 'postgres', this.features);
  }

  private static bind(params: SqlParam[]): unknown[] {
    return params.map((p) => (p instanceof Uint8Array && !Buffer.isBuffer(p) ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p));
  }

  async exec(sql: string): Promise<void> {
    await this.gate.exclusive(() => this.client.query(this.render(sql)));
  }

  all(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
    return this.gate.exclusive(async () => {
      const res = await this.client.query(this.render(sql), PostgresDriver.bind(params));
      // int8 and numeric come back as text (pg refuses to lose precision); a
      // millisecond epoch or a COUNT(*) fits a JS number, and the store
      // expects one. Done per column type, never by guessing at strings.
      const numeric = res.fields.filter((f) => f.dataTypeID === INT8_OID || f.dataTypeID === NUMERIC_OID).map((f) => f.name);
      if (numeric.length === 0) return res.rows as SqlRow[];
      return res.rows.map((r) => {
        const out: Record<string, unknown> = { ...r };
        for (const c of numeric) if (typeof out[c] === 'string') out[c] = Number(out[c]);
        return out as Record<string, SqlValue>;
      });
    });
  }

  run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    return this.gate.exclusive(async () => {
      const res = await this.client.query(this.render(sql), PostgresDriver.bind(params));
      return { changes: res.rowCount ?? 0 };
    });
  }

  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.gate.transaction(
      fn,
      async () => { await this.client.query('BEGIN'); },
      async () => { await this.client.query('COMMIT'); },
      async () => { await this.client.query('ROLLBACK'); },
    );
  }

  columns(table: string): Promise<string[]> {
    return this.gate.exclusive(async () => {
      const res = await this.client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      );
      return res.rows.map((r) => r.column_name as string);
    });
  }

  storageBytes(): Promise<number> {
    return this.gate.exclusive(async () => {
      const res = await this.client.query(
        `SELECT COALESCE(SUM(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0) AS n FROM pg_tables WHERE schemaname = current_schema()`,
      );
      return Number(res.rows[0]?.n ?? 0);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.end();
  }

  /** Drop the graph's schema with everything in it. Refused without a schema:
   *  there is no "the graph's tables" to delete in a shared namespace. */
  async destroy(): Promise<void> {
    if (this.schema === undefined) throw new Error('agent-graph: destroy() needs a postgres target with a schema');
    await this.gate.exclusive(() => this.client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(this.schema!)} CASCADE`));
    await this.close();
  }
}
