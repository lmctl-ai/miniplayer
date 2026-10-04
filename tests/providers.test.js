import assert from 'node:assert/strict';
import test from 'node:test';

import { createModel, generateOneShot, resolveProviderRoute } from '../src/providers.js';

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

test('ollama passthrough uses the injected host without requiring a credential', () => {
  const record = {
    record_id: 'direct:ollama/qwen2.5:14b',
    source: 'litellm',
    provider: 'ollama',
    vendor_model_id: 'qwen2.5:14b',
  };
  const route = resolveProviderRoute(record, {}, { OLLAMA_HOST: 'http://172.18.32.1:11434/' });
  assert.equal(route.kind, 'openai-compatible');
  assert.equal(route.baseURL, 'http://172.18.32.1:11434/v1');
  assert.equal(route.modelId, 'qwen2.5:14b');
  assert.equal(route.apiKey, 'ollama');
  const model = createModel(record, {}, {});
  assert.equal(model.provider, 'ollama.chat');
  assert.equal(model.modelId, 'qwen2.5:14b');
});

test('ollama defaults to localhost and honors a configured baseURL override', () => {
  const record = {
    record_id: 'litellm:ollama/codegeex4',
    source: 'litellm',
    provider: 'ollama',
    vendor_model_id: 'ollama/codegeex4',
  };
  assert.equal(resolveProviderRoute(record, {}, {}).baseURL, 'http://localhost:11434/v1');
  const configured = resolveProviderRoute(record, {
    provider: { ollama: { baseURL: 'http://ollama.internal:9999/custom/v1' } },
  }, { OLLAMA_HOST: 'http://ignored:11434' });
  assert.equal(configured.baseURL, 'http://ollama.internal:9999/custom/v1');
  assert.equal(configured.modelId, 'codegeex4');
});

test('one-shot generation passes a finite AbortSignal to the AI SDK call', async () => {
  const result = await generateOneShot({
    record: {
      record_id: 'direct:ollama/qwen2.5:14b',
      source: 'litellm',
      provider: 'ollama',
      vendor_model_id: 'qwen2.5:14b',
    },
    config: {},
    prompt: 'hello',
    env: { MINIPLAYER_REQUEST_TIMEOUT_MS: '25' },
    generateText: async ({ abortSignal }) => {
      assert.ok(abortSignal instanceof AbortSignal);
      assert.equal(abortSignal.aborted, false);
      await new Promise((resolve) => setTimeout(resolve, 35));
      assert.equal(abortSignal.aborted, true);
      assert.equal(abortSignal.reason.name, 'TimeoutError');
      return { text: 'ok' };
    },
  });
  assert.equal(result, 'ok');
});

test('one-shot metadata preserves provider usage convention and Anthropic cache writes', async () => {
  let metadata;
  await generateOneShot({
    record: {
      record_id: 'litellm:anthropic/model', source: 'litellm', provider: 'anthropic',
      vendor_model_id: 'model',
    },
    config: {}, env: { ANTHROPIC_API_KEY: 'test-key', MINIPLAYER_REQUEST_TIMEOUT_MS: '1000' },
    prompt: 'hello',
    generateText: async () => ({
      text: 'ok', response: { id: 'anthropic-response' },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 7 } },
    }),
    onResult: value => { metadata = value; },
  });
  assert.equal(metadata.usageConvention, 'input-excludes-cache');
  assert.equal(metadata.cacheWriteInputTokens, 7);
});

test('OpenRouter Anthropic rows use the compatible input convention', async () => {
  let metadata;
  await generateOneShot({
    record: {
      record_id: 'openrouter:anthropic/claude', source: 'openrouter', provider: 'anthropic',
      gateway_id: 'anthropic/claude', vendor_model_id: 'claude',
    },
    config: {}, env: { OPENROUTER_API_KEY: 'test-key', MINIPLAYER_REQUEST_TIMEOUT_MS: '1000' },
    prompt: 'hello', generateText: async () => ({ text: 'ok', usage: { inputTokens: 2 } }),
    onResult: value => { metadata = value; },
  });
  assert.equal(metadata.usageConvention, 'input-includes-cache');
});
