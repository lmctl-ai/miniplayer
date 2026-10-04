import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/miniplayer.js', import.meta.url));
const catalog = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
function connect(env) {
  const child = spawn(process.execPath, [bin, 'acp', '-m', 'ollama/qwen2.5:14b'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const requests = new Map(); const updates = []; let nextId = 0; let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method) updates.push(message);
    else {
      const pending = requests.get(message.id); requests.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message)); else pending?.resolve(message.result);
    }
  });
  const exited = once(child, 'exit');
  child.on('exit', code => { for (const pending of requests.values()) pending.reject(new Error(`ACP exited ${code}: ${stderr}`)); requests.clear(); });
  return {
    child, updates, exited,
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited; },
  };
}

test('real ACP CLI records native model, usage, timestamps, and never replays history', { timeout: 15000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'miniplayer-acp-http-'));
  const config = join(home, 'config.json'); writeFileSync(config, '{}');
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls.push(request);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `local-response-${calls.length}`, object: 'chat.completion', created: 1, model: 'test-native',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ACK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const env = { ...process.env, MINIPLAYER_DEBUG: '1', MINIPLAYER_CONFIG: config, MINIPLAYER_HOME: home, MINIPLAYER_LMPRICE_CATALOG: catalog,
    OLLAMA_HOST: `http://127.0.0.1:${server.address().port}` };
  const client = connect(env);
  t.after(async () => { await client.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(home, { recursive: true, force: true }); });
  const init = await client.request('initialize', { protocolVersion: 1 });
  assert.equal(init.agentCapabilities.loadSession, false);
  const { sessionId } = await client.request('session/new', { cwd: home, mcpServers: [] });
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] });
  assert.deepEqual(calls[0].messages.map(message => message.content), ['one']);
  await assert.rejects(client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] }), /single-turn/);
  const stored = JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8'));
  assert.equal(stored.provider, 'ollama');
  assert.equal(stored.model, 'test-native');
  assert.notEqual(stored.turns[0].responseId, 'local-response-1');
  assert.equal(stored.turns[0].nativeResponseId, 'local-response-1');
  assert.equal(stored.turns[0].usageConvention, 'input-includes-cache');
  assert.deepEqual(stored.turns[0].usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  assert.equal(typeof stored.turns[0].startedAt, 'string');
  assert.equal(typeof stored.turns[0].completedAt, 'string');
});
