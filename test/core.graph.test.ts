/** The graph suite over the default engine (SQLite, in memory). */
import { after } from 'node:test';
import { graphSuite } from './suites/graph.suite.js';
import { sqliteHarness } from './suites/harness.js';

const h = sqliteHarness();
graphSuite(h);
after(() => h.cleanup());
