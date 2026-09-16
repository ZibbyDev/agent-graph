/**
 * agent-graph — public entry point.
 *
 * `openGraph` is the only way in; everything else here is the type surface
 * the CLI, the MCP server and callers program against, plus the two error
 * classes (so `instanceof` works across the package boundary) and the guard
 * check (so a front end can pre-flight content before it reaches a write).
 */
export { openGraph } from './graph.js';
export { checkContent } from './guards.js';
export { GuardError, PermissionError } from './types.js';
export type {
  EdgeId,
  EdgeInput,
  EdgeRecord,
  EdgeTrace,
  Graph,
  GraphOptions,
  GraphStats,
  GuardReport,
  Locator,
  MatchQuery,
  NodeId,
  NodeInput,
  NodeRecord,
  Provenance,
  RecallHit,
  RecallManyResult,
  RecallQuery,
  RecallResult,
  Subgraph,
  TimeFilter,
  Trace,
} from './types.js';
