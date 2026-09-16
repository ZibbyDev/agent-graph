import { randomBytes } from 'node:crypto';

/**
 * Edge ids are time-sortable: a base-36 millisecond epoch, then a random tail.
 *
 * Sorting by id therefore approximates sorting by `recordedAt`, which is what
 * a human scanning a trace wants, and the random tail keeps two assertions
 * recorded in the same millisecond distinct. The epoch is zero-padded to nine
 * base-36 digits so lexical order stays chronological past the eight-digit
 * rollover (year 2059) rather than silently breaking then.
 */
export function newEdgeId(recordedAt: number): string {
  const t = Math.max(0, Math.floor(recordedAt)).toString(36).padStart(9, '0');
  return `${t}-${randomBytes(4).toString('hex')}`;
}
