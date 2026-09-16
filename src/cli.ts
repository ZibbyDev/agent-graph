#!/usr/bin/env node
/**
 * agent-graph — command-line surface.
 *
 *   agent-graph --db <path> [--origin <o>] [--privileged] [--read-only] <command> [json]
 *
 * Commands are the tool definitions in `tools.ts` with the `graph_` prefix
 * dropped and underscores turned into hyphens (`graph_recall_many` →
 * `recall-many`). The argument is one JSON document; when it is omitted and
 * stdin is not a terminal, the JSON is read from stdin, so a shell-driven
 * agent can pipe a query in. For commands whose only required argument is an
 * id (get, trace, trace-edge), a bare id is accepted in place of JSON:
 * `agent-graph --db m.sqlite trace ticket:292`.
 *
 * Results are pretty-printed JSON on stdout. Failures are one JSON object on
 * stderr, `{ "error": { "name", "message" } }`, with exit status 1, so a
 * caller can distinguish a GuardError from a PermissionError from a typo.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openGraph } from './index.js';
import { errorToJson, graphOptionsFrom, packageVersion, parseHandleArgs, UsageError } from './surface.js';
import { hasRequiredArgs, tools, toolsFor, type ToolDefinition } from './tools.js';

/** `graph_recall_many` → `recall-many`. */
export function commandName(tool: ToolDefinition): string {
  return tool.name.replace(/^graph_/, '').replace(/_/g, '-');
}

export function usage(): string {
  const width = Math.max(...tools.map((t) => commandName(t).length));
  const lines = tools.map((t) => {
    const summary = t.description.split(/(?<=\.)\s/)[0];
    return `  ${commandName(t).padEnd(width)}  ${t.readOnly ? '' : '(write) '}${summary}`;
  });
  return [
    `agent-graph ${packageVersion()} — a time-aware memory graph for agents`,
    '',
    'Usage:',
    '  agent-graph --db <path> [--origin <o>] [--privileged] [--read-only] <command> [json]',
    '  agent-graph --help',
    '',
    'Options:',
    '  --db <path>      SQLite file (created on first write). ":memory:" for a throwaway graph.',
    '  --origin <o>     Origin stamped on every write from this invocation (a run id, an agent name).',
    '  --privileged     Allow superseding other origins\' edges and re-labelling their nodes.',
    '  --read-only      Refuse writes; only read commands are available.',
    '',
    'Commands (argument is one JSON object; read from stdin when omitted and stdin is not a terminal):',
    ...lines,
    '',
    'Examples:',
    `  agent-graph --db memory.sqlite --origin run:7f3a put '{"id":"ticket:292","kind":"ticket","label":"Remove stale note","provenance":"observed"}'`,
    `  agent-graph --db memory.sqlite recall '{"seeds":["ticket:292"],"maxCost":2,"rels":["worked_on","touched"]}'`,
    '  agent-graph --db memory.sqlite trace ticket:292',
    '  echo \'{"queries":[{"seeds":["ticket:292"]}]}\' | agent-graph --db memory.sqlite recall-many',
    '',
    'Errors are written to stderr as {"error":{"name","message"}} with exit status 1.',
  ].join('\n');
}

/** Whether the command's schema requires exactly `id` — directly, or as one
 *  of its `oneOf` alternatives (graph_get: id XOR edgeId) — so a bare token
 *  can stand in for `{"id": …}`. Derived from the schema, not a hand-kept list. */
function acceptsBareId(tool: ToolDefinition): boolean {
  const isJustId = (req: unknown) => Array.isArray(req) && req.length === 1 && req[0] === 'id';
  if (isJustId(tool.inputSchema.required)) return true;
  const oneOf = tool.inputSchema.oneOf;
  return Array.isArray(oneOf) && oneOf.some((alt) => isJustId((alt as { required?: unknown }).required));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Turn the raw argument (or stdin) into the tool's argument object.
 * Exported so the test can exercise the edge cases without spawning.
 */
export async function resolveArgs(tool: ToolDefinition, raw: string | undefined): Promise<Record<string, unknown>> {
  let text = raw;
  if (text === undefined) {
    // No argument: read stdin when it is a pipe or file (the documented way
    // to hand a query in), treat an interactive terminal or empty input as
    // `{}`. A command that needs arguments then fails with a clear message.
    text = process.stdin.isTTY ? '' : (await readStdin()).trim();
    if (text.length === 0) {
      if (hasRequiredArgs(tool)) throw new UsageError(`${commandName(tool)} needs a JSON argument (or JSON on stdin)`);
      return {};
    }
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) {
    if (acceptsBareId(tool) && !trimmed.startsWith('[') && !trimmed.startsWith('"')) return { id: trimmed };
    throw new UsageError(`${commandName(tool)} expects a JSON object, got: ${trimmed.slice(0, 40)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new UsageError(`invalid JSON argument: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UsageError(`${commandName(tool)} expects a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(usage() + '\n');
    return 1;
  }
  const args = parseHandleArgs(argv);
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  const [command, rawJson, ...extra] = args.rest;
  if (command === undefined) throw new UsageError('missing command (try --help)');
  if (extra.length > 0) throw new UsageError(`unexpected extra arguments: ${extra.join(' ')}`);
  if (!args.db) throw new UsageError('--db <path> is required');

  const available = toolsFor(args.readOnly);
  const tool = available.find((t) => commandName(t) === command);
  if (!tool) {
    const known = tools.find((t) => commandName(t) === command);
    if (known) throw new UsageError(`"${command}" is a write command; the handle is --read-only`);
    throw new UsageError(`unknown command "${command}" (try --help)`);
  }

  const toolArgs = await resolveArgs(tool, rawJson);
  const graph = openGraph(args.db, graphOptionsFrom(args));
  try {
    const result = await tool.run(graph, toolArgs);
    process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n');
    return 0;
  } finally {
    graph.close();
  }
}

// Run only when invoked as a binary (directly or through the npm bin symlink),
// so the test can import the helpers without side effects.
function invokedAsBinary(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsBinary()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(JSON.stringify({ error: errorToJson(err) }, null, 2) + '\n');
      process.exitCode = 1;
    },
  );
}
