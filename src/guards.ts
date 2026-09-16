import { GuardError, type GuardReport } from './types.js';

/**
 * Content guards run on every write, over EVERY string that will be
 * persisted: id, kind, label, origin and the attrs JSON of a node; id, src,
 * dst, rel, scope, origin and the attrs JSON of an edge. They exist because a
 * memory graph is read back into a model's context: a credential stored here
 * leaks to every future reader, and a label phrased as an instruction can
 * steer a reader that trusts its own memory. An id or a scope is as much a
 * string a model will read as a label is, so none of them is exempt.
 *
 * Two different responses on purpose. Credentials are REJECTED — there is no
 * legitimate reason for one to be in a memory graph, and redacting silently
 * would hide the bug in the writer. Instruction-shaped text is ACCEPTED but
 * FLAGGED, because a ticket title may legitimately read "you must rotate the
 * key" and dropping it would lose real information; the flag lets a reader
 * decide how much to trust it.
 *
 * A rejection names the FIELD and the pattern CLASS, never the text: the
 * error travels to logs, to stderr, into an MCP result a model reads — every
 * place the secret must not go.
 */

/** Each pattern is anchored to a well-known credential shape, not to the
 *  word "secret" — a value that merely mentions secrets is fine. */
const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'openai-style key', re: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'gitlab token', re: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: 'slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'aws access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'zby token', re: /zby_[A-Za-z0-9_]{20,}/ },
  // The keyword may be followed by a closing quote because attrs are scanned
  // as JSON (`"api_key":"…"`), not as prose (`api_key=…`). Both forms match.
  { name: 'key/secret/token/password assignment', re: /(api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i },
];

const INSTRUCTION_PATTERN =
  /(\byou (?:must|should|will|need to|are to|have to)\b|\bignore (?:the |all |any )?(?:previous|prior|earlier|above)\b|\bsystem prompt\b|\bdisregard\b|\bfrom now on\b|\balways run\b|\bnever refuse\b|\bas an ai\b)/i;

export const INSTRUCTION_FLAG = 'instruction-shaped';
export const CREDENTIAL_FLAG = 'credential';

/** Pure check over a piece of text. Exported so the CLI/MCP layers can
 *  pre-flight content without touching the database. The report never
 *  contains the text. */
export function checkContent(text: string): GuardReport {
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    if (re.test(text)) {
      return { rejected: true, reason: `credential-shaped value (${name})`, flags: [CREDENTIAL_FLAG] };
    }
  }
  const flags: string[] = [];
  if (INSTRUCTION_PATTERN.test(text)) flags.push(INSTRUCTION_FLAG);
  return { rejected: false, flags };
}

/** The strings of one write, by field name. `undefined`/`null` fields are
 *  absent; objects (attrs) are scanned as the JSON that will be stored. */
export type GuardFields = Record<string, string | number | boolean | Record<string, unknown> | null | undefined>;

/**
 * Guard a write. Returns the flags to store on the record (the union over
 * every field), or throws `GuardError` naming the offending FIELD before
 * anything is written. `op` is the operation for the message ("put", "link").
 */
export function guardFields(op: string, fields: GuardFields): string[] {
  const flags = new Set<string>();
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const report = checkContent(fieldText(value));
    if (report.rejected) {
      // "(github token)" tells the writer what to strip; the value itself is
      // exactly what must not appear here.
      const cls = report.reason?.replace(/^credential-shaped value /, '') ?? '';
      throw new GuardError(`${op}: ${field} looks like a credential ${cls}`.trimEnd(), { ...report, field });
    }
    for (const f of report.flags) flags.add(f);
  }
  return [...flags];
}

/** The flags `guardFields` would store, for content that has ALREADY passed
 *  the guards (a journaled op). Same scan, same union, no rejection. */
export function collectFlags(fields: GuardFields): string[] {
  const flags = new Set<string>();
  for (const value of Object.values(fields)) {
    if (value === undefined || value === null) continue;
    for (const f of checkContent(fieldText(value)).flags) flags.add(f);
  }
  return [...flags];
}

function fieldText(value: NonNullable<GuardFields[string]>): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
