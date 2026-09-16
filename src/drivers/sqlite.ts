/**
 * The default driver: `node:sqlite`, one file per graph, no dependencies.
 *
 * The engine is synchronous; the Promises come from the `Serializer` (see
 * driver.ts) — the price of letting an awaited write share a connection with
 * a concurrent one is that both must queue.
 */

import { rmSync, statSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { Serializer, type Driver, type DriverFeatures, type SqlParam, type SqlRow } from '../driver.js';
import { isMemoryPath, renderSql } from '../schema.js';

export class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;
  readonly features: DriverFeatures = { vector: false };
  private readonly db: DatabaseSync;
  private readonly gate = new Serializer();
  /** Prepared once per distinct SQL string; the write path hands over
   *  statements (see sql.ts) rather than calling named ones. */
  private readonly prepared = new Map<string, StatementSync>();
  private closed = false;

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    // WAL lets a reader (another agent's handle, a CLI `stats`) proceed while
    // a writer is mid-transaction. It is meaningless for an in-memory database.
    if (!isMemoryPath(path)) this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
  }

  private statement(sql: string): StatementSync {
    let p = this.prepared.get(sql);
    if (!p) {
      p = this.db.prepare(renderSql(sql, 'sqlite'));
      this.prepared.set(sql, p);
    }
    return p;
  }

  exec(sql: string): Promise<void> {
    return this.gate.exclusive(() => this.db.exec(renderSql(sql, 'sqlite')));
  }

  all(sql: string, params: SqlParam[] = []): Promise<SqlRow[]> {
    return this.gate.exclusive(() => this.statement(sql).all(...params) as SqlRow[]);
  }

  run(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    return this.gate.exclusive(() => ({ changes: Number(this.statement(sql).run(...params).changes) }));
  }

  transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.gate.transaction(
      fn,
      () => this.db.exec('BEGIN'),
      () => this.db.exec('COMMIT'),
      () => this.db.exec('ROLLBACK'),
    );
  }

  columns(table: string): Promise<string[]> {
    return this.gate.exclusive(() => (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  }

  storageBytes(): number {
    if (isMemoryPath(this.path)) return 0;
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Remove the database file and its WAL companions. */
  destroy(): void {
    this.close();
    if (isMemoryPath(this.path)) return;
    for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(this.path + suffix, { force: true });
  }
}
