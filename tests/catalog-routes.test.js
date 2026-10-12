// Catalog routes: lmprice's `miniplayer` column ({id, provider, model, sdk, base_url, key_env})
// drives selector resolution and provider routing with zero config; records without it keep the
// built-in fallback table.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';

import { findSelectorMatches } from '../src/catalog.js';
import { createModel, knownProviderRoutes, resolveProviderRoute } from '../src/providers.js';
import { resolveCallableModel } from '../src/selector.js';

const bin = fileURLToPath(new URL('../bin/miniplayer.js', import.meta.url));
const fixturePath = fileURLToPath(new URL('./fixtures/catalog-routes.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const records = fixture.records;
const byId = (recordId) => records.find((r) => r.record_id === recordId);

// ---- selector resolution -----------------------------------------------------------------------

test('a selector matches miniplayer.id before the other id fields', () => {
  // openai/gpt-6 is also the OpenRouter record's gateway_id; the routed id wins.
  assert.deepEqual(findSelectorMatches(records, 'openai/gpt-6').map((r) => r.record_id), ['litellm:gpt-6']);
  const { record, passthrough } = resolveCallableModel(records, 'openai/gpt-6');
  assert.equal(record.record_id, 'litellm:gpt-6');
  assert.equal(passthrough, false);
  // Existing fields still resolve when no routed id matches.
  assert.equal(resolveCallableModel(records, 'gpt-6').record.record_id, 'litellm:gpt-6');
  assert.equal(resolveCallableModel(records, 'deepseek/deepseek-chat').record.record_id, 'litellm:deepseek/deepseek-chat');
  // Aliases resolve to routed ids too.
  assert.equal(resolveCallableModel(records, 'opus', { opus: 'anthropic/claude-opus-5-5' }).record.record_id, 'litellm:claude-opus-5-5');
});

test('an unlisted model of a routed provider uses that provider\'s route', () => {
  for (const [selector, model, sdk, baseUrl, keyEnv] of [
    ['anthropic/claude-brand-new', 'claude-brand-new', 'anthropic', null, 'ANTHROPIC_API_KEY'],
    ['together_ai/new-org/new-model', 'new-org/new-model', 'openai-compatible', 'https://api.together.ai/v1', 'TOGETHER_API_KEY'],
    ['ollama/llama4:8b', 'llama4:8b', 'openai-compatible', 'http://localhost:11434/v1', null],
  ]) {
    const { record, passthrough } = resolveCallableModel(records, selector);
    assert.equal(passthrough, true, selector);
    assert.deepEqual(record.miniplayer, {
      id: selector,
      provider: selector.split('/')[0],
      model,
      sdk,
      base_url: baseUrl,
      key_env: keyEnv,
    });
  }
});

test('an unknown provider is a clear error listing the known providers', () => {
  assert.throws(
    () => resolveCallableModel(records, 'nosuchprovider/model-x'),
    (error) => {
      assert.match(error.message, /^No model matches selector "nosuchprovider\/model-x": unknown provider "nosuchprovider" \(known providers: /);
      for (const name of ['anthropic', 'gemini', 'ollama', 'openai', 'together_ai', 'deepseek', 'openrouter']) {
        assert.ok(error.message.includes(name), `${name} listed: ${error.message}`);
      }
      return true;
    },
  );
  // A selector without a provider keeps the old message.
  assert.throws(() => resolveCallableModel(records, 'no-such-model'), /No model matches selector "no-such-model"/);
});

// ---- routes ------------------------------------------------------------------------------------

test('routes come from the record\'s miniplayer field', () => {
  const env = {
    ANTHROPIC_API_KEY: 'a-key',
    OPENAI_API_KEY: 'o-key',
    GOOGLE_GENERATIVE_AI_API_KEY: 'g-key',
    TOGETHER_API_KEY: 't-key',
  };
  const cases = [
    ['litellm:claude-opus-5-5', { kind: 'native', create: createAnthropic, name: 'anthropic', baseURL: undefined, apiKey: 'a-key', envKey: 'ANTHROPIC_API_KEY', modelId: 'claude-opus-5-5' }],
    ['litellm:gpt-6', { kind: 'native', create: createOpenAI, name: 'openai', baseURL: undefined, apiKey: 'o-key', envKey: 'OPENAI_API_KEY', modelId: 'gpt-6' }],
    ['litellm:gemini/gemini-3-pro', { kind: 'native', create: createGoogleGenerativeAI, name: 'gemini', baseURL: undefined, apiKey: 'g-key', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', modelId: 'gemini-3-pro' }],
    ['litellm:together_ai/meta-llama/Llama-4', { kind: 'openai-compatible', name: 'together_ai', baseURL: 'https://api.together.ai/v1', apiKey: 't-key', envKey: 'TOGETHER_API_KEY', modelId: 'meta-llama/Llama-4' }],
  ];
  for (const [recordId, expected] of cases) {
    const route = resolveProviderRoute(byId(recordId), {}, env);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(route[key], value, `${recordId}.${key}`);
    }
  }
});

test('precedence: env key over config key, config baseURL over the record\'s', () => {
  const record = byId('litellm:together_ai/meta-llama/Llama-4');
  const config = { provider: { together_ai: { apiKey: 'config-key', baseURL: 'https://proxy.example/v1' } } };
  let route = resolveProviderRoute(record, config, { TOGETHER_API_KEY: 'env-key' });
  assert.equal(route.apiKey, 'env-key');
  assert.equal(route.baseURL, 'https://proxy.example/v1');
  route = resolveProviderRoute(record, config, {});
  assert.equal(route.apiKey, 'config-key', 'the config key is the (discouraged) fallback');
  route = resolveProviderRoute(record, {}, {});
  assert.equal(route.baseURL, 'https://api.together.ai/v1');
  assert.equal(route.apiKey, undefined);
});

test('keyless ollama honours OLLAMA_HOST, then config, then the record', () => {
  const record = byId('litellm:ollama/qwen2.5');
  assert.equal(resolveProviderRoute(record, {}, {}).baseURL, 'http://localhost:11434/v1');
  assert.equal(resolveProviderRoute(record, {}, { OLLAMA_HOST: 'http://gpu-box:11434/' }).baseURL, 'http://gpu-box:11434/v1');
  const configured = resolveProviderRoute(record, { provider: { ollama: { baseURL: 'http://cfg:1/v1' } } }, { OLLAMA_HOST: 'http://ignored:11434' });
  assert.equal(configured.baseURL, 'http://cfg:1/v1');
  const model = createModel(record, {}, {});
  assert.equal(model.modelId, 'qwen2.5');
});

test('a missing key names the env var to export and never prints key values', () => {
  const record = byId('litellm:claude-opus-5-5');
  assert.throws(
    () => createModel(record, { provider: { openai: { apiKey: 'unrelated-secret' } } }, { OPENAI_API_KEY: 'other-secret' }),
    (error) => {
      assert.equal(error.message, 'Missing API key for anthropic: export ANTHROPIC_API_KEY=... (or set provider.anthropic.apiKey in the config; discouraged)');
      assert.ok(!error.message.includes('secret'));
      return true;
    },
  );
});

test('an unknown sdk in a record is refused clearly', () => {
  const record = { ...byId('litellm:gpt-6'), miniplayer: { ...byId('litellm:gpt-6').miniplayer, sdk: 'grpc' } };
  assert.throws(() => resolveProviderRoute(record, {}, { OPENAI_API_KEY: 'k' }), /Unsupported sdk "grpc" for model "openai\/gpt-6"/);
});

test('records without the column keep the fallback table route', () => {
  const record = byId('litellm:deepseek/deepseek-chat');
  const route = resolveProviderRoute(record, { provider: { deepseek: { apiKey: 'config-key' } } }, {});
  assert.equal(route.kind, 'openai-compatible');
  assert.equal(route.baseURL, 'https://api.deepseek.com');
  assert.equal(route.apiKey, 'config-key');
  assert.equal(route.modelId, 'deepseek-chat');
  assert.equal(route.envKey, 'DEEPSEEK_API_KEY');
  assert.equal(route.configFallback, 'deepseek');
});

test('knownProviderRoutes: one route per provider from the catalog, the fallback table otherwise', () => {
  const routes = knownProviderRoutes(records);
  assert.deepEqual(routes.get('together_ai'), { provider: 'together_ai', sdk: 'openai-compatible', base_url: 'https://api.together.ai/v1', key_env: 'TOGETHER_API_KEY', source: 'catalog' });
  assert.equal(routes.get('deepseek').source, 'built-in');
  assert.equal(routes.get('openrouter').key_env, 'OPENROUTER_API_KEY');
  const empty = knownProviderRoutes([]);
  assert.equal(empty.get('anthropic').sdk, 'anthropic');
  assert.equal(empty.get('ollama').key_env, null);
});

// ---- through the CLI, against a local OpenAI-compatible endpoint --------------------------------

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

async function localEndpoint(t) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'r', object: 'chat.completion', created: 1, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'routed reply' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

/** A temp HOME without any config file and a catalog whose compatible routes point at `base`. */
function zeroConfigEnv(t, base) {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-routes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const doc = JSON.parse(JSON.stringify(fixture));
  for (const r of doc.records) {
    if (r.miniplayer?.provider === 'together_ai') {
      r.miniplayer.base_url = `${base}/v1`;
      r.miniplayer.key_env = 'MINIPLAYER_TEST_COMPAT_KEY';
    }
  }
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(doc));
  const env = { PATH: process.env.PATH, HOME: dir, MINIPLAYER_CATALOG: join(dir, 'catalog.json') };
  return env;
}

test('zero config: export the key and run a routed id or a brand-new model of that provider', async (t) => {
  const { requests, base } = await localEndpoint(t);
  const env = { ...zeroConfigEnv(t, base), MINIPLAYER_TEST_COMPAT_KEY: 'sk-test-123' };
  for (const [selector, wire] of [
    ['together_ai/meta-llama/Llama-4', 'meta-llama/Llama-4'],
    ['together_ai/brand/new-model', 'brand/new-model'],
  ]) {
    requests.length = 0;
    const result = await runCli(['run', '-m', selector, 'hello'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'routed reply');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer sk-test-123');
    assert.equal(requests[0].body.model, wire);
  }
  // Keyless ollama through OLLAMA_HOST: no Authorization needed.
  requests.length = 0;
  const ollama = await runCli(['run', '-m', 'ollama/qwen2.5', 'hi'], { ...env, OLLAMA_HOST: base });
  assert.equal(ollama.code, 0, ollama.stderr);
  assert.equal(requests[0].url, '/v1/chat/completions');
  assert.equal(requests[0].body.model, 'qwen2.5');
});

test('zero config: a missing key fails before any request and names the variable', async (t) => {
  const { requests, base } = await localEndpoint(t);
  const env = zeroConfigEnv(t, base);
  const result = await runCli(['run', '-m', 'together_ai/meta-llama/Llama-4', 'hello'], env);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Missing API key for together_ai: export MINIPLAYER_TEST_COMPAT_KEY=\.\.\./);
  assert.equal(requests.length, 0);
});

// ---- models --routed and providers -------------------------------------------------------------

test('models --routed lists routed ids with whether the key is set', async (t) => {
  const env = { ...zeroConfigEnv(t, 'http://127.0.0.1:9'), ANTHROPIC_API_KEY: 'sk-secret-value' };
  const result = await runCli(['models', '--routed'], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, [
    'id\tprovider\tkey_set',
    'anthropic/claude-opus-5-5\tanthropic\tyes',
    'gemini/gemini-3-pro\tgemini\tno',
    'ollama/qwen2.5\tollama\tkeyless',
    'openai/gpt-6\topenai\tno',
    'together_ai/meta-llama/Llama-4\ttogether_ai\tno',
    '',
  ].join('\n'));
  assert.ok(!result.stdout.includes('sk-secret-value'));
  const filtered = await runCli(['models', '--routed', '--provider', 'anthropic', '--json'], env);
  assert.deepEqual(JSON.parse(filtered.stdout), [
    { id: 'anthropic/claude-opus-5-5', provider: 'anthropic', model: 'claude-opus-5-5', sdk: 'anthropic', base_url: null, key_env: 'ANTHROPIC_API_KEY', key_set: 'yes' },
  ]);
  // The plain models table shows the routed id as the selector.
  const plain = await runCli(['models', '--provider', 'anthropic'], env);
  assert.match(plain.stdout, /^anthropic\/claude-opus-5-5\tanthropic\t/m);
});

test('providers lists each provider\'s route and whether its key is set', async (t) => {
  const env = { ...zeroConfigEnv(t, 'http://127.0.0.1:9'), OPENAI_API_KEY: 'sk-other-secret' };
  const result = await runCli(['providers'], env);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], 'provider\tsdk\tbase_url\tkey_env\tkey_set\tsource');
  assert.ok(lines.includes('openai\topenai\t-\tOPENAI_API_KEY\tyes\tcatalog'), result.stdout);
  assert.ok(lines.includes('ollama\topenai-compatible\thttp://localhost:11434/v1\t-\tkeyless\tcatalog'), result.stdout);
  assert.ok(lines.includes('deepseek\topenai-compatible\thttps://api.deepseek.com\tDEEPSEEK_API_KEY\tno\tbuilt-in'), result.stdout);
  assert.ok(!result.stdout.includes('sk-other-secret'));
  const json = JSON.parse((await runCli(['providers', '--json'], env)).stdout);
  assert.deepEqual(json.find((p) => p.provider === 'anthropic'), {
    provider: 'anthropic', sdk: 'anthropic', base_url: null, key_env: 'ANTHROPIC_API_KEY', key_set: 'no', source: 'catalog',
  });
});
