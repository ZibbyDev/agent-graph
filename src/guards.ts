import { GuardError, type GuardReport } from './types.js';

/**
 * Content guards run on every write, over the label (or rel) and the JSON of
 * the attrs. They exist because a memory graph is read back into a model's
 * context: a credential stored here leaks to every future reader, and a label
 * phrased as an instruction can steer a reader that trusts its own memory.
 *
 * Two different responses on purpose. Credentials are REJECTED — there is no
 * legitimate reason for one to be in a memory graph, and redacting silently
 * would hide the bug in the writer. Instruction-shaped text is ACCEPTED but
 * FLAGGED, because a ticket title may legitimately read "you must rotate the
 * key" and dropping it would lose real information; the flag lets a reader
 * decide how much to trust it.
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
 *  pre-flight content without touching the database. */
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

/**
 * Guard a write. Returns the flags to store on the record, or throws
 * `GuardError` before anything is written. `what` names the record for the
 * error message ("node ticket:1", "edge run→file").
 */
export function guardWrite(what: string, text: string, attrs: Record<string, unknown>): string[] {
  const report = checkContent(`${text}\n${JSON.stringify(attrs)}`);
  if (report.rejected) {
    throw new GuardError(`${what} rejected: ${report.reason}`, report);
  }
  return report.flags;
}
