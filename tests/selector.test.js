import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadCatalog } from '../src/catalog.js';
import { createModel, resolveProviderRoute } from '../src/providers.js';
import { resolveCallableModel } from '../src/selector.js';

const fixturePath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));

test('deepseek passthrough resolves to the compatible provider and direct model id', async () => {
  const records = await loadCatalog(fixturePath);
  const result = resolveCallableModel(records, 'deepseek/deepseek-flash');
  assert.equal(result.passthrough, true);
  assert.equal(result.record.provider, 'deepseek');
  assert.equal(result.record.vendor_model_id, 'deepseek-flash');

  const route = resolveProviderRoute(result.record, {}, { DEEPSEEK_API_KEY: 'metered-key' });
  assert.equal(route.kind, 'openai-compatible');
  assert.equal(route.baseURL, 'https://api.deepseek.com');
  assert.equal(route.apiKey, 'metered-key');
  assert.equal(route.modelId, 'deepseek-flash');

  const model = createModel(result.record, {}, { DEEPSEEK_API_KEY: 'metered-key' });
  assert.equal(model.provider, 'deepseek.chat');
  assert.equal(model.modelId, 'deepseek-flash');
});

test('aliases resolve before direct provider passthrough', async () => {
  const records = await loadCatalog(fixturePath);
  const result = resolveCallableModel(records, 'fast-default', {
    'fast-default': 'deepseek/deepseek-flash',
  });
  assert.equal(result.selector, 'deepseek/deepseek-flash');
  assert.equal(result.record.vendor_model_id, 'deepseek-flash');
});

test('ollama passthrough accepts colon-bearing local model ids', async () => {
  const records = await loadCatalog(fixturePath);
  const result = resolveCallableModel(records, 'ollama/qwen2.5:14b');
  assert.equal(result.passthrough, true);
  assert.equal(result.record.provider, 'ollama');
  assert.equal(result.record.vendor_model_id, 'qwen2.5:14b');
});

test('unrouted provider prefixes and unknown bare ids retain catalog errors', async () => {
  const records = await loadCatalog(fixturePath);
  assert.throws(
    () => resolveCallableModel(records, 'unknown-provider/model'),
    /No model matches selector "unknown-provider\/model"/,
  );
  assert.throws(
    () => resolveCallableModel(records, 'unknown-model'),
    /No model matches selector "unknown-model"/,
  );
});

for (const selector of [
  'deepseek/',
  'deepseek//x',
  'DeepSeek/x',
  'deepseek/../../etc',
  'deepseek/ ',
]) {
  test(`rejects unsafe passthrough selector ${JSON.stringify(selector)}`, async () => {
    const records = await loadCatalog(fixturePath);
    assert.throws(
      () => resolveCallableModel(records, selector),
      /No model matches selector/,
    );
  });
}
