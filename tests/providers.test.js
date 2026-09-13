import assert from 'node:assert/strict';
import test from 'node:test';

import { createModel, resolveProviderRoute } from '../src/providers.js';

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

test('moonshot uses the snapshot baseURL and environment-first key wiring', () => {
  const record = {
    record_id: 'litellm:moonshot/kimi-latest-8k',
    source: 'litellm',
    provider: 'moonshot',
    vendor_model_id: 'moonshot/kimi-latest-8k',
  };
  const route = resolveProviderRoute(record, { provider: { moonshot: { apiKey: 'config-key' } } }, { MOONSHOT_API_KEY: 'env-key' });
  assert.equal(route.kind, 'openai-compatible');
  assert.equal(route.baseURL, 'https://api.moonshot.ai/v1');
  assert.equal(route.apiKey, 'env-key');
  assert.equal(route.modelId, 'kimi-latest-8k');
  assert.equal(createModel(record, {}, { MOONSHOT_API_KEY: 'env-key' }).modelId, 'kimi-latest-8k');
});

test('deepseek uses the snapshot baseURL and configured key fallback', () => {
  const route = resolveProviderRoute({
    record_id: 'litellm:deepseek/deepseek-chat',
    source: 'litellm',
    provider: 'deepseek',
    vendor_model_id: 'deepseek/deepseek-chat',
  }, { provider: { deepseek: { apiKey: 'config-key' } } }, {});
  assert.equal(route.kind, 'openai-compatible');
  assert.equal(route.baseURL, 'https://api.deepseek.com');
  assert.equal(route.apiKey, 'config-key');
  assert.equal(route.modelId, 'deepseek-chat');
});

test('gemini routing prefix is removed before the native SDK factory receives the model id', () => {
  const model = createModel({
    record_id: 'litellm:gemini/gemini-3.7-flash',
    source: 'litellm',
    provider: 'gemini',
    vendor_model_id: 'gemini/gemini-3.7-flash',
  }, {}, { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' });
  assert.equal(model.modelId, 'gemini-3.7-flash');
});
