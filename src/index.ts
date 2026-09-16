/**
 * agent-graph — public entry point.
 *
 * `openGraph` is the way in (SQLite by path, Postgres by target object);
 * `dropGraph` is the way out. Everything else here is the type surface the
 * CLI, the MCP server, the HTTP server and callers program against, plus the
 * error classes (so `instanceof` works across the package boundary), the
 * guard check (so a front end can pre-flight content before it reaches a
 * write), `journalToSql` (so a host can apply the journal to its own SQL
 * store) and the one built-in embedding provider.
 */
export { dropGraph, openGraph } from './graph.js';
export { checkContent } from './guards.js';
export { journalToSql } from './sql.js';
export { openAiCompatibleEmbedder, textRuleFrom, type OpenAiCompatibleOptions, type TextRuleSpec } from './embedding.js';
export { renderSql } from './schema.js';
export type { Dialect, Driver } from './driver.js';
export { GuardError, PermissionError, ValidationError } from './types.js';
export type {
  EdgeId,
  EdgeInput,
  EdgeRecord,
  EdgeTrace,
  EmbeddingConfig,
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
  OpenTarget,
  Provenance,
  RecallHit,
  RecallManyHit,
  RecallManyResult,
  RecallQuery,
  RecallResult,
  ReembedOptions,
  ReembedResult,
  Row,
  SqlStatement,
  Subgraph,
  TimeFilter,
  Trace,
} from './types.js';
