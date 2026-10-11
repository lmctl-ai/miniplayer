import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { generateOneShot } from '../src/providers.js';
import { generateFromSelection } from '../src/pool.js';

test('live AI SDK loop executes a local tool and sends its result back to the model', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'miniplayer-tool-loop-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'note.txt'), 'local fixture');
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const response = requests.length === 1
      ? { id: 'step-1', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt', maxBytes: 64 }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
      : { id: 'step-2', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'The file says: local fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  let metadata;
  const text = await generateOneShot({
    record: { record_id: 'direct:ollama/fixture', source: 'litellm', provider: 'ollama', vendor_model_id: 'fixture' },
    config: {}, env: { OLLAMA_HOST: `http://127.0.0.1:${port}`, MINIPLAYER_REQUEST_TIMEOUT_MS: '5000' },
    cwd, prompt: 'Read note.txt and report its contents', onResult: value => { metadata = value; },
  });
  assert.equal(text, 'The file says: local fixture');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].tools.length >= 4, true);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1'));
  assert.ok(metadata.result.steps.length >= 2);
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'local fixture');
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
      onToolEvent?.({ type: 'tool_call', toolName: 'write_file', toolCallId: 'mutate-1', input: { path: 'x', content: 'x' } });
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
      onToolEvent?.({ type: 'tool_result', toolName: 'write_file', toolCallId: 'known-result', result: { bytesWritten: 1 } });
      const error = new Error('connection reset after result'); error.code = 'ECONNRESET'; throw error;
    },
  }), /connection reset/);
  assert.equal(attempts, 1);
});

test('tool step exhaustion fails even when the intermediate step has text', async () => {
  await assert.rejects(generateOneShot({
    record: { record_id: 'direct:ollama/fixture', source: 'litellm', provider: 'ollama', vendor_model_id: 'fixture' },
    config: {}, env: { OLLAMA_HOST: 'http://127.0.0.1:1', MINIPLAYER_REQUEST_TIMEOUT_MS: '1000' },
    cwd: process.cwd(), prompt: 'loop',
    generateText: async options => {
      assert.ok(options.tools);
      return { text: 'intermediate', steps: [{ text: 'intermediate', toolCalls: [{ toolCallId: 'same', toolName: 'read_file' }] }] };
    },
  }), /Tool-call step limit/);
});
