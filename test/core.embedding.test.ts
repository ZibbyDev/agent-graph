/** The embedding suite over SQLite (float32 BLOBs, cosine in JS), plus the
 *  pieces that need no database: the text rules and the HTTP provider. */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { openAiCompatibleEmbedder, textRuleFrom } from '../src/index.js';
import { cosine, decodeVector, encodeFloat32 } from '../src/embedding.js';
import { embeddingSuite } from './suites/embedding.suite.js';
import { sqliteHarness } from './suites/harness.js';

const h = sqliteHarness();
embeddingSuite(h);
after(() => h.cleanup());

const node = { id: 'n', kind: 'note', label: 'Rounding', attrs: { text: 'half-up', tags: ['a'], skip: null }, origin: 'o', provenance: 'claimed' as const, version: 1, recordedAt: 0, createdBy: 'o', createdAt: 0, flags: [] };

describe('text rules', () => {
  test("'label' | 'label+attrs' | { attrs }", () => {
    assert.equal(textRuleFrom(undefined)(node), 'Rounding');
    assert.equal(textRuleFrom('label')(node), 'Rounding');
    assert.equal(textRuleFrom('label+attrs')(node), 'Rounding\ntext: half-up\ntags: ["a"]', 'strings verbatim, other values as JSON, nulls dropped');
    assert.equal(textRuleFrom({ attrs: ['text', 'missing'] })(node), 'Rounding\ntext: half-up');
  });

  test('float32 round trip and cosine', () => {
    const v = [0.5, -1, 2, 0.25];
    assert.deepEqual(decodeVector(encodeFloat32(v)), v);
    assert.deepEqual(decodeVector('[0.5,-1,2,0.25]'), v, "pgvector's text form decodes too");
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 1]), 0, 'a zero vector is nowhere');
  });
});

describe('openAiCompatibleEmbedder', () => {
  test('posts to /v1/embeddings, sends the key, returns vectors in input order, refuses wrong dims', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init!.body)) as { model: string; input: string[] };
      // Out of order on purpose: the client must use `index`.
      const data = body.input.map((t, i) => ({ index: i, embedding: [t.length, 1] })).reverse();
      return new Response(JSON.stringify({ data, model: body.model }), { status: 200 });
    }) as typeof fetch;
    const e = openAiCompatibleEmbedder({ baseUrl: 'http://model:11434/', apiKey: 'k', model: 'm', dims: 2, fetch: fetchStub });
    assert.deepEqual(await e.embed(['ab', 'abcd']), [[2, 1], [4, 1]]);
    assert.equal(seen[0].url, 'http://model:11434/v1/embeddings');
    assert.equal((seen[0].init.headers as Record<string, string>).authorization, 'Bearer k');
    assert.deepEqual(await e.embed([]), [], 'no request for no texts');
    assert.equal(seen.length, 1);
    const v1 = openAiCompatibleEmbedder({ baseUrl: 'https://api.openai.com/v1', model: 'm', dims: 2, fetch: fetchStub });
    await v1.embed(['x']);
    assert.equal(seen[1].url, 'https://api.openai.com/v1/embeddings', 'a base that already ends in /v1 is not doubled');
    assert.equal((seen[1].init.headers as Record<string, string>).authorization, undefined, 'no key, no header');

    const wrong = openAiCompatibleEmbedder({ baseUrl: 'http://m', model: 'm', dims: 3, fetch: fetchStub });
    await assert.rejects(wrong.embed(['x']), /returned 2 dimensions, configured dims is 3/);
    const down = openAiCompatibleEmbedder({ baseUrl: 'http://m', model: 'm', dims: 2, fetch: (async () => new Response('nope', { status: 503 })) as typeof fetch });
    await assert.rejects(down.embed(['x']), /HTTP 503/);
  });
});
