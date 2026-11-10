'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fetchFalImageCatalog, verifyFalCatalogKey } = require('../src/fal_images.js');

const textId = 'fal-ai/fixture/text';
const unpricedId = 'fal-ai/fixture/unpriced';
const entry = endpoint_id => ({
  endpoint_id, metadata: { display_name: endpoint_id, status: 'active' },
  openapi: { paths: { '/': { post: { requestBody: { content: { 'application/json': { schema: {
    properties: { prompt: { type: 'string' }, aspect_ratio: { enum: ['1:1'] } },
    required: ['prompt'],
  } } } } } } } },
});

test('fal import follows cursors and reports incomplete endpoint data without publishing it', async () => {
  const calls = [];
  const models = await fetchFalImageCatalog({ apiKey: 'fixture', fetchImpl: async (url, options) => {
    const { pathname, searchParams: query } = new URL(url);
    calls.push(query);
    if (pathname.endsWith('/pricing')) {
      assert.equal(options.headers.authorization, 'Key fixture');
      return Response.json({ prices: [{ endpoint_id: textId, unit_price: 0.1, unit: 'image', currency: 'USD' }] });
    }
    if (query.has('expand')) return Response.json({ models: [entry(textId), entry(unpricedId)] });
    if (query.get('category') === 'image-to-image') return Response.json({ models: [], has_more: false });
    if (query.get('cursor') === 'page2') return Response.json({ models: [entry(unpricedId)], has_more: false });
    return Response.json({ models: [entry(textId)], has_more: true, next_cursor: 'page2' });
  } });
  assert.deepEqual(models.map(model => model.providerModelId), [textId]);
  assert.equal(models.diagnostics.listed, 2);
  assert.equal(models.diagnostics.partial, true);
  assert.equal(models.diagnostics.unresolved, 1);
  assert.ok(calls.some(query => query.get('cursor') === 'page2'));
});

test('fal connection checks a real authenticated pricing response without submitting a generation', async () => {
  const request = async (url, options) => {
    assert.equal(new URL(url).pathname, '/v1/models/pricing');
    assert.equal(options.headers.authorization, 'Key fixture');
    assert.equal(options.method, undefined);
    return Response.json({ prices: [] });
  };
  await assert.rejects(verifyFalCatalogKey('fixture', request), /did not return a pricing record/);
});
