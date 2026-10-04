import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AcpAgent, serveAcp } from '../src/acp.js';
import { SessionStore } from '../src/session-store.js';
import { generateFromSelection } from '../src/pool.js';

function setup(t, generate = async ({ messages }) => `reply:${messages.at(-1).content}`) {
  const cwd = mkdtempSync(join(tmpdir(), 'miniplayer-acp-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionStore(cwd);
  const updates = [];
  const runtime = { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => ({}), loadCatalog: async () => [], generate, random: () => 0 };
  const agent = new AcpAgent({ store, runtime, model: 'ollama/test', send: value => updates.push(value) });
  return { cwd, store, updates, runtime, agent };
}
const initialize = agent => agent.handle('initialize', { protocolVersion: 1, clientCapabilities: {} });
const prompt = (sessionId, text) => ({ sessionId, prompt: [{ type: 'text', text }] });

test('ACP creates private native sessions, preserves history and replays after restart', async t => {
  const inputs = [];
  const { cwd, store, agent, runtime } = setup(t, async input => { inputs.push(input); return 'ACK'; });
  assert.equal((await initialize(agent)).agentCapabilities.loadSession, true);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  assert.equal(statSync(store.path(sessionId)).mode & 0o777, 0o600);
  assert.deepEqual(await agent.handle('session/prompt', prompt(sessionId, 'one')), { stopReason: 'end_turn' });
  await agent.handle('session/prompt', prompt(sessionId, 'two'));
  assert.deepEqual(inputs[1].messages.map(m => m.content), ['one', 'ACK', 'two']);
  assert.equal(inputs[1].timeoutMs, 0);
  const updates = [];
  const restarted = new AcpAgent({ store, runtime, send: value => updates.push(value) });
  await initialize(restarted);
  await restarted.handle('session/load', { cwd, sessionId, mcpServers: [] });
  assert.deepEqual(updates.map(m => m.params.update.content.text), ['one', 'ACK', 'two', 'ACK']);
  await restarted.handle('session/prompt', prompt(sessionId, 'three'));
  assert.equal(inputs[2].messages.length, 5);
  assert.equal(store.load(sessionId).model, 'ollama/test');
  assert.equal(store.load(sessionId).messages.length, 6);
  assert.equal(readFileSync(store.path(sessionId), 'utf8').includes('apiKey'), false);
});

test('cancel aborts generation, never commits cancelled history, then session is reusable', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { cwd, agent, store } = setup(t, async ({ messages, signal }) => {
    if (messages.at(-1).content !== 'hang') return 'ACK';
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  const pending = agent.handle('session/prompt', prompt(sessionId, 'hang'));
  await ready;
  await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'concurrent')), /active prompt/);
  await agent.handle('session/cancel', { sessionId });
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
  assert.equal(store.load(sessionId).messages.length, 0);
  await agent.handle('session/prompt', prompt(sessionId, 'next'));
  assert.deepEqual(store.load(sessionId).messages.map(m => m.content), ['next', 'ACK']);
});

test('explicit cancellation cannot fail over to another model', async () => {
  const controller = new AbortController(); let attempts = 0;
  await assert.rejects(generateFromSelection({
    config: { pool: ['ollama/one', 'ollama/two'], poolOrdered: true }, records: [], signal: controller.signal,
    generate: async () => { attempts++; controller.abort(); throw new Error('request aborted'); },
  }), /abort/i);
  assert.equal(attempts, 1);
});

test('ACP validates handshake, session binding, content and unsupported operations', async t => {
  const { cwd, agent, store } = setup(t);
  await assert.rejects(agent.handle('session/new', { cwd, mcpServers: [] }), /initialize/);
  await initialize(agent);
  await assert.rejects(initialize(agent), /already initialized/);
  await assert.rejects(agent.handle('session/new', { cwd: '.', mcpServers: [] }), /absolute/);
  await assert.rejects(agent.handle('session/new', { cwd, mcpServers: [{ name: 'tool' }] }), /MCP servers/);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await assert.rejects(agent.handle('session/load', { cwd: tmpdir(), sessionId, mcpServers: [] }), /different working/);
  await assert.rejects(agent.handle('session/load', { cwd, sessionId: '../../etc/passwd', mcpServers: [] }), /Invalid.*ID/);
  await assert.rejects(agent.handle('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'bad' }] }), /text and resource_link/);
  await assert.rejects(agent.handle('session/set_mode', { sessionId, modeId: 'yolo' }), /Method not found/);
  await agent.handle('session/prompt', { sessionId, prompt: [{ type: 'resource_link', uri: 'file:///not-read', name: 'reference' }] });
  assert.match(store.load(sessionId).messages[0].content, /file:\/\/\/not-read/);
});

test('store lock refuses another writer and releases idempotently', t => {
  const { cwd, store } = setup(t);
  const session = store.create(cwd, 'ollama/test');
  const release = store.lock(session.id);
  assert.throws(() => new SessionStore(cwd).lock(session.id), /busy/);
  release(); release();
  store.lock(session.id)();
});

test('provider error preserves history and original message', async t => {
  const { cwd, agent, store } = setup(t, async () => { throw new Error('original upstream authentication failure'); });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'hi')), /original upstream authentication failure/);
  assert.equal(store.load(sessionId).messages.length, 0);
  store.lock(sessionId)();
});

test('wire server emits only JSON-RPC, responds to malformed input and stays alive', async t => {
  const { runtime } = setup(t);
  const stdin = new PassThrough(); let output = '';
  const io = { stdin, stdout: { write: chunk => { output += chunk; } }, stderr: { write() {} } };
  const running = serveAcp([], io, runtime);
  stdin.write('{bad json\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown' }) + '\n');
  stdin.end();
  assert.equal(await running, 0);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses.find(r => r.id === 'init').result.protocolVersion, 1);
  assert.equal(responses.find(r => r.id === 2).error.code, -32601);
});
