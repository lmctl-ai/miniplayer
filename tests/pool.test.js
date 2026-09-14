import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/index.js';
import { createExecutionPlan, generateFromSelection, isFailoverError } from '../src/pool.js';

const fixturePath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));

async function fixtureRecords() {
  return loadCatalog(fixturePath);
}

function memoryIo(input = '') {
  let stdout = '';
  let stderr = '';
  return {
    stdin: Readable.from([input]),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    output: () => ({ stdout, stderr }),
  };
}

function builtInCatalogRecords() {
  return [
    {
      record_id: 'openrouter:deepseek/deepseek-v4-flash',
      source: 'openrouter',
      provider: 'deepseek',
      mode: 'chat',
      gateway_id: 'deepseek/deepseek-v4-flash',
      vendor_model_id: null,
      source_model_id: 'deepseek/deepseek-v4-flash',
      canonical_slug: 'deepseek/deepseek-v4-flash-20260423',
    },
    {
      record_id: 'litellm:deepseek-chat', source: 'litellm', provider: 'deepseek', mode: 'chat',
      gateway_id: null, vendor_model_id: 'deepseek-chat', source_model_id: 'deepseek-chat', canonical_slug: null,
    },
    {
      record_id: 'litellm:claude-haiku-4-5', source: 'litellm', provider: 'anthropic', mode: 'chat',
      gateway_id: null, vendor_model_id: 'claude-haiku-4-5', source_model_id: 'claude-haiku-4-5', canonical_slug: null,
    },
    {
      record_id: 'litellm:gemini/gemini-3.7-flash', source: 'litellm', provider: 'gemini', mode: 'chat',
      gateway_id: null, vendor_model_id: 'gemini/gemini-3.7-flash', source_model_id: 'gemini/gemini-3.7-flash', canonical_slug: null,
    },
    {
      record_id: 'litellm:gpt-5-nano', source: 'litellm', provider: 'openai', mode: 'chat',
      gateway_id: null, vendor_model_id: 'gpt-5-nano', source_model_id: 'gpt-5-nano', canonical_slug: null,
    },
    {
      record_id: 'litellm:moonshot/kimi-latest-8k', source: 'litellm', provider: 'moonshot', mode: 'chat',
      gateway_id: null, vendor_model_id: 'moonshot/kimi-latest-8k', source_model_id: 'moonshot/kimi-latest-8k', canonical_slug: null,
    },
  ];
}

test('random pool selection always picks a member of the configured pool', async () => {
  const records = await fixtureRecords();
  const config = { pool: ['vendor/fast', 'unique'] };
  for (const random of [() => 0, () => 0.999]) {
    const chosen = await generateFromSelection({
      config,
      records,
      prompt: 'hello',
      env: { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' },
      random,
      generate: async ({ record }) => record.record_id,
    });
    assert.ok(['openrouter:vendor/fast', 'litellm:unique-model'].includes(chosen));
  }
});

test('ordered pool always calls its first healthy entry', async () => {
  const records = await fixtureRecords();
  for (const random of [() => 0, () => 0.999]) {
    const calls = [];
    const result = await generateFromSelection({
      config: { pool: ['vendor/fast', 'unique'], poolOrdered: true },
      records,
      prompt: 'hello',
      env: { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' },
      random,
      generate: async ({ record }) => {
        calls.push(record.record_id);
        return 'primary-ok';
      },
    });
    assert.equal(result, 'primary-ok');
    assert.deepEqual(calls, ['openrouter:vendor/fast']);
  }
});

for (const failure of [
  Object.assign(new Error('Too many requests'), { statusCode: 429 }),
  Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
]) {
  test(`ordered pool reaches its second entry after ${failure.code ?? failure.statusCode}`, async () => {
    const records = await fixtureRecords();
    const calls = [];
    const result = await generateFromSelection({
      config: { pool: ['vendor/fast', 'unique'], poolOrdered: true },
      records,
      prompt: 'hello',
      env: { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' },
      generate: async ({ record }) => {
        calls.push(record.record_id);
        if (calls.length === 1) throw failure;
        return 'fallback-ok';
      },
    });
    assert.equal(result, 'fallback-ok');
    assert.deepEqual(calls, ['openrouter:vendor/fast', 'litellm:unique-model']);
  });
}

test('keyless pool entries are skipped before generation', async () => {
  const records = await fixtureRecords();
  const plan = createExecutionPlan({
    config: { pool: ['vendor/fast', 'unique'] },
    records,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });
  assert.deepEqual(plan.candidates.map(({ selector }) => selector), ['vendor/fast']);
  assert.deepEqual(plan.skipped.map(({ selector }) => selector), ['unique']);
});

test('ollama is planned without a host or API key', async () => {
  const records = await fixtureRecords();
  const plan = createExecutionPlan({
    config: { pool: ['ollama/qwen2.5:14b'] },
    records,
    env: {},
  });
  assert.deepEqual(plan.candidates.map(({ selector }) => selector), ['ollama/qwen2.5:14b']);
  assert.deepEqual(plan.skipped, []);
});

test('-m bypasses a configured pool entirely', async () => {
  const records = await fixtureRecords();
  const calls = [];
  const result = await generateFromSelection({
    explicitSelector: 'unique',
    config: { pool: ['missing-selector'] },
    records,
    prompt: 'hello',
    env: {},
    generate: async ({ record }) => {
      calls.push(record.record_id);
      return 'forced';
    },
  });
  assert.equal(result, 'forced');
  assert.deepEqual(calls, ['litellm:unique-model']);
});

test('HTTP 429 advances to the next randomized candidate', async () => {
  const records = await fixtureRecords();
  const calls = [];
  const result = await generateFromSelection({
    config: { pool: ['vendor/fast', 'unique'] },
    records,
    prompt: 'hello',
    env: { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' },
    random: () => 0.999,
    generate: async ({ record }) => {
      calls.push(record.record_id);
      if (calls.length === 1) throw Object.assign(new Error('Too many requests'), { statusCode: 429 });
      return 'recovered';
    },
  });
  assert.equal(result, 'recovered');
  assert.deepEqual(calls, ['openrouter:vendor/fast', 'litellm:unique-model']);
});

test('HTTP 401 fails after exactly one provider call with empty stdout', async () => {
  const records = await fixtureRecords();
  const calls = [];
  const io = memoryIo();
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({ pool: ['vendor/fast', 'unique'] }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'or-key', OPENAI_API_KEY: 'oa-key' },
    random: () => 0.999,
    generate: async ({ record }) => {
      calls.push(record.record_id);
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(calls.length, 1);
  assert.equal(io.output().stdout, '');
  assert.match(io.output().stderr, /Unauthorized/);
});

test('ECONNREFUSED advances to the next pool candidate and exits 0', async () => {
  const records = await fixtureRecords();
  const calls = [];
  const io = memoryIo();
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({ pool: ['ollama/qwen2.5:14b', 'vendor/fast'] }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'or-key' },
    random: () => 0.999,
    generate: async ({ record }) => {
      calls.push(record.record_id);
      if (calls.length === 1) throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      });
      return 'fallback-ok';
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['direct:ollama/qwen2.5:14b', 'openrouter:vendor/fast']);
  assert.equal(io.output().stdout, 'fallback-ok');
  assert.equal(io.output().stderr, '');
});

test('pool skips unresolvable, ambiguous, and unroutable entries', async () => {
  const records = await fixtureRecords();
  const plan = createExecutionPlan({
    config: { pool: ['missing-selector', 'shared', 'unsupported-model', 'vendor/fast'] },
    records,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });
  assert.deepEqual(plan.candidates.map(({ selector }) => selector), ['vendor/fast']);
  assert.equal(plan.skipped.length, 3);
  assert.match(plan.skipped[0].reason, /No model matches/);
  assert.match(plan.skipped[1].reason, /ambiguous/);
  assert.match(plan.skipped[2].reason, /Unsupported litellm provider/);
});

test('successful config pool warns once about skipped entries', async () => {
  const records = await fixtureRecords();
  const io = memoryIo();
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({ pool: ['missing-selector', 'vendor/fast'] }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'key' },
    generate: async () => 'ok',
  });
  assert.equal(exitCode, 0);
  assert.equal(io.output().stdout, 'ok');
  assert.match(io.output().stderr, /^warning: config pool skipped: missing-selector \(No model matches selector/);
  assert.equal(io.output().stderr.trim().split('\n').length, 1);
});

test('ordered pool skips an unresolvable primary, warns, and calls the second entry', async () => {
  const records = await fixtureRecords();
  const io = memoryIo();
  const calls = [];
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({
      pool: ['missing-selector', 'vendor/fast'],
      poolOrdered: true,
    }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'key' },
    generate: async ({ record }) => {
      calls.push(record.record_id);
      return 'fallback-ok';
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['openrouter:vendor/fast']);
  assert.equal(io.output().stdout, 'fallback-ok');
  assert.match(io.output().stderr, /^warning: config pool skipped: missing-selector/);
});

test('successful built-in pool keeps keyless skips silent without debug mode', async () => {
  const io = memoryIo();
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({}),
    loadCatalog: async () => builtInCatalogRecords(),
    env: { DEEPSEEK_API_KEY: 'key' },
    generate: async () => 'ok',
  });
  assert.equal(exitCode, 0);
  assert.equal(io.output().stdout, 'ok');
  assert.equal(io.output().stderr, '');
});

test('injected environment reaches the generation call', async () => {
  const records = await fixtureRecords();
  const env = { OPENROUTER_API_KEY: 'injected-key' };
  await generateFromSelection({
    explicitSelector: 'vendor/fast',
    config: {},
    records,
    prompt: 'hello',
    env,
    generate: async (options) => {
      assert.equal(options.env, env);
      return 'ok';
    },
  });
});

test('only rate-limit and connectivity errors qualify for failover', () => {
  assert.equal(isFailoverError(new Error('quota exceeded for this project')), true);
  assert.equal(isFailoverError({ cause: { response: { status: 429 } } }), true);
  assert.equal(isFailoverError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })), true);
  assert.equal(isFailoverError(new Error('fetch failed')), true);
  assert.equal(isFailoverError(Object.assign(new Error('Unauthorized'), { statusCode: 401 })), false);
  assert.equal(isFailoverError(Object.assign(new Error('Server error'), { statusCode: 500 })), false);
  assert.equal(isFailoverError(new Error('invalid model')), false);
});

test('full keyless pool exhaustion exits 1 and leaves stdout empty', async () => {
  const records = await fixtureRecords();
  const io = memoryIo();
  const exitCode = await main(['run', 'hello'], io, {
    loadConfig: async () => ({ pool: ['vendor/fast', 'unique'] }),
    loadCatalog: async () => records,
    env: {},
    generate: async () => assert.fail('keyless model must not be called'),
  });
  assert.equal(exitCode, 1);
  assert.equal(io.output().stdout, '');
  assert.match(io.output().stderr, /Provider pool exhausted; tried: none/);
  assert.match(io.output().stderr, /vendor\/fast \(no credential\).*unique \(no credential\)/);
});

test('classify uses the pool and preserves its one-line JSON contract', async () => {
  const records = await fixtureRecords();
  const io = memoryIo('Current task is done, with more tasks queued.');
  const exitCode = await main(['classify'], io, {
    loadConfig: async () => ({ pool: ['vendor/fast'] }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'or-key' },
    generate: async () => '{"label":"task-done","reason":"More tasks remain","confidence":0.9}',
  });
  assert.equal(exitCode, 0);
  assert.equal(io.output().stderr, '');
  assert.equal(io.output().stdout, '{"label":"task-done","reason":"More tasks remain","confidence":0.9}\n');
});

test('unconfigured selection always puts deepseek-flash first when its key exists', () => {
  const plan = createExecutionPlan({
    config: {},
    records: builtInCatalogRecords(),
    env: { DEEPSEEK_API_KEY: 'ds-key', OPENROUTER_API_KEY: 'or-key' },
    random: () => 0,
  });
  assert.equal(plan.source, 'built-in-pool');
  assert.equal(plan.candidates[0].selector, 'deepseek/deepseek-flash');
  assert.equal(plan.candidates[0].record.vendor_model_id, 'deepseek-flash');
});

test('unconfigured primary fails over to another built-in after HTTP 429', async () => {
  const calls = [];
  const result = await generateFromSelection({
    config: {},
    records: builtInCatalogRecords(),
    prompt: 'hello',
    env: { DEEPSEEK_API_KEY: 'ds-key', OPENROUTER_API_KEY: 'or-key' },
    random: () => 0.999,
    generate: async ({ record }) => {
      calls.push(record.record_id);
      if (calls.length === 1) throw Object.assign(new Error('rate limited'), { statusCode: 429 });
      return 'fallback-result';
    },
  });
  assert.equal(result, 'fallback-result');
  assert.deepEqual(calls, [
    'direct:deepseek/deepseek-flash',
    'openrouter:deepseek/deepseek-v4-flash',
  ]);
});
