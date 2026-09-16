/**
 * Shared plumbing for the two binaries (CLI and MCP server): the handle
 * options both accept (`--db`, `--origin`, `--privileged`, `--trusted`,
 * `--read-only`),
 * the package version, and the error → JSON shape.
 *
 * Hand-rolled: the package has no runtime dependencies.
 */

import { readFileSync } from 'node:fs';
import type { GraphOptions } from './types.js';

export interface HandleArgs {
  db?: string;
  origin?: string;
  privileged: boolean;
  /** The process is a runtime that saw things happen, so it may write
   *  `provenance: 'observed'`. Off by default: a model-driven session can
   *  only write `claimed`. */
  trusted: boolean;
  readOnly: boolean;
  help: boolean;
  /** Everything that was not a recognised handle option, in order. */
  rest: string[];
}

/**
 * Pull the handle options out of `argv`. Recognises `--flag value` and
 * `--flag=value`. Stops treating arguments as options after `--`, and leaves
 * unrecognised arguments (the command, its JSON) in `rest` for the caller.
 */
export function parseHandleArgs(argv: string[]): HandleArgs {
  const out: HandleArgs = { privileged: false, trusted: false, readOnly: false, help: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      out.rest.push(...argv.slice(i + 1));
      break;
    }
    const eq = arg.indexOf('=');
    const key = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inlineValue = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${key} requires a value`);
      return next;
    };
    switch (key) {
      case '--db':
        out.db = takeValue();
        break;
      case '--origin':
        out.origin = takeValue();
        break;
      case '--privileged':
        out.privileged = true;
        break;
      case '--trusted':
        out.trusted = true;
        break;
      case '--read-only':
      case '--readonly':
        out.readOnly = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        out.rest.push(arg);
    }
  }
  return out;
}

/** The `GraphOptions` a parsed argument set asks for. */
export function graphOptionsFrom(args: HandleArgs): GraphOptions {
  const opts: GraphOptions = {};
  if (args.origin !== undefined) opts.origin = args.origin;
  if (args.privileged) opts.privileged = true;
  if (args.trusted) opts.trusted = true;
  if (args.readOnly) opts.readOnly = true;
  return opts;
}

/** A command-line misuse (as opposed to a graph error). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Version from package.json, two directories up from the built file
 *  (dist/src/ → package root). Falls back rather than failing a binary over
 *  a cosmetic field. */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** The JSON shape every surface uses for a failure. `report` is present for
 *  guard rejections so the caller can see which pattern fired. */
export function errorToJson(err: unknown): { name: string; message: string; report?: unknown } {
  if (err instanceof Error) {
    const out: { name: string; message: string; report?: unknown } = { name: err.name || 'Error', message: err.message };
    const report = (err as { report?: unknown }).report;
    if (report !== undefined) out.report = report;
    return out;
  }
  return { name: 'Error', message: String(err) };
}
