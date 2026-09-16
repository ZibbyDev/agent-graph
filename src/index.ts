/**
 * agent-graph — public entry point.
 *
 * `openGraph` is the only way in; everything else here is the type surface
 * the CLI, the MCP server and callers program against, plus the error
 * classes (so `instanceof` works across the package boundary), the guard
 * check (so a front end can pre-flight content before it reaches a write),
 * and `journalToSql` (so a host can apply the journal to its own SQL store).
 */
export { openGraph } from './graph.js';
export { checkContent } from './guards.js';
export { journalToSql } from './sql.js';
export { GuardError, PermissionError, ValidationError } from './types.js';
export type {
  EdgeId,
  EdgeInput,
  EdgeRecord,
  EdgeTrace,
  Graph,
  GraphDump,
  GraphOptions,
  GraphStats,
  GuardReport,
  JournalOp,
  Locator,
  MatchQuery,
  NodeId,
  NodeInput,
  NodeRecord,
  Provenance,
  RecallHit,
  RecallManyHit,
  RecallManyResult,
  RecallQuery,
  RecallResult,
  Row,
  SqlStatement,
  Subgraph,
  TimeFilter,
  Trace,
} from './types.js';
