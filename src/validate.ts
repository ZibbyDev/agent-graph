/**
 * Argument validation for the CLI and MCP boundary, driven by the SAME JSON
 * Schema each tool publishes in `tools/list`. There is deliberately no second
 * table of "what recordedAt must be": the schema is the one declaration, the
 * model reads it, and this file enforces it — so the two cannot drift.
 *
 * It is a small interpreter for the subset of JSON Schema the tool schemas
 * use (type, enum, properties/required/additionalProperties, items with
 * minItems/maxItems, minimum/exclusiveMinimum, anyOf/oneOf). Keywords it does
 * not know (description, default) are ignored, as JSON Schema says they
 * should be. A violation throws `ValidationError` naming the field path
 * (`replacement.cost`, `queries[1].asOf`), never quoting the value in full —
 * the same argument may contain a credential the guards have yet to see.
 */

import { ValidationError, type JsonSchema } from './types.js';

type Type = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

function typeOf(v: unknown): Exclude<Type, 'integer'> {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'object') return t;
  return 'object';
}

function hasType(v: unknown, t: Type): boolean {
  switch (t) {
    case 'integer':
      // JSON has no NaN/Infinity, but a JS caller could pass one; an epoch
      // must be a real instant.
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    default:
      return typeOf(v) === t;
  }
}

/** A short, value-free description for the message ("string", "array", "3 items"). */
function describe(v: unknown): string {
  const t = typeOf(v);
  if (t === 'array') return `an array of ${(v as unknown[]).length}`;
  if (t === 'number') return Number.isFinite(v as number) ? 'a non-integer number' : 'a non-finite number';
  return t === 'null' ? 'null' : t === 'object' ? 'an object' : `a ${t}`;
}

class Failure extends Error {
  constructor(public readonly path: string, message: string) {
    super(message);
  }
}

function fail(path: string, message: string): never {
  throw new Failure(path, message);
}

function validateNode(schema: JsonSchema, value: unknown, path: string): void {
  const expected = schema.type as Type | Type[] | undefined;
  if (expected !== undefined) {
    const types = Array.isArray(expected) ? expected : [expected];
    if (!types.some((t) => hasType(value, t))) {
      const want = types.map((t) => (t === 'integer' ? 'an integer' : t === 'null' ? 'null' : t === 'array' || t === 'object' ? `an ${t}` : `a ${t}`)).join(' or ');
      fail(path, `must be ${want}, got ${describe(value)}`);
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value)) {
    fail(path, `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail(path, `must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(path, `must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(path, `must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, i) => validateNode(schema.items as JsonSchema, item, `${path}[${i}]`));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (obj[key] === undefined) fail(path ? `${path}.${key}` : key, 'is required');
    }
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = props[key];
      const childPath = path ? `${path}.${key}` : key;
      if (sub) validateNode(sub, v, childPath);
      else if (schema.additionalProperties === false) {
        const known = Object.keys(props);
        fail(childPath, `is not a known field${known.length ? ` (expected one of ${known.join(', ')})` : ''}`);
      }
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const errors: string[] = [];
    const ok = (schema.anyOf as JsonSchema[]).some((alt) => {
      try { validateNode(alt, value, path); return true; } catch (e) { errors.push((e as Error).message); return false; }
    });
    if (!ok) fail(path, `matches none of the allowed shapes (${errors.join('; ')})`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter((alt) => {
      try { validateNode(alt, value, path); return true; } catch { return false; }
    }).length;
    if (matches !== 1) {
      const alts = (schema.oneOf as JsonSchema[]).map((a) => (Array.isArray(a.required) ? (a.required as string[]).join('+') : '?'));
      fail(path, `must match exactly one of: ${alts.join(' | ')} (matched ${matches})`);
    }
  }
}

/**
 * Validate `args` against `schema`; throw `ValidationError` naming the tool
 * and the offending field. Pure — the graph is never touched.
 */
export function validateArgs(tool: string, schema: JsonSchema, args: Record<string, unknown>): void {
  try {
    validateNode(schema, args, '');
  } catch (e) {
    if (e instanceof Failure) {
      throw new ValidationError(`${tool}: ${e.path ? `${e.path} ` : 'arguments '}${e.message}`);
    }
    throw e;
  }
}
