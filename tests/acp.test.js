import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AcpAgent, serveAcp } from '../src/acp.js';
import { SessionStore } from '../src/session-store.js';
import { generateFromSelection } from '../src/pool.js';

function setup(t, generate = async ({ prompt: text, onResult, record }) => {
  onResult?.({ record, result: { response: { id: 'mock-response' }, usage: { inputTokens: 1, outputTokens: 2 } } });
  return `reply:${text}`;
}) {
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

test('ACP creates one-turn private metadata sessions without replay or resume', async t => {
  const { cwd, store, agent, runtime } = setup(t);
  const init = await initialize(agent);
  assert.equal(init.agentCapabilities.loadSession, false);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  assert.equal(statSync(store.path(sessionId)).mode & 0o777, 0o600);
  assert.deepEqual(await agent.handle('session/prompt', prompt(sessionId, 'one')), { stopReason: 'end_turn' });
  const session = store.load(sessionId);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].input.text, 'one');
  assert.equal(session.turns[0].output.text, 'reply:one');
  assert.notEqual(session.turns[0].responseId, 'mock-response');
  assert.equal(session.turns[0].nativeResponseId, 'mock-response');
  assert.deepEqual(session.turns[0].usage, { inputTokens: 1, outputTokens: 2 });
  assert.equal(session.model, 'test');
  assert.equal(session.provider, 'ollama');
  assert.equal('messages' in session, false);
  assert.equal(readFileSync(store.path(sessionId), 'utf8').includes('apiKey'), false);
  await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'two')), /single-turn/);
  await assert.rejects(agent.handle('session/load', { cwd, sessionId, mcpServers: [] }), /does not support session resume/);
  await assert.rejects(agent.handle('session/resume', { cwd, sessionId, mcpServers: [] }), /does not support session resume/);
  const next = await (new AcpAgent({ store, runtime, send: () => {} })).handle('initialize', { protocolVersion: 1 });
  assert.equal(next.agentCapabilities.loadSession, false);
});

test('cancel persists the input with aborted status and available usage', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { cwd, agent, store } = setup(t, async ({ signal, onResult, record }) => {
    started();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      onResult?.({ record, result: { response: { id: 'cancelled-response', modelId: 'test-native' }, usage: { inputTokens: 4 } } });
      reject(signal.reason);
    }, { once: true }));
  });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  const pending = agent.handle('session/prompt', prompt(sessionId, 'hang'));
  await ready;
  await agent.handle('session/cancel', { sessionId });
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
  const turn = store.load(sessionId).turns[0];
  assert.equal(turn.status, 'aborted');
  assert.equal(turn.input.text, 'hang');
  assert.equal(turn.output, undefined);
  assert.deepEqual(turn.usage, { inputTokens: 4 });
  assert.notEqual(turn.responseId, 'cancelled-response');
  assert.equal(turn.nativeResponseId, 'cancelled-response');
  assert.equal(turn.provider, 'ollama');
  assert.equal(turn.model, 'test-native');
});

test('explicit cancellation cannot fail over to another model', async () => {
  const controller = new AbortController(); let attempts = 0;
  await assert.rejects(generateFromSelection({
    config: { pool: ['ollama/one', 'ollama/two'], poolOrdered: true }, records: [], signal: controller.signal,
    generate: async () => { attempts++; controller.abort(); throw new Error('request aborted'); },
  }), /abort/i);
  assert.equal(attempts, 1);
});

test('ACP validates handshake, content, and unsupported operations', async t => {
  const { cwd, agent, store } = setup(t);
  await assert.rejects(agent.handle('session/new', { cwd, mcpServers: [] }), /initialize/);
  await initialize(agent);
  await assert.rejects(initialize(agent), /already initialized/);
  await assert.rejects(agent.handle('session/new', { cwd: '.', mcpServers: [] }), /absolute/);
  await assert.rejects(agent.handle('session/new', { cwd, mcpServers: [{ name: 'tool' }] }), /MCP servers/);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await assert.rejects(agent.handle('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'bad' }] }), /text and resource_link/);
  await assert.rejects(agent.handle('session/set_mode', { sessionId, modeId: 'yolo' }), /Method not found/);
  await agent.handle('session/prompt', { sessionId, prompt: [{ type: 'resource_link', uri: 'file:///not-read', name: 'reference' }] });
  assert.match(store.load(sessionId).turns[0].input.text, /file:\/\/\/not-read/);
});

test('store lock refuses another writer and releases idempotently', t => {
  const { cwd, store } = setup(t);
  const session = store.create(cwd, 'ollama/test');
  const release = store.lock(session.id);
  assert.throws(() => new SessionStore(cwd).lock(session.id), /busy/);
  release(); release();
  store.lock(session.id)();
});

test('provider error preserves the input with failed status and no invented output', async t => {
  const { cwd, agent, store } = setup(t, async ({ onResult, record }) => {
    onResult?.({ record, result: { response: { id: 'failed-response' }, usage: { inputTokens: 6 } } });
    throw new Error('original upstream authentication failure');
  });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'hi')), /original upstream authentication failure/);
  const turn = store.load(sessionId).turns[0];
  assert.equal(turn.status, 'failed');
  assert.equal(turn.input.text, 'hi');
  assert.equal(turn.output, undefined);
  assert.deepEqual(turn.usage, { inputTokens: 6 });
  assert.notEqual(turn.responseId, 'failed-response');
  assert.equal(turn.nativeResponseId, 'failed-response');
  assert.equal(turn.provider, 'ollama');
  assert.equal(turn.model, 'test');
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
