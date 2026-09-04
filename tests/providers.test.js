import assert from 'node:assert/strict';
import test from 'node:test';

import { createModel } from '../src/providers.js';

test('rejects unmapped litellm providers cleanly', () => {
  assert.throws(
    () => createModel({
      record_id: 'litellm:unknown',
      source: 'litellm',
      provider: 'unknown',
      vendor_model_id: 'model',
    }, {}, {}),
    /Unsupported litellm provider "unknown"/,
  );
});

test('requires an OpenRouter API key before creating a model', () => {
  assert.throws(
    () => createModel({
      record_id: 'openrouter:vendor/model',
      source: 'openrouter',
      provider: 'vendor',
      gateway_id: 'vendor/model',
    }, {}, {}),
    /Missing API key.*OPENROUTER_API_KEY/,
  );
});

test('environment credentials take precedence over config credentials', () => {
  const model = createModel({
    record_id: 'litellm:test',
    source: 'litellm',
    provider: 'openai',
    vendor_model_id: 'gpt-4o-mini',
  }, { provider: { openai: { apiKey: 'config-key' } } }, { OPENAI_API_KEY: 'env-key' });
  assert.ok(model);
});
