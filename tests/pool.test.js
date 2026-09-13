import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/index.js';
import { createExecutionPlan, generateFromSelection, isRateLimitError } from '../src/pool.js';

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

test('quota-style nested SDK errors are recognized as rate limits', () => {
  assert.equal(isRateLimitError(new Error('quota exceeded for this project')), true);
  assert.equal(isRateLimitError(new Error('authentication failed')), false);
  assert.equal(isRateLimitError({ cause: { response: { status: 429 } } }), true);
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
