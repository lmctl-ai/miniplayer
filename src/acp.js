import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { generateFromSelection } from './pool.js';
import { SessionStore, sessionHome } from './session-store.js';
import { generateMock, isMockRecord, mockRecord } from './mock.js';

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => new RpcError(-32602, message);

function summarizeToolEvent(event) {
  if (!event || typeof event !== 'object') return { type: 'unknown' };
  const out = { type: event.type ?? event.phase ?? 'tool', ...(event.timestamp ? { timestamp: event.timestamp } : {}) };
  for (const key of ['toolCallId', 'nativeToolCallId', 'toolName', 'name', 'status', 'input', 'args', 'result', 'error']) {
    if (event[key] !== undefined) out[key] = boundedValue(event[key]);
  }
  return out;
}

function boundedValue(value, limit = 16 * 1024) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[truncated]` : value;
  if (Array.isArray(value)) return value.map(item => boundedValue(item, Math.max(1024, Math.floor(limit / Math.max(1, value.length)))));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const childLimit = ['content', 'body', 'stdout', 'stderr', 'input', 'args'].includes(key) ? 8 * 1024 : limit;
      out[key] = boundedValue(item, childLimit);
    }
    try {
      if (JSON.stringify(out).length <= limit) return out;
      for (const key of ['content', 'body', 'stdout', 'stderr', 'input', 'args']) {
        if (typeof out[key] === 'string' && out[key].length > 1024) out[key] = `${out[key].slice(0, 1024)}…[truncated]`;
      }
      return out;
    } catch { return { summary: '[unserializable]', truncated: true }; }
  }
  return value;
}

function summarizeStep(step, index, context = {}) {
  const metadata = step?.step ? step : {};
  step = metadata.step ?? step;
  const timestamp = metadata.completedAt ?? context.completedAt;
  return {
    responseId: `${context.turnId ?? 'turn'}:step:${index + 1}`,
    index,
    ...(timestamp ? { completedAt: timestamp } : {}),
    ...(metadata.record?.provider || context.provider ? { provider: metadata.record?.provider ?? context.provider } : {}),
    ...(step?.response?.modelId || context.model ? { model: String(step?.response?.modelId ?? context.model) } : {}),
    ...(step?.usage ? { usage: step.usage } : {}),
    ...(metadata.usageConvention ?? context.usageConvention ? { usageConvention: metadata.usageConvention ?? context.usageConvention } : {}),
    ...(Number.isFinite(metadata.cacheWriteInputTokens) ? { cacheWriteInputTokens: metadata.cacheWriteInputTokens } :
      Number.isFinite(step?.providerMetadata?.anthropic?.cacheCreationInputTokens)
        ? { cacheWriteInputTokens: step.providerMetadata.anthropic.cacheCreationInputTokens } : {}),
    ...(step?.response?.id ? { nativeResponseId: String(step.response.id) } : {}),
    ...(Array.isArray(step?.toolCalls) && step.toolCalls.length ? { toolCalls: step.toolCalls.map(call => {
      const native = String(call.toolCallId ?? call.id ?? `${index + 1}`);
      return { ...boundedValue(call), toolCallId: `${context.turnId ?? 'turn'}:step:${index + 1}:${native}`, nativeToolCallId: native };
    }) } : {}),
  };
}

function aggregateUsage(result) {
  if (result?.totalUsage) return result.totalUsage;
  const steps = Array.isArray(result?.steps) ? result.steps.map(step => step?.step ?? step) : [];
  if (!steps.length) return result?.usage ?? null;
  const total = {};
  for (const step of steps) for (const [key, value] of Object.entries(step?.usage ?? {})) {
    if (Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
  }
  return Object.keys(total).length ? total : null;
}

function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw invalid('prompt must be a nonempty content array');
  const text = blocks.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      return `[Resource${typeof block.name === 'string' ? `: ${block.name}` : ''}] ${block.uri}`;
    }
    throw invalid('miniplayer supports text and resource_link content only');
  }).join('\n');
  if (!text.trim()) throw invalid('prompt must not be empty');
  return text;
}

function sessionContext(params) {
  if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd must be an absolute directory path');
  const cwd = resolve(params.cwd);
  if (!statSync(cwd).isDirectory()) throw invalid('cwd must be a directory');
  if (!Array.isArray(params.mcpServers)) throw invalid('mcpServers must be an array');
  if (params.mcpServers.length) throw invalid('miniplayer does not support MCP servers');
  return cwd;
}

export class AcpAgent {
  constructor({ store, runtime, model, send }) {
    Object.assign(this, { store, runtime, model, send });
    this.initialized = false;
    this.loaded = new Map();
    this.active = new Map();
    this.mockState = new Map();
  }
  update(sessionId, role, text) {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text } },
    } });
  }
  toolUpdate(sessionId, event) {
    const id = event?.toolCallId ?? event?.id;
    const name = event?.toolName ?? event?.name ?? event?.tool ?? 'tool';
    const kind = { list_directory: 'search', read_file: 'read', write_file: 'edit', shell: 'execute', webget: 'fetch' }[name] ?? 'execute';
    const input = event?.input ?? event?.args;
    const finished = event?.type === 'tool_result' || event?.phase === 'finished' || event?.status === 'completed' || event?.status === 'failed'
      || (event?.tool && (event.result !== undefined || event.error !== undefined));
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
      sessionUpdate: finished ? 'tool_call_update' : 'tool_call',
      toolCallId: typeof id === 'string' ? id : undefined,
      kind,
      title: name,
      ...(input !== undefined ? { rawInput: input } : {}),
      status: finished ? (event.status === 'failed' ? 'failed' : 'completed') : 'in_progress',
      ...(finished ? { ...(event.result !== undefined ? { rawOutput: event.result } : {}) } : {}),
    } } });
  }
  async handle(method, params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
    if (method === 'initialize') {
      if (this.initialized) throw invalid('connection is already initialized');
      if (!Number.isInteger(params.protocolVersion) || params.protocolVersion < 1) throw invalid('protocolVersion must be a positive integer');
      this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'miniplayer', version: '1.0.0' },
        agentCapabilities: { loadSession: false, promptCapabilities: {}, sessionCapabilities: {} }, authMethods: [] };
    }
    if (!this.initialized) throw new RpcError(-32000, 'initialize is required');
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'session/cancel') {
      this.active.get(params.sessionId)?.abort();
      return;
    }
    if (method === 'session/new') {
      const session = this.store.create(sessionContext(params), this.model);
      this.loaded.set(session.id, { cwd: session.cwd, messages: [] });
      return { sessionId: session.id };
    }
    if (method === 'session/load' || method === 'session/resume') throw invalid('miniplayer does not support session resume; create a new session');
    if (method === 'session/prompt') return this.prompt(params);
    throw new RpcError(-32601, `Method not found: ${method}`);
  }
  async prompt(params) {
    const text = promptText(params.prompt);
    const live = this.loaded.get(params.sessionId);
    if (!live) throw invalid('session must be created or loaded on this connection before prompting');
    if (this.active.has(params.sessionId)) throw new RpcError(-32000, 'session has an active prompt');
    const release = this.store.lock(params.sessionId);
    const controller = new AbortController();
    let providerResult;
    const toolEvents = [];
    const stepRecords = [];
    this.active.set(params.sessionId, controller);
    try {
      const session = this.store.load(params.sessionId);
      if (session.cwd !== live.cwd) throw invalid('session working directory changed');
      const selector = this.model ?? session.requestedModel;
      const mock = mockRecord(selector);
      if (typeof selector === 'string' && selector.startsWith('mock/') && !mock) {
        throw invalid(`Unknown mock model "${selector.slice('mock/'.length)}"`);
      }
      controller.signal.throwIfAborted();
      const config = mock ? undefined : await this.runtime.loadConfig(undefined, this.runtime.env);
      const records = mock ? undefined : await this.runtime.loadCatalog();
      const startedAt = new Date().toISOString();
      const startedTurn = { responseId: randomUUID(), startedAt, status: 'running', input: { text } };
      this.store.save({ ...session, updatedAt: startedAt, turns: [...session.turns, startedTurn] });
      let reply;
      if (isMockRecord(mock)) {
        reply = await generateMock({ record: mock, prompt: text, signal: controller.signal,
          state: this.mockState.get(params.sessionId) ?? 0,
          onResult: value => { providerResult = value; } });
      } else {
        const messages = [...live.messages, { role: 'user', content: text }];
        const persistProgress = () => {
          try {
            const current = this.store.load(params.sessionId);
            const running = current.turns.at(-1);
            if (!running || running.status !== 'running') return;
            const context = { turnId: running.responseId, model: selector };
            this.store.save({ ...current, updatedAt: new Date().toISOString(), turns: [...current.turns.slice(0, -1), {
              ...running,
              ...(stepRecords.length ? { modelResponses: stepRecords.map((step, index) => summarizeStep(step, index, context)) } : {}),
              ...(toolEvents.length ? { toolEvents: toolEvents.map(summarizeToolEvent) } : {}),
            }] });
          } catch { /* progress persistence must not interrupt the provider turn */ }
        };
        reply = await generateFromSelection({
          explicitSelector: selector, config, records, prompt: text, messages, signal: controller.signal, timeoutMs: 0,
          env: this.runtime.env, random: this.runtime.random, generate: this.runtime.generate,
          debug: this.runtime.debug, warn: this.runtime.warn,
          cwd: live.cwd,
          onToolEvent: event => {
            if (event?.type === 'step_finish' && event.step) {
              stepRecords.push({ ...event, completedAt: event.completedAt ?? new Date().toISOString() });
            } else {
              const native = event?.toolCallId ? String(event.toolCallId) : `generated-${toolEvents.length + 1}`;
              const stepIndex = stepRecords.length + 1;
              const scoped = { ...event, timestamp: event.timestamp ?? new Date().toISOString(), toolCallId: `${startedTurn.responseId}:step:${stepIndex}:${native}`, ...(event?.toolCallId ? { nativeToolCallId: native } : {}) };
              toolEvents.push(scoped);
              this.toolUpdate(session.id, scoped);
            }
            persistProgress();
          },
          onResult: value => { providerResult = value; },
        });
      }
      controller.signal.throwIfAborted();
      if (typeof reply !== 'string') throw new Error('Provider did not return text');
      const completedAt = new Date().toISOString();
      const record = providerResult?.record;
      const result = providerResult?.result;
      const selectedModel = record?.vendor_model_id ?? record?.gateway_id ?? record?.source_model_id ?? selector;
      const model = result?.response?.modelId ?? selectedModel;
      const usage = aggregateUsage(result);
      const nativeResponseId = result?.response?.id ?? result?.response?.requestId;
      const stepContext = { turnId: startedTurn.responseId, provider: record?.provider, model, usageConvention: providerResult?.usageConvention, cacheWriteInputTokens: providerResult?.cacheWriteInputTokens };
      const turn = { ...startedTurn, completedAt, status: 'complete', output: { text: reply },
        ...(nativeResponseId ? { nativeResponseId: String(nativeResponseId) } : {}),
        ...(record?.provider ? { provider: record.provider } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}),
        ...(providerResult?.usageConvention ? { usageConvention: providerResult.usageConvention } : {}),
        ...(providerResult?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: providerResult.cacheWriteInputTokens } : {}),
        ...(toolEvents.length ? { toolEvents: toolEvents.map(summarizeToolEvent) } : {}),
        ...((stepRecords.length || result?.steps?.length) ? { modelResponses: (stepRecords.length ? stepRecords : result.steps).map((step, index) => summarizeStep(step, index, stepContext)) } : {}) };
      // Persist metadata only. Live conversation context stays in memory and is never reloaded.
      const latest = this.store.load(params.sessionId);
      this.store.save({ ...latest, ...(record?.provider ? { provider: record.provider } : {}), ...(model ? { model } : {}),
        updatedAt: completedAt, turns: [...latest.turns.slice(0, -1), turn] });
      if (isMockRecord(mock)) this.mockState.set(params.sessionId, providerResult?.nextState ?? 0);
      live.messages.push({ role: 'user', content: text });
      if (Array.isArray(providerResult?.messages) && providerResult.messages.length) live.messages.push(...providerResult.messages);
      else live.messages.push({ role: 'assistant', content: reply });
      this.update(session.id, 'assistant', reply);
      return { stopReason: 'end_turn' };
    } catch (error) {
      const endedAt = new Date().toISOString();
      const current = this.store.load(params.sessionId);
      const turn = current.turns.at(-1);
      if (turn?.status === 'running') {
        const result = providerResult?.result;
        const record = providerResult?.record;
        const nativeResponseId = result?.response?.id ?? result?.response?.requestId;
        const usage = aggregateUsage(result) ?? (stepRecords.length ? aggregateUsage({ steps: stepRecords }) : undefined);
        const selectedModel = record?.vendor_model_id ?? record?.gateway_id ?? record?.source_model_id;
        this.store.save({ ...current, ...(record?.provider ? { provider: record.provider } : {}),
          ...((result?.response?.modelId ?? selectedModel) ? { model: result?.response?.modelId ?? selectedModel } : {}), updatedAt: endedAt,
          turns: [...current.turns.slice(0, -1), { ...turn, endedAt,
            status: controller.signal.aborted ? 'aborted' : 'failed',
            ...(nativeResponseId ? { nativeResponseId: String(nativeResponseId) } : {}),
            ...(record?.provider ? { provider: record.provider } : {}), ...((result?.response?.modelId ?? selectedModel) ? { model: result?.response?.modelId ?? selectedModel } : {}),
            ...(usage ? { usage } : {}), ...(providerResult?.usageConvention ? { usageConvention: providerResult.usageConvention } : {}),
            ...(providerResult?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: providerResult.cacheWriteInputTokens } : {}),
            ...(toolEvents.length ? { toolEvents: toolEvents.map(summarizeToolEvent) } : {}),
            ...((stepRecords.length || providerResult?.result?.steps?.length) ? { modelResponses: (stepRecords.length ? stepRecords : providerResult.result.steps).map((step, index) => summarizeStep(step, index, { turnId: turn.responseId, provider: record?.provider, model: result?.response?.modelId ?? selectedModel, usageConvention: providerResult?.usageConvention })) } : {}),
            ...((toolEvents.length || stepRecords.length || providerResult?.result?.steps?.length) ? { partial: true } : {}) }] });
      }
      const completedMessages = stepRecords.flatMap(entry => Array.isArray(entry?.step?.response?.messages) ? entry.step.response.messages : []);
      if (completedMessages.length) live.messages.push({ role: 'user', content: text }, ...completedMessages);
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      this.active.delete(params.sessionId);
      release();
    }
  }
  close() { for (const controller of this.active.values()) controller.abort(); }
}

export async function serveAcp(args, io, runtime) {
  let model;
  for (let i = 0; i < args.length; i++) {
    if (['-m', '--model'].includes(args[i])) {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('Usage: miniplayer acp [-m|--model <selector>]');
      model = args[++i];
    } else throw new Error('Usage: miniplayer acp [-m|--model <selector>]');
  }
  const send = message => io.stdout.write(JSON.stringify(message) + '\n');
  const agent = new AcpAgent({ store: new SessionStore(sessionHome(runtime.env)), runtime, model, send });
  const pending = new Set();
  const ids = new Set();
  const input = createInterface({ input: io.stdin, crlfDelay: Infinity });
  const stop = () => { agent.close(); input.close(); io.stdin.pause?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const errorResponse = (id, error) => send({ jsonrpc: '2.0', id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.message ?? String(error), ...(error.data ? { data: error.data } : {}) } });
  try {
    for await (const line of input) {
      let message;
      try { message = JSON.parse(line); }
      catch { errorResponse(null, new RpcError(-32700, 'Parse error')); continue; }
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string'
        || (message.id !== undefined && typeof message.id !== 'string' && !Number.isInteger(message.id))) {
        errorResponse(null, new RpcError(-32600, 'Invalid request')); continue;
      }
      const hasId = message.id !== undefined;
      if (!hasId && !['session/cancel', 'initialized', 'notifications/initialized'].includes(message.method)) {
        runtime.debug?.(`Ignoring request-only method without ID: ${message.method}`);
        continue;
      }
      if (hasId && ids.has(message.id)) { errorResponse(message.id, invalid('request ID is already in flight')); continue; }
      if (hasId) ids.add(message.id);
      const task = agent.handle(message.method, message.params).then(
        result => { if (hasId) send({ jsonrpc: '2.0', id: message.id, result: result ?? {} }); },
        error => { if (hasId) errorResponse(message.id, error); else runtime.debug?.(error.message); },
      ).finally(() => { pending.delete(task); if (hasId) ids.delete(message.id); });
      pending.add(task);
    }
  } finally {
    agent.close();
    await Promise.allSettled([...pending]);
    input.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
  return 0;
}
