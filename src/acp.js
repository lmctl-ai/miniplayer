import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { generateFromSelection } from './pool.js';
import { SessionStore, sessionHome } from './session-store.js';

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const invalid = message => new RpcError(-32602, message);

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
  if (params.mcpServers.length) throw invalid('miniplayer is text-only; MCP servers are not supported');
  return cwd;
}

/** Basic ACP conversation server; it cannot run tools, terminals or filesystem requests. */
export class AcpAgent {
  constructor({ store, runtime, model, send }) {
    Object.assign(this, { store, runtime, model, send });
    this.initialized = false;
    this.loaded = new Map();
    this.active = new Map();
  }
  update(sessionId, role, text) {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: { type: 'text', text } },
    } });
  }
  async handle(method, params = {}) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
    if (method === 'initialize') {
      if (this.initialized) throw invalid('connection is already initialized');
      if (!Number.isInteger(params.protocolVersion) || params.protocolVersion < 1) throw invalid('protocolVersion must be a positive integer');
      this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'miniplayer', version: '1.0.0' },
        agentCapabilities: { loadSession: true, promptCapabilities: {}, sessionCapabilities: { resume: {} } }, authMethods: [] };
    }
    if (!this.initialized) throw new RpcError(-32000, 'initialize is required');
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'session/cancel') {
      this.active.get(params.sessionId)?.abort();
      return;
    }
    if (method === 'session/new') {
      const session = this.store.create(sessionContext(params), this.model);
      this.loaded.set(session.id, session.cwd);
      return { sessionId: session.id };
    }
    if (method === 'session/load' || method === 'session/resume') {
      const cwd = sessionContext(params);
      if (this.active.has(params.sessionId)) throw new RpcError(-32000, 'session has an active prompt');
      const session = this.store.load(params.sessionId);
      if (session.cwd !== cwd) throw invalid('session belongs to a different working directory');
      this.loaded.set(session.id, cwd);
      if (method === 'session/load') for (const message of session.messages) this.update(session.id, message.role, message.content);
      return { sessionId: session.id };
    }
    if (method === 'session/prompt') return this.prompt(params);
    throw new RpcError(-32601, `Method not found: ${method}`);
  }
  async prompt(params) {
    const text = promptText(params.prompt);
    const cwd = this.loaded.get(params.sessionId);
    if (!cwd) throw invalid('session must be created or loaded on this connection before prompting');
    if (this.active.has(params.sessionId)) throw new RpcError(-32000, 'session has an active prompt');
    const release = this.store.lock(params.sessionId);
    const controller = new AbortController();
    this.active.set(params.sessionId, controller);
    try {
      // Reload under the lease: another connection may have appended since load.
      const session = this.store.load(params.sessionId);
      if (session.cwd !== cwd) throw invalid('session working directory changed');
      const config = await this.runtime.loadConfig(undefined, this.runtime.env);
      const records = await this.runtime.loadCatalog();
      controller.signal.throwIfAborted();
      const messages = [...session.messages.map(({ role, content }) => ({ role, content })), { role: 'user', content: text }];
      const selector = this.model ?? session.model;
      const reply = await generateFromSelection({
        explicitSelector: selector, config, records, messages, signal: controller.signal, timeoutMs: 0,
        env: this.runtime.env, random: this.runtime.random, generate: this.runtime.generate,
        debug: this.runtime.debug, warn: this.runtime.warn,
      });
      controller.signal.throwIfAborted();
      if (typeof reply !== 'string') throw new Error('Provider did not return text');
      const now = new Date().toISOString();
      // Commit and publish synchronously: cancel cannot interleave halfway through.
      this.store.save({ ...session, ...(selector ? { model: selector } : {}), updatedAt: now,
        messages: [...session.messages, { role: 'user', content: text, timestamp: now }, { role: 'assistant', content: reply, timestamp: now }] });
      this.update(session.id, 'assistant', reply);
      return { stopReason: 'end_turn' };
    } catch (error) {
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
    if (!['-m', '--model'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('-')) throw new Error('Usage: miniplayer acp [-m <selector>]');
    model = args[++i];
  }
  const send = message => io.stdout.write(JSON.stringify(message) + '\n');
  const agent = new AcpAgent({ store: new SessionStore(sessionHome(runtime.env)), runtime, model, send });
  const pending = new Set();
  const ids = new Set();
  const input = createInterface({ input: io.stdin, crlfDelay: Infinity });
  const stop = () => { agent.close(); input.close(); io.stdin.pause?.(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const errorResponse = (id, error) => send({ jsonrpc: '2.0', id, error: { code: Number.isInteger(error.code) ? error.code : -32000, message: error.message ?? String(error) } });
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
