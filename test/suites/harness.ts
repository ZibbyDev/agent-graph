/**
 * The seam the core suites are written against: "give me a fresh, empty
 * graph" — over SQLite (`:memory:`, the default run) or over Postgres (one
 * throwaway schema per graph, only when TEST_PG_URL is set). The suites are
 * functions of a Harness, so the same scenarios run on both engines from one
 * source; test/postgres.test.ts is the only place that knows about the URL.
 *
 * Every graph a suite opens is tracked and closed by `cleanup()`, and on
 * Postgres its schema is dropped, so a test that forgets `close()` neither
 * leaks a connection (which would keep the process alive) nor a schema.
 */

import { randomBytes } from 'node:crypto';
import { PostgresDriver } from '../../src/drivers/postgres.js';
import { SqliteDriver } from '../../src/drivers/sqlite.js';
import type { Dialect, Driver } from '../../src/driver.js';
import { dropGraph, openGraph } from '../../src/index.js';
import { initSchema } from '../../src/schema.js';
import type { Graph, GraphOptions } from '../../src/types.js';
import type { PostgresTarget } from '../../src/drivers/postgres.js';

export interface Harness {
  readonly dialect: Dialect;
  /** A fresh, empty graph. */
  open(opts?: GraphOptions): Promise<Graph>;
  /** A fresh, initialised, empty database as a bare driver — for tests that
   *  run SQL themselves (journalToSql). */
  rawDriver(): Promise<Driver>;
  cleanup(): Promise<void>;
}

/** A clock the tests advance by hand, so every recordedAt is a known number. */
export function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms = 1000) => (t += ms), get t() { return t; } };
}

export function sqliteHarness(): Harness {
  const graphs: Graph[] = [];
  const drivers: Driver[] = [];
  return {
    dialect: 'sqlite',
    async open(opts = {}) {
      const g = await openGraph(':memory:', opts);
      graphs.push(g);
      return g;
    },
    async rawDriver() {
      const d = new SqliteDriver(':memory:');
      await initSchema(d);
      drivers.push(d);
      return d;
    },
    async cleanup() {
      for (const g of graphs.splice(0)) await g.close();
      for (const d of drivers.splice(0)) await d.close();
    },
  };
}

export function postgresHarness(connectionString: string): Harness {
  const opened: Array<{ graph?: Graph; driver?: Driver; target: PostgresTarget & { schema: string } }> = [];
  let n = 0;
  const fresh = (): PostgresTarget & { schema: string } => ({
    driver: 'postgres',
    connectionString,
    // Unique per process AND per open: two test files run in parallel against
    // the same server, and a suite opens dozens of graphs.
    schema: `agt_${process.pid}_${++n}_${randomBytes(3).toString('hex')}`,
  });
  return {
    dialect: 'postgres',
    async open(opts = {}) {
      const target = fresh();
      const graph = await openGraph(target, opts);
      opened.push({ graph, target });
      return graph;
    },
    async rawDriver() {
      const target = fresh();
      const driver = await PostgresDriver.open(target);
      await initSchema(driver);
      opened.push({ driver, target });
      return driver;
    },
    async cleanup() {
      for (const o of opened.splice(0)) {
        await o.graph?.close();
        await o.driver?.close();
        await dropGraph(o.target);
      }
    },
  };
}
