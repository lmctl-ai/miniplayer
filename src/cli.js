import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';

import { serveAcp } from './acp.js';
import { loadCatalog, listChatModels, modelListId } from './catalog.js';
import { buildClassificationPrompt, parseClassificationOutput } from './classifier.js';
import { loadConfig } from './config.js';
import { MiniplayerError } from './errors.js';
import { generateOneShot, knownProviderRoutes } from './providers.js';
import { generateMock, isMockRecord, mockRecord } from './mock.js';
import { generateFromSelection } from './pool.js';
import { buildInitialSystemPrompt } from './prompt-builder.js';
import { compactSessionContext } from './compaction.js';
import { randomUUID } from 'node:crypto';
import { SessionStore, sessionHome, historyMessages } from './session-store.js';
import { resolveVersionDisplay } from './version.js';

export const WRAP_UP_PROMPT =
  "Before exiting: if this session produced durable knowledge (decisions, conventions, pitfalls, state of work), update durable-memory/ (add or edit a note file and keep durable-memory/index.md as a one-line-per-note table of contents; update AGENTS.md only if a standing instruction changed). If nothing durable, reply 'nothing to update'.";

export const HELP = `Usage:
  miniplayer [chat] [-m|--model <selector>] [--wrapup|--no-wrapup]
  miniplayer acp [-m|--model <selector>]
  miniplayer run [-m|--model <selector>] [--wrapup|--no-wrapup] [--session new|<id>] [--json] [prompt]
  miniplayer classify -m <selector> [--file <path>]
  miniplayer models [--routed] [--source openrouter|litellm] [--provider <name>] [--max-input-price <number>] [--json]
  miniplayer providers [--json]
  miniplayer --version
  miniplayer --help

Prompts and classification input default to stdin. Without -m, a configured or built-in pool is used.
Zero config: export the provider's key (miniplayer providers shows which) and run -m <provider>/<model>.
Tools are configured via ~/.config/miniplayer/config.json ("tools" array).
`;

export function formatToolTrace(event) {
  const name = event?.toolName || event?.name || 'tool';
  const args = Array.isArray(event?.input?.args) ? event.input.args : [];
  const rendered = args.map(a => {
    const s = String(a);
    return s.length > 40 ? `${s.slice(0, 37)}...` : s;
  }).join(' ');
  return `[tool] ${name}${rendered ? ` ${rendered}` : ''}\n`;
}

function takeOption(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new MiniplayerError(`Option ${name} requires a value`);
  }
  return value;
}

function parseRunArgs(args) {
  let model;
  let wrapUp;
  let file;
  let system;
  let systemFile;
  let compact = false;
  let session;
  let json = false;
  const prompt = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      prompt.push(...args.slice(index + 1));
      break;
    } else if (arg === '-m' || arg === '--model') {
      model = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--file') {
      file = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system') {
      system = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system-file') {
      systemFile = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--session') {
      session = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--compact') {
      compact = true;
    } else if (arg === '--wrapup') {
      wrapUp = true;
    } else if (arg === '--no-wrapup') {
      wrapUp = false;
    } else if (arg.startsWith('-')) {
      throw new MiniplayerError(`Unknown option for run: ${arg}`);
    } else {
      prompt.push(arg);
    }
  }
  return { model, wrapUp, file, system, systemFile, compact, session, json, prompt: prompt.join(' ') };
}

function parseChatArgs(args) {
  let model;
  let wrapUp;
  let system;
  let systemFile;
  let contextFiles;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--model') {
      model = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system') {
      system = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system-file') {
      systemFile = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--context-files') {
      contextFiles = true;
    } else if (arg === '--no-context-files') {
      contextFiles = false;
    } else if (arg === '--wrapup') {
      wrapUp = true;
    } else if (arg === '--no-wrapup') {
      wrapUp = false;
    } else {
      throw new MiniplayerError(`Unknown option for chat: ${arg}`);
    }
  }
  return { model, wrapUp, system, systemFile, contextFiles };
}

function parseModelsArgs(args) {
  const filters = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--source') {
      filters.source = takeOption(args, index, arg);
      if (!['openrouter', 'litellm'].includes(filters.source)) {
        throw new MiniplayerError('--source must be openrouter or litellm');
      }
      index += 1;
    } else if (arg === '--provider') {
      filters.provider = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--routed') {
      filters.routed = true;
    } else if (arg === '--json') {
      filters.json = true;
    } else if (arg === '--max-input-price') {
      const raw = takeOption(args, index, arg);
      filters.maxInputPrice = Number(raw);
      if (!Number.isFinite(filters.maxInputPrice) || filters.maxInputPrice < 0) {
        throw new MiniplayerError('--max-input-price must be a non-negative number');
      }
      index += 1;
    } else {
      throw new MiniplayerError(`Unknown option for models: ${arg}`);
    }
  }
  return filters;
}

function parseClassifyArgs(args) {
  let model;
  let file;
  let system;
  let systemFile;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--model') {
      model = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--file') {
      file = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system') {
      system = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--system-file') {
      systemFile = takeOption(args, index, arg);
      index += 1;
    } else {
      throw new MiniplayerError(`Unknown option for classify: ${arg}`);
    }
  }
  return { model, file, system, systemFile };
}

async function readStdin(stream) {
  let input = '';
  for await (const chunk of stream) input += chunk;
  return input;
}

function requireText(text, purpose) {
  if (!text || text.trim().length === 0) {
    throw new MiniplayerError(`${purpose} must not be empty`);
  }
  return text;
}

function formatCell(value) {
  return value === null || value === undefined ? '-' : String(value);
}

export function formatModelTable(records) {
  const rows = [['id', 'provider', 'context_total', 'input_per_1m', 'output_per_1m']];
  for (const record of records) {
    rows.push([
      record.miniplayer?.id ?? modelListId(record),
      record.provider,
      record.context_window?.total_tokens,
      record.pricing?.input_per_1m_tokens,
      record.pricing?.output_per_1m_tokens,
    ]);
  }
  return `${rows.map((row) => row.map(formatCell).join('\t')).join('\n')}\n`;
}

async function runCommand(args, io, runtime, preloadedPrompt) {
  const options = parseRunArgs(args);
  let rawPrompt;
  if (options.file) {
    try {
      rawPrompt = await readFile(options.file, 'utf8');
    } catch (err) {
      throw new MiniplayerError(`Unable to read prompt file ${options.file}: ${err.message}`);
    }
  } else {
    rawPrompt = options.prompt || preloadedPrompt || await readStdin(io.stdin);
  }
  const prompt = requireText(rawPrompt, 'Prompt');
  if (options.json && !options.session) throw new MiniplayerError('--json requires --session');
  const mock = mockRecord(options.model);
  if (options.session && mock) throw new MiniplayerError('--session does not support mock models');
  if (typeof options.model === 'string' && options.model.startsWith('mock/') && !mock) {
    throw new MiniplayerError(`Unknown mock model "${options.model.slice('mock/'.length)}"`);
  }

  const config = isMockRecord(mock) ? {} : (await runtime.loadConfig(undefined, runtime.env) ?? {});
  const shouldWrapUp = options.wrapUp === true;

  let systemPrompt;
  if (options.system) {
    systemPrompt = options.system;
  } else if (options.systemFile) {
    try {
      systemPrompt = await readFile(options.systemFile, 'utf8');
    } catch (err) {
      throw new MiniplayerError(`Unable to read system prompt file ${options.systemFile}: ${err.message}`);
    }
  }

  if (isMockRecord(mock)) {
    const text = await generateMock({ record: mock, prompt });
    io.stdout.write(text);
    if (shouldWrapUp) {
      try {
        const wrapUpText = await generateMock({ record: mock, prompt: WRAP_UP_PROMPT });
        if (wrapUpText) io.stdout.write(wrapUpText.endsWith('\n') ? wrapUpText : `${wrapUpText}\n`);
      } catch (wrapErr) {
        io.stderr.write(`wrap-up error: ${wrapErr.message}\n`);
      }
    }
    return 0;
  }

  const records = await runtime.loadCatalog();

  let stored;
  if (options.session) {
    const store = new SessionStore(sessionHome(runtime.env));
    const session = options.session === 'new' ? store.create(process.cwd(), options.model) : store.load(options.session);
    if (session.cwd !== process.cwd()) throw new MiniplayerError(`session ${session.id} belongs to ${session.cwd}, not ${process.cwd()}`);
    stored = { store, session, release: store.lock(session.id) };
  }
  let providerResult;
  let text;
  try {
    const startedAt = new Date().toISOString();
    text = await generateFromSelection({
      explicitSelector: options.model,
      config,
      records,
      prompt,
      ...(stored ? { messages: [...historyMessages(stored.session), { role: 'user', content: prompt }] } : {}),
      system: systemPrompt,
      tools: {}, // pure run: NO tools
      env: runtime.env,
      random: runtime.random,
      generate: runtime.generate,
      debug: runtime.debug,
      warn: runtime.warn,
      cwd: process.cwd(),
      onResult: value => { providerResult = value; },
    });
    if (stored) {
      const record = providerResult?.record;
      const result = providerResult?.result;
      const model = result?.response?.modelId ?? record?.vendor_model_id ?? record?.gateway_id ?? record?.source_model_id ?? options.model;
      const usage = result?.totalUsage ?? result?.usage;
      const nativeResponseId = result?.response?.id ?? result?.response?.requestId;
      const turn = { responseId: randomUUID(), startedAt, completedAt: new Date().toISOString(), status: 'complete',
        input: { text: prompt }, output: { text },
        ...(nativeResponseId ? { nativeResponseId: String(nativeResponseId) } : {}),
        ...(record?.provider ? { provider: record.provider } : {}), ...(model ? { model } : {}), ...(usage ? { usage } : {}),
        ...(providerResult?.usageConvention ? { usageConvention: providerResult.usageConvention } : {}),
        ...(providerResult?.cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens: providerResult.cacheWriteInputTokens } : {}) };
      stored.store.save({ ...stored.session, ...(record?.provider ? { provider: record.provider } : {}), ...(model ? { model } : {}),
        updatedAt: turn.completedAt, turns: [...stored.session.turns, turn] });
    }
  } finally { stored?.release(); }
  if (options.json) io.stdout.write(`${JSON.stringify({ sessionId: stored.session.id, text })}\n`);
  else io.stdout.write(text);
  if (stored && !options.json) io.stderr.write(`session: ${stored.session.id}\n`);

  if (shouldWrapUp) {
    try {
      const wrapUpReply = await generateFromSelection({
        explicitSelector: options.model,
        config,
        records,
        prompt: WRAP_UP_PROMPT,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: text },
          { role: 'user', content: WRAP_UP_PROMPT },
        ],
        system: systemPrompt,
        tools: {},
        cwd: process.cwd(),
        env: runtime.env,
        random: runtime.random,
        generate: runtime.generate,
        debug: runtime.debug,
        warn: runtime.warn,
      });
      if (wrapUpReply) {
        io.stdout.write(wrapUpReply.endsWith('\n') ? wrapUpReply : `${wrapUpReply}\n`);
      }
    } catch (wrapErr) {
      io.stderr.write(`wrap-up error: ${wrapErr.message}\n`);
    }
  }

  return 0;
}

async function chatCommand(args, io, runtime) {
  const options = parseChatArgs(args);
  const mock = mockRecord(options.model);
  if (typeof options.model === 'string' && options.model.startsWith('mock/') && !mock) {
    throw new MiniplayerError(`Unknown mock model "${options.model.slice('mock/'.length)}"`);
  }

  let config = {};
  try {
    config = (await runtime.loadConfig(undefined, runtime.env)) ?? {};
  } catch (err) {
    if (!isMockRecord(mock)) throw err;
  }
  const records = mock ? [] : (await runtime.loadCatalog?.()?.catch?.(() => []) ?? []);
  let systemPrompt;
  if (options.system) {
    systemPrompt = options.system;
  } else if (options.systemFile) {
    try {
      systemPrompt = await readFile(options.systemFile, 'utf8');
    } catch (err) {
      throw new MiniplayerError(`Unable to read system prompt file ${options.systemFile}: ${err.message}`);
    }
  } else {
    const includeContextFiles = options.contextFiles !== undefined
      ? options.contextFiles
      : (config.contextFiles !== false);
    systemPrompt = await buildInitialSystemPrompt({
      cwd: process.cwd(),
      toolsConfig: config?.tools,
      includeContextFiles,
      env: runtime.env,
      stderr: io.stderr,
      warn: runtime.warn,
    });
  }

  const shouldWrapUp = options.wrapUp !== undefined ? options.wrapUp : (config.wrapUp !== false);

  const messages = [];
  let lastUsage = null;
  let currentController = null;
  let selectedRecord = isMockRecord(mock) ? mock : null;

  const hasTTYOutput = Boolean(io.stdin?.isTTY && typeof io.stdout?.on === 'function');
  const rl = createInterface({
    input: io.stdin,
    output: hasTTYOutput ? io.stdout : undefined,
    prompt: '> ',
    terminal: hasTTYOutput,
  });

  const promptUser = () => {
    if (io.stdin?.isTTY) {
      if (hasTTYOutput) rl.prompt();
      else io.stdout.write('> ');
    }
  };

  const onSigInt = () => {
    if (currentController) {
      currentController.abort();
    } else {
      rl.close();
    }
  };
  if (hasTTYOutput) {
    rl.on('SIGINT', onSigInt);
  } else {
    process.on('SIGINT', onSigInt);
  }

  const runCompaction = async (msgList, customConfig = config) => {
    return compactSessionContext({
      messages: msgList,
      record: selectedRecord,
      config: customConfig,
      cwd: process.cwd(),
      env: runtime.env,
      generate: async ({ prompt, signal }) => {
        if (isMockRecord(mock)) {
          return generateMock({ record: mock, prompt, signal });
        }
        return generateFromSelection({
          explicitSelector: options.model,
          config,
          records,
          prompt,
          system: undefined,
          signal,
          timeoutMs: 0,
          cwd: process.cwd(),
          env: runtime.env,
          random: runtime.random,
          generate: runtime.generate,
          debug: runtime.debug,
          warn: runtime.warn,
          tools: {}, // NO tools for compaction
        });
      },
      stderr: io.stderr,
      warn: runtime.warn,
      lastUsage,
    });
  };

  try {
    promptUser();
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) {
        promptUser();
        continue;
      }
      if (line === '/exit') {
        break;
      }
      if (line === '/help') {
        io.stdout.write(
          'Commands:\n' +
          '  /exit     Exit the session (runs wrap-up)\n' +
          '  /compact  Compact conversation history\n' +
          '  /help     Show this help\n'
        );
        promptUser();
        continue;
      }
      if (line === '/compact') {
        const compactRes = await runCompaction(messages, { compact: { thresholdTokens: 0 } });
        if (compactRes.compacted) {
          messages.length = 0;
          messages.push(...compactRes.messages);
        }
        promptUser();
        continue;
      }

      // Check compaction before request
      let candidateMessages = [...messages, { role: 'user', content: line }];
      const compactRes = await runCompaction(candidateMessages);
      if (compactRes.compacted) {
        candidateMessages = compactRes.messages;
        messages.length = 0;
        messages.push(...compactRes.messages.slice(0, -1));
      }

      currentController = new AbortController();
      let reply;
      let providerResult;

      try {
        if (isMockRecord(mock)) {
          reply = await generateMock({
            record: mock,
            prompt: line,
            signal: currentController.signal,
            onResult: (val) => { providerResult = val; },
          });
        } else {
          reply = await generateFromSelection({
            explicitSelector: options.model,
            config,
            records,
            prompt: line,
            messages: candidateMessages,
            system: systemPrompt,
            signal: currentController.signal,
            timeoutMs: 0,
            cwd: process.cwd(),
            env: runtime.env,
            random: runtime.random,
            generate: runtime.generate,
            debug: runtime.debug,
            warn: runtime.warn,
            onToolEvent: (event) => {
              if (event?.type === 'tool_call') {
                io.stderr.write(formatToolTrace(event));
              }
            },
            onResult: (val) => { providerResult = val; },
          });
        }

        io.stdout.write(reply.endsWith('\n') ? reply : `${reply}\n`);
        messages.push({ role: 'user', content: line });
        if (Array.isArray(providerResult?.messages) && providerResult.messages.length) {
          messages.push(...providerResult.messages);
        } else {
          messages.push({ role: 'assistant', content: reply });
        }
        if (providerResult?.record) {
          selectedRecord = providerResult.record;
        }
        lastUsage = providerResult?.result?.usage;
      } catch (turnErr) {
        if (currentController.signal.aborted) {
          io.stderr.write('turn cancelled\n');
        } else {
          io.stderr.write(`error: ${turnErr.message}\n`);
        }
      } finally {
        currentController = null;
      }

      promptUser();
    }
  } finally {
    if (hasTTYOutput) {
      rl.removeListener('SIGINT', onSigInt);
    } else {
      process.removeListener('SIGINT', onSigInt);
    }
    rl.close();
  }

  // Wrap-up turn on exit or EOF
  if (shouldWrapUp && messages.length > 0) {
    try {
      let wrapUpReply;
      if (isMockRecord(mock)) {
        wrapUpReply = await generateMock({ record: mock, prompt: WRAP_UP_PROMPT });
      } else {
        wrapUpReply = await generateFromSelection({
          explicitSelector: options.model,
          config,
          records,
          prompt: WRAP_UP_PROMPT,
          messages: [...messages, { role: 'user', content: WRAP_UP_PROMPT }],
          system: systemPrompt,
          cwd: process.cwd(),
          env: runtime.env,
          random: runtime.random,
          generate: runtime.generate,
          debug: runtime.debug,
          warn: runtime.warn,
          onToolEvent: (event) => {
            if (event?.type === 'tool_call') {
              io.stderr.write(formatToolTrace(event));
            }
          },
        });
      }
      if (wrapUpReply) {
        io.stdout.write(wrapUpReply.endsWith('\n') ? wrapUpReply : `${wrapUpReply}\n`);
      }
    } catch (wrapErr) {
      io.stderr.write(`wrap-up error: ${wrapErr.message}\n`);
    }
  }

  return 0;
}

/** Whether a key env var is set right now: yes / no, or keyless. Never the value. */
function keyState(keyEnv, env) {
  if (keyEnv === null || keyEnv === undefined) return 'keyless';
  return env[keyEnv] ? 'yes' : 'no';
}

function byText(key) {
  return (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
}

async function modelsCommand(args, io, runtime) {
  const filters = parseModelsArgs(args);
  const records = await runtime.loadCatalog();
  if (filters.routed) {
    const routes = records
      .filter((record) => record.miniplayer?.id && record.mode === 'chat')
      .map((record) => ({ ...record.miniplayer, key_set: keyState(record.miniplayer.key_env, runtime.env) }))
      .filter((route) => !filters.provider || route.provider === filters.provider)
      .sort(byText('id'));
    if (filters.json) {
      io.stdout.write(`${JSON.stringify(routes)}\n`);
    } else {
      const lines = ['id\tprovider\tkey_set', ...routes.map((r) => `${r.id}\t${r.provider}\t${r.key_set}`)];
      io.stdout.write(`${lines.join('\n')}\n`);
    }
    return 0;
  }
  const models = listChatModels(records, filters);
  if (filters.json) {
    io.stdout.write(`${JSON.stringify(models.map((record) => ({
      id: record.miniplayer?.id ?? modelListId(record),
      provider: record.provider,
      context_total: record.context_window?.total_tokens ?? null,
      input_per_1m: record.pricing?.input_per_1m_tokens ?? null,
      output_per_1m: record.pricing?.output_per_1m_tokens ?? null,
    })))}\n`);
    return 0;
  }
  io.stdout.write(formatModelTable(models));
  return 0;
}

async function providersCommand(args, io, runtime) {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else throw new MiniplayerError(`Unknown option for providers: ${arg}`);
  }
  // Without a catalog (offline, no cache) the built-in table still answers.
  let records = [];
  try {
    records = await runtime.loadCatalog();
  } catch (error) {
    runtime.warn(`catalog unavailable (${error.message}); showing built-in providers only`);
  }
  const providers = [...knownProviderRoutes(records).values()]
    .map((route) => ({ ...route, key_set: keyState(route.key_env, runtime.env) }))
    .sort(byText('provider'));
  if (json) {
    io.stdout.write(`${JSON.stringify(providers.map(({ provider, sdk, base_url, key_env, key_set, source }) => (
      { provider, sdk, base_url, key_env, key_set, source })))}\n`);
    return 0;
  }
  const lines = ['provider\tsdk\tbase_url\tkey_env\tkey_set\tsource', ...providers.map((p) =>
    [p.provider, p.sdk, p.base_url ?? '-', p.key_env ?? '-', p.key_set, p.source].join('\t'))];
  io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function classifyCommand(args, io, runtime) {
  const options = parseClassifyArgs(args);
  const config = await runtime.loadConfig(undefined, runtime.env);
  let responseText;
  if (options.file) {
    try {
      responseText = await readFile(options.file, 'utf8');
    } catch (error) {
      throw new MiniplayerError(`Unable to read classification input ${options.file}: ${error.message}`);
    }
  } else {
    responseText = await readStdin(io.stdin);
  }
  requireText(responseText, 'Classification input');

  let systemPrompt;
  if (options.system) {
    systemPrompt = options.system;
  } else if (options.systemFile) {
    try {
      systemPrompt = await readFile(options.systemFile, 'utf8');
    } catch (err) {
      throw new MiniplayerError(`Unable to read system prompt file ${options.systemFile}: ${err.message}`);
    }
  }

  const records = await runtime.loadCatalog();
  const output = await generateFromSelection({
    explicitSelector: options.model,
    config,
    records,
    prompt: buildClassificationPrompt(responseText),
    system: systemPrompt,
    tools: {}, // pure classify: NO tools
    env: runtime.env,
    random: runtime.random,
    generate: runtime.generate,
    debug: runtime.debug,
    warn: runtime.warn,
  });
  const classification = parseClassificationOutput(output);
  io.stdout.write(`${JSON.stringify(classification)}\n`);
  return 0;
}

export async function execute(args, io, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const runtime = {
    loadConfig: dependencies.loadConfig ?? loadConfig,
    loadCatalog: dependencies.loadCatalog ?? ((opts) => loadCatalog({ env, ...opts })),
    generate: dependencies.generate ?? generateOneShot,
    random: dependencies.random ?? Math.random,
    env,
    debug: env.MINIPLAYER_DEBUG
      ? (message) => io.stderr.write(`debug: ${message}\n`)
      : undefined,
    warn: (message) => io.stderr.write(`warning: ${message}\n`),
  };

  if (args.length === 0) {
    if (io.stdin?.isTTY) {
      return chatCommand([], io, runtime);
    }
    const input = await readStdin(io.stdin);
    if (!input.trim()) {
      io.stderr.write(HELP);
      return 1;
    }
    return runCommand([], io, runtime, input);
  }

  if (args[0] === '--help' || args[0] === '-h') {
    io.stdout.write(HELP);
    return 0;
  }

  if (args[0] === '--version' || args[0] === '-v' || args[0] === '-V' || args[0] === 'version') {
    io.stdout.write(`miniplayer ${resolveVersionDisplay()}\n`);
    return 0;
  }

  const [command, ...commandArgs] = args;
  if (command === 'chat') return chatCommand(commandArgs, io, runtime);
  if (command === 'acp') return serveAcp(commandArgs, io, runtime);
  if (command === 'run') return runCommand(commandArgs, io, runtime);
  if (command === 'models') return modelsCommand(commandArgs, io, runtime);
  if (command === 'providers') return providersCommand(commandArgs, io, runtime);
  if (command === 'classify') return classifyCommand(commandArgs, io, runtime);
  throw new MiniplayerError(`Unknown command: ${command}`);
}
