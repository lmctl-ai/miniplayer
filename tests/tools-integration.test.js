import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateOneShot } from '../src/providers.js';
import { generateFromSelection } from '../src/pool.js';

const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

test('live AI SDK loop executes an external tool and sends its result back to the model', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'miniplayer-tool-loop-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const response = requests.length === 1
      ? { id: 'step-1', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'faketool', arguments: JSON.stringify({ args: ['echo', 'local fixture'] }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
      : { id: 'step-2', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'The tool returned: local fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  let metadata;
  const text = await generateOneShot({
    record: { record_id: 'direct:ollama/fixture', source: 'litellm', provider: 'ollama', vendor_model_id: 'fixture' },
    config: { tools: [faketool] },
    env: { OLLAMA_HOST: `http://127.0.0.1:${port}`, MINIPLAYER_REQUEST_TIMEOUT_MS: '5000' },
    cwd, prompt: 'Run faketool echo and report output', onResult: value => { metadata = value; },
  });
  assert.equal(text, 'The tool returned: local fixture');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length, 1);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1'));
  assert.ok(metadata.result.steps.length >= 2);
});

test('pool does not retry after a tool has started and the model fails', async () => {
  let attempts = 0;
  await assert.rejects(generateFromSelection({
    explicitSelector: undefined,
    config: { pool: ['ollama/first', 'ollama/second'], poolOrdered: true },
    records: [],
    cwd: process.cwd(),
    generate: async ({ onToolEvent }) => {
      attempts += 1;
      onToolEvent?.({ type: 'tool_call', toolName: 'faketool', toolCallId: 'mutate-1', input: { args: ['echo', 'x'] } });
      const error = new Error('connection reset after mutation'); error.code = 'ECONNRESET'; throw error;
    },
  }), /connection reset/);
  assert.equal(attempts, 1);
});

test('pool does not retry after receiving a tool result even without its start event', async () => {
  let attempts = 0;
  await assert.rejects(generateFromSelection({
    config: { pool: ['ollama/first', 'ollama/second'], poolOrdered: true }, records: [], cwd: process.cwd(),
    generate: async ({ onToolEvent }) => {
      attempts += 1;
      onToolEvent?.({ type: 'tool_result', toolName: 'faketool', toolCallId: 'known-result', result: { exit_code: 0 } });
      const error = new Error('connection reset after result'); error.code = 'ECONNRESET'; throw error;
    },
  }), /connection reset/);
  assert.equal(attempts, 1);
});

test('tool step exhaustion fails even when the intermediate step has text', async () => {
  await assert.rejects(generateOneShot({
    record: { record_id: 'direct:ollama/fixture', source: 'litellm', provider: 'ollama', vendor_model_id: 'fixture' },
    config: { tools: [faketool] }, env: { OLLAMA_HOST: 'http://127.0.0.1:1', MINIPLAYER_REQUEST_TIMEOUT_MS: '1000' },
    cwd: process.cwd(), prompt: 'loop',
    generateText: async options => {
      assert.ok(options.tools);
      return { text: 'intermediate', steps: [{ text: 'intermediate', toolCalls: [{ toolCallId: 'same', toolName: 'faketool' }] }] };
    },
  }), /Tool-call step limit/);
});
