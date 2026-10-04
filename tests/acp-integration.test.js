import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/miniplayer.js', import.meta.url));
const catalog = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
function connect(env) {
  const child = spawn(process.execPath, [bin, 'acp', '-m', 'ollama/test'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); },
    async close() { if (child.exitCode === null && child.signalCode === null) child.stdin.end(); await exited; },
  };
}

test('real ACP CLI + AI SDK preserve conversation across processes, cancel, and clean shutdown', { timeout: 15000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'miniplayer-acp-http-'));
  const config = join(home, 'config.json');
  writeFileSync(config, JSON.stringify({ requestTimeoutMs: 1 })); // ACP must not inherit this deadline.
  const calls = []; let sawHang; let sawAbort;
  let hangReady = new Promise(resolve => { sawHang = resolve; });
  let abortReady = new Promise(resolve => { sawAbort = resolve; });
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls.push(request);
    const last = request.messages.at(-1).content;
    if (last === 'hang') { res.on('close', () => sawAbort()); sawHang(); return; }
    // Slower than config's 1ms timeout, but ACP has no implicit deadline.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-response', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ACK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 15);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const clients = [];
  t.after(async () => {
    for (const client of clients) { client.child.kill('SIGTERM'); await client.exited; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const env = { ...process.env, MINIPLAYER_HOME: home, MINIPLAYER_CONFIG: config,
    MINIPLAYER_LMPRICE_CATALOG: catalog, OLLAMA_HOST: `http://127.0.0.1:${server.address().port}` };
  const client = connect(env); clients.push(client);
  const init = await client.request('initialize', { protocolVersion: 1 });
  assert.equal(init.agentCapabilities.loadSession, true);
  const { sessionId } = await client.request('session/new', { cwd: home, mcpServers: [] });
  const prompt = text => ({ sessionId, prompt: [{ type: 'text', text }] });
  await client.request('session/prompt', prompt('one'));
  await client.request('session/prompt', prompt('two'));
  assert.deepEqual(calls[1].messages.map(m => m.content), ['one', 'ACK', 'two']);
  assert.equal(client.updates.at(-1).params.update.content.text, 'ACK');
  const cancelled = client.request('session/prompt', prompt('hang'));
  await hangReady;
  client.notify('session/cancel', { sessionId });
  assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
  await abortReady;
  await client.request('session/prompt', prompt('after cancel'));
  assert.equal(calls.at(-1).messages.some(m => m.content === 'hang'), false);
  await client.close();

  const restarted = connect(env); clients.push(restarted);
  await restarted.request('initialize', { protocolVersion: 1 });
  assert.equal((await restarted.request('session/load', { sessionId, cwd: home, mcpServers: [] })).sessionId, sessionId);
  assert.deepEqual(restarted.updates.map(u => u.params.update.content.text), ['one', 'ACK', 'two', 'ACK', 'after cancel', 'ACK']);
  await restarted.request('session/prompt', prompt('after restart'));
  assert.equal(calls.at(-1).messages.length, 7);

  // A process-level stop (lmctl per-turn abort) must release the native lease too.
  hangReady = new Promise(resolve => { sawHang = resolve; });
  abortReady = new Promise(resolve => { sawAbort = resolve; });
  const stopped = restarted.request('session/prompt', prompt('hang')).catch(() => undefined);
  await hangReady;
  restarted.child.kill('SIGTERM');
  await restarted.exited; await stopped; await abortReady;
  assert.equal(existsSync(join(home, 'sessions', `${sessionId}.json.lock`)), false);
});
