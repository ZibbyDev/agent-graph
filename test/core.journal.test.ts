/** The journal / replay / dump / load suite over SQLite. */
import { after } from 'node:test';
import { sqliteHarness } from './suites/harness.js';
import { journalSuite } from './suites/journal.suite.js';

const h = sqliteHarness();
journalSuite(h);
after(() => h.cleanup());
