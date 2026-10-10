import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { listChatModels, loadCatalog } from '../src/catalog.js';
import { resolveCallableModel } from '../src/selector.js';

const fixturePath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));

test('loads the versioned catalog fixture without the production catalog', async () => {
  const records = await loadCatalog(fixturePath);
  assert.equal(records.length, 5);
});

test('filters chat models by source, provider, and maximum input price', async () => {
  const records = await loadCatalog(fixturePath);
  assert.deepEqual(
    listChatModels(records, { source: 'openrouter' }).map((record) => record.record_id),
    ['openrouter:vendor/fast'],
  );
  assert.deepEqual(
    listChatModels(records, { provider: 'anthropic', maxInputPrice: 1 }).map((record) => record.record_id),
    ['litellm:shared-a'],
  );
  assert.deepEqual(
    listChatModels(records, { maxInputPrice: 0.1 }),
    [],
  );
});

test('resolves exactly one model across supported selector fields', async () => {
  const records = await loadCatalog(fixturePath);
  assert.equal(resolveCallableModel(records, 'unique').record.record_id, 'litellm:unique-model');
});

test('rejects selectors with zero matches', async () => {
  const records = await loadCatalog(fixturePath);
  assert.throws(() => resolveCallableModel(records, 'missing'), /No model matches selector/);
});

test('rejects selectors with more than one matching record', async () => {
  const records = await loadCatalog(fixturePath);
  assert.throws(() => resolveCallableModel(records, 'shared'), /ambiguous \(2 matches/);
});

test('resolves aliases before exact catalog lookup', async () => {
  const records = await loadCatalog(fixturePath);
  const result = resolveCallableModel(records, 'cheap', { cheap: 'vendor/fast' });
  assert.equal(result.selector, 'vendor/fast');
  assert.equal(result.record.record_id, 'openrouter:vendor/fast');
});

test('a missing catalog error says how to supply one', async () => {
  await assert.rejects(
    () => loadCatalog('/nonexistent/model_list.json'),
    (error) => /Unable to read model catalog/.test(error.message) && /MINIPLAYER_LMPRICE_CATALOG/.test(error.message),
  );
});
