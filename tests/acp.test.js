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

test('ACP creates private metadata sessions with live context but no cold resume', async t => {
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
  await agent.handle('session/prompt', prompt(sessionId, 'two'));
  assert.equal(store.load(sessionId).turns.length, 2);
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

test('mock Echo is exact and mock Adder retains state across ACP turns', async t => {
  const { cwd, store, updates } = setup(t);
  const echoAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => ({}), loadCatalog: async () => [], random: () => 0 }, model: 'mock/Echo', send: value => updates.push(value) });
  await initialize(echoAgent);
  const echo = await echoAgent.handle('session/new', { cwd, mcpServers: [] });
  await echoAgent.handle('session/prompt', prompt(echo.sessionId, '  hello 🌍\n'));
  await echoAgent.handle('session/prompt', prompt(echo.sessionId, 'two\twords'));
  assert.deepEqual(store.load(echo.sessionId).turns.map(turn => turn.output.text), ['  hello 🌍\n', 'two\twords']);

  const adderAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => ({}), loadCatalog: async () => [], random: () => 0 }, model: 'mock/Adder', send: value => updates.push(value) });
  await initialize(adderAgent);
  const { sessionId } = await adderAgent.handle('session/new', { cwd, mcpServers: [] });
  await adderAgent.handle('session/prompt', prompt(sessionId, '2'));
  await adderAgent.handle('session/prompt', prompt(sessionId, '3'));
  const session = store.load(sessionId);
  assert.deepEqual(session.turns.map(turn => turn.output.text), ['2', '5']);
  assert.deepEqual(session.turns[0].usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  assert.equal(session.turns[0].usageConvention, 'synthetic');
  assert.equal(session.turns.length, 2);
  assert.equal(session.provider, 'mock');
  assert.equal(session.model, 'Adder');
});

test('mock Adder rejects invalid input without changing its accumulator', async t => {
  const { cwd, agent, store } = setup(t);
  const mockAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => ({}), loadCatalog: async () => [], random: () => 0 }, model: 'mock/Adder', send: () => {} });
  await initialize(mockAgent);
  const { sessionId } = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  await mockAgent.handle('session/prompt', prompt(sessionId, '4'));
  for (const [value, error] of [['nope', /finite decimal number/], ['', /prompt must not be empty/], ['NaN', /finite decimal number/], ['Infinity', /finite decimal number/], ['1x', /finite decimal number/], ['0x10', /finite decimal number/], ['1e3', /finite decimal number/], ['1e309', /finite decimal number/], [`1${'0'.repeat(400)}`, /finite decimal number/]]) {
    await assert.rejects(mockAgent.handle('session/prompt', prompt(sessionId, value)), error);
  }
  await mockAgent.handle('session/prompt', prompt(sessionId, '6'));
  const turns = store.load(sessionId).turns;
  assert.equal(turns[0].output.text, '4');
  assert.equal(turns.at(-1).output.text, '10');
  assert.ok(turns.slice(1, -1).every(turn => turn.status === 'failed' && turn.output === undefined));
});

test('mock Adder cancellation does not commit its pending result', async t => {
  const { cwd, agent, store } = setup(t);
  const mockAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => { throw new Error('no config'); }, loadCatalog: async () => { throw new Error('no catalog'); } }, model: 'mock/Adder', send: () => {} });
  await initialize(mockAgent);
  const { sessionId } = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  await mockAgent.handle('session/prompt', prompt(sessionId, '1'));
  const pending = mockAgent.handle('session/prompt', prompt(sessionId, '10'));
  await mockAgent.handle('session/cancel', { sessionId });
  assert.deepEqual(await pending, { stopReason: 'cancelled' });
  await mockAgent.handle('session/prompt', prompt(sessionId, '2'));
  assert.equal(store.load(sessionId).turns.at(-1).output.text, '3');
});

test('mock Adder state is isolated between concurrent sessions', async t => {
  const { cwd, agent, store } = setup(t);
  const mockAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => { throw new Error('no config'); }, loadCatalog: async () => { throw new Error('no catalog'); } }, model: 'mock/Adder', send: () => {} });
  await initialize(mockAgent);
  const first = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  const second = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  await Promise.all([mockAgent.handle('session/prompt', prompt(first.sessionId, '2')), mockAgent.handle('session/prompt', prompt(second.sessionId, '7'))]);
  assert.equal(store.load(first.sessionId).turns[0].output.text, '2');
  assert.equal(store.load(second.sessionId).turns[0].output.text, '7');
});

test('concurrent prompts on one mock session reject without advancing state twice', async t => {
  const { cwd, agent, store } = setup(t);
  const mockAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => { throw new Error('no config'); }, loadCatalog: async () => { throw new Error('no catalog'); } }, model: 'mock/Adder', send: () => {} });
  await initialize(mockAgent);
  const { sessionId } = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  const first = mockAgent.handle('session/prompt', prompt(sessionId, '2'));
  await assert.rejects(mockAgent.handle('session/prompt', prompt(sessionId, '99')), /active prompt/);
  await first;
  assert.equal(store.load(sessionId).turns.length, 1);
  assert.equal(store.load(sessionId).turns[0].output.text, '2');
});

test('mock Echo preserves ordering across multiple content blocks', async t => {
  const { cwd, agent, store } = setup(t);
  const mockAgent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => { throw new Error('no config'); }, loadCatalog: async () => { throw new Error('no catalog'); } }, model: 'mock/Echo', send: () => {} });
  await initialize(mockAgent);
  const { sessionId } = await mockAgent.handle('session/new', { cwd, mcpServers: [] });
  await mockAgent.handle('session/prompt', { sessionId, prompt: [
    { type: 'text', text: 'first' }, { type: 'resource_link', name: 'ref', uri: 'file:///tmp/ref' }, { type: 'text', text: 'last' },
  ] });
  assert.equal(store.load(sessionId).turns[0].output.text, 'first\n[Resource: ref] file:///tmp/ref\nlast');
});

test('a fresh ACP agent cannot prompt an old session ID from disk', async t => {
  const { cwd, store, runtime } = setup(t);
  const first = new AcpAgent({ store, runtime, model: 'mock/Echo', send: () => {} });
  await initialize(first);
  const { sessionId } = await first.handle('session/new', { cwd, mcpServers: [] });
  await first.handle('session/prompt', prompt(sessionId, 'saved'));
  const fresh = new AcpAgent({ store, runtime, model: 'mock/Echo', send: () => {} });
  await initialize(fresh);
  await assert.rejects(fresh.handle('session/prompt', prompt(sessionId, 'replayed')), /created or loaded on this connection/);
});

test('mock ACP errors preserve deterministic status data', async t => {
  const { cwd, store } = setup(t);
  for (const [model, status, message] of [['RateLimit', 429, 'mock rate limit exceeded'], ['ServerError', 503, 'mock temporary server error']]) {
    const agent = new AcpAgent({ store, runtime: { env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => ({}), loadCatalog: async () => [], random: () => 0 }, model: `mock/${model}`, send: () => {} });
    await initialize(agent);
    const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
    await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'test')), error => {
      assert.equal(error.statusCode, status);
      assert.equal(error.data.status, status);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(store.load(sessionId).turns[0].status, 'failed');
  }
});

test('explicit mock ACP selection is fully offline and bypasses config/catalog', async t => {
  const { cwd, store } = setup(t);
  let configCalls = 0; let catalogCalls = 0;
  const agent = new AcpAgent({ store, model: 'mock/Echo', runtime: {
    env: { MINIPLAYER_HOME: cwd },
    loadConfig: async () => { configCalls += 1; throw new Error('config must not be read'); },
    loadCatalog: async () => { catalogCalls += 1; throw new Error('catalog must not be read'); },
  }, send: () => {} });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await agent.handle('session/prompt', prompt(sessionId, 'offline echo'));
  assert.equal(store.load(sessionId).turns[0].output.text, 'offline echo');
  assert.equal(configCalls, 0);
  assert.equal(catalogCalls, 0);
});

test('unknown mock models fail before config or catalog access', async t => {
  const { cwd, store } = setup(t);
  const agent = new AcpAgent({ store, model: 'mock/Unknown', runtime: {
    env: { MINIPLAYER_HOME: cwd }, loadConfig: async () => { throw new Error('config must not be read'); },
    loadCatalog: async () => { throw new Error('catalog must not be read'); },
  }, send: () => {} });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await assert.rejects(agent.handle('session/prompt', prompt(sessionId, 'x')), /Unknown mock model/);
});

test('wire server emits only JSON-RPC, responds to malformed input and stays alive', async t => {
  const { runtime } = setup(t);
  const stdin = new PassThrough(); let output = '';
  const io = { stdin, stdout: { write: chunk => { output += chunk; } }, stderr: { write() {} } };
  const running = serveAcp([], io, runtime);
  stdin.write('{bad json\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
  stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown' }) + '\n');
  stdin.end();
  assert.equal(await running, 0);
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses[0].error.code, -32700);
  assert.equal(responses[1].error.code, -32600);
  assert.equal(responses[1].id, null);
  assert.equal(responses.find(r => r.id === 'init').result.protocolVersion, 1);
  assert.equal(responses.find(r => r.id === 2).error.code, -32601);
});

test('wire request IDs may be reused after the prior request completes', async t => {
  const { cwd, runtime } = setup(t);
  const stdin = new PassThrough(); let output = '';
  const io = { stdin, stdout: { write: chunk => { output += chunk; } }, stderr: { write() {} } };
  const running = serveAcp(['-m', 'mock/Echo'], io, runtime);
  const waitFor = async count => {
    for (let attempt = 0; attempt < 100 && output.trim().split('\n').filter(Boolean).length < count; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const send = message => stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 'same', method: 'initialize', params: { protocolVersion: 1 } });
  await waitFor(1);
  // Reuse the ID on a real request after the first request has completed.
  send({ jsonrpc: '2.0', id: 'same', method: 'initialize', params: { protocolVersion: 1 } });
  await waitFor(2);
  stdin.end();
  await running;
  const responses = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].id, 'same');
  assert.equal(responses[1].id, 'same');
  assert.match(responses[1].error.message, /already initialized/);
});

test('ACP scopes repeated native tool IDs per turn and preserves event timestamps', async t => {
  const calls = [];
  const { cwd, store, agent } = setup(t, async ({ onToolEvent, onResult, record }) => {
    const timestamp = new Date().toISOString();
    onToolEvent?.({ type: 'tool_call', toolName: 'read_file', toolCallId: 'same', timestamp, input: { path: 'x' } });
    onToolEvent?.({ type: 'tool_result', toolName: 'read_file', toolCallId: 'same', timestamp, result: { content: 'x' } });
    const responseId = `response-${calls.length + 1}`; calls.push(responseId);
    const result = { response: { id: responseId, modelId: 'test' }, usage: { inputTokens: 1, outputTokens: 1 }, steps: [{ usage: { inputTokens: 1, outputTokens: 1 }, response: { id: responseId, modelId: 'test' }, toolCalls: [{ toolCallId: 'same', toolName: 'read_file' }] }] };
    onResult?.({ record, result, usageConvention: 'unknown' });
    return 'done';
  });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  await agent.handle('session/prompt', prompt(sessionId, 'one'));
  const first = store.load(sessionId).turns[0];
  const firstId = first.toolEvents[0].toolCallId;
  const firstTimestamp = first.toolEvents[0].timestamp;
  await agent.handle('session/prompt', prompt(sessionId, 'two'));
  const turns = store.load(sessionId).turns;
  assert.notEqual(firstId, turns[1].toolEvents[0].toolCallId);
  assert.equal(firstTimestamp, turns[0].toolEvents[0].timestamp);
  assert.equal(turns[0].modelResponses[0].usageConvention, 'unknown');
});

test('ACP initialize returns protocolVersion 1 and miniplayer version 2.0.0', async t => {
  const { agent } = setup(t);
  const init = await initialize(agent);
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, 'miniplayer');
  assert.equal(init.agentInfo.version, '2.0.0');
});

test('ACP session passes initial system prompt and triggers compaction on long sessions', async t => {
  let lastSystemPrompt;
  const { cwd, store } = setup(t);
  const agent = new AcpAgent({
    store,
    model: 'ollama/test',
    runtime: {
      env: { MINIPLAYER_HOME: cwd },
      loadConfig: async () => ({ compact: { thresholdTokens: 10 } }),
      loadCatalog: async () => [],
      generate: async ({ system, prompt: p }) => {
        if (system) lastSystemPrompt = system;
        if (typeof p === 'string' && p.includes('"summary"') && p.includes('"notes"')) {
          return JSON.stringify({ summary: 'Compacted test summary', notes: 'Durable test notes' });
        }
        return `reply:${p}`;
      },
      random: () => 0,
    },
    send: () => {},
  });
  await initialize(agent);
  const { sessionId } = await agent.handle('session/new', { cwd, mcpServers: [] });
  const live = agent.loaded.get(sessionId);
  assert.ok(live.systemPrompt.includes('You are running in directory:'));

  // Run turns
  await agent.handle('session/prompt', prompt(sessionId, 'turn 1'));
  await agent.handle('session/prompt', prompt(sessionId, 'turn 2'));
  await agent.handle('session/prompt', prompt(sessionId, 'turn 3'));

  // Compaction should have run and live.messages should be compacted
  const messages = live.messages;
  assert.ok(messages.some(m => typeof m.content === 'string' && m.content.startsWith('Context summary:')));
});

