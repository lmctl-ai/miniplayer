import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateFromSelection } from '../src/pool.js';
import { execute } from '../src/cli.js';
import { PassThrough } from 'node:stream';

const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

test('prints warning when tools are configured on a model without tool-calling support', async () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);

  const noToolModel = {
    record_id: 'test:no-tools',
    source: 'litellm',
    source_model_id: 'ollama/no-tools',
    provider: 'ollama',
    vendor_model_id: 'no-tools',
    capabilities: { supports_function_calling: false },
  };

  const toolSupportedModel = {
    record_id: 'test:with-tools',
    source: 'litellm',
    source_model_id: 'ollama/with-tools',
    provider: 'ollama',
    vendor_model_id: 'with-tools',
    capabilities: { supports_function_calling: true },
  };

  const records = [noToolModel, toolSupportedModel];
  const configWithTools = {
    tools: [{ name: 'faketool', command: faketool }],
  };

  // 1. Interactive generation with tools on unsupported model should warn
  warnings.length = 0;
  await generateFromSelection({
    explicitSelector: 'ollama/no-tools',
    config: configWithTools,
    records,
    prompt: 'hello',
    warn,
    generate: async () => 'done',
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /does not support tool calling/);

  // 2. Interactive generation with tools on supported model should NOT warn
  warnings.length = 0;
  await generateFromSelection({
    explicitSelector: 'ollama/with-tools',
    config: configWithTools,
    records,
    prompt: 'hello',
    warn,
    generate: async () => 'done',
  });
  assert.equal(warnings.length, 0);

  // 3. Pure run command on unsupported model with config tools should NOT warn (run never sends tools)
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stderrOutput = '';
  stderr.on('data', d => { stderrOutput += d.toString('utf8'); });

  await execute(['run', '-m', 'ollama/no-tools', 'prompt text'], { stdin, stdout, stderr }, {
    loadCatalog: async () => records,
    loadConfig: async () => configWithTools,
    generate: async () => 'done',
  });
  assert.ok(!stderrOutput.includes('does not support tool calling'), 'pure run must not warn about tools');
});
