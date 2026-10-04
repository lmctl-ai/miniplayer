import { serveAcp } from './acp.js';
import { readFile } from 'node:fs/promises';

import { loadCatalog, listChatModels, modelListId } from './catalog.js';
import { buildClassificationPrompt, parseClassificationOutput } from './classifier.js';
import { loadConfig } from './config.js';
import { MiniplayerError } from './errors.js';
import { generateOneShot } from './providers.js';
import { generateFromSelection } from './pool.js';

export const HELP = `Usage:
  miniplayer acp [-m <selector>]
  miniplayer run -m <selector> [prompt]
  miniplayer classify -m <selector> [--file <path>]
  miniplayer models [--source openrouter|litellm] [--provider <name>] [--max-input-price <number>]
  miniplayer --help

Prompts and classification input default to stdin. Without -m, a configured or built-in pool is used.
`;

function takeOption(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new MiniplayerError(`Option ${name} requires a value`);
  }
  return value;
}

function parseRunArgs(args) {
  let model;
  const prompt = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      prompt.push(...args.slice(index + 1));
      break;
    } else if (arg === '-m' || arg === '--model') {
      model = takeOption(args, index, arg);
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new MiniplayerError(`Unknown option for run: ${arg}`);
    } else {
      prompt.push(arg);
    }
  }
  return { model, prompt: prompt.join(' ') };
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-m' || arg === '--model') {
      model = takeOption(args, index, arg);
      index += 1;
    } else if (arg === '--file') {
      file = takeOption(args, index, arg);
      index += 1;
    } else {
      throw new MiniplayerError(`Unknown option for classify: ${arg}`);
    }
  }
  return { model, file };
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
      modelListId(record),
      record.provider,
      record.context_window?.total_tokens,
      record.pricing?.input_per_1m_tokens,
      record.pricing?.output_per_1m_tokens,
    ]);
  }
  return `${rows.map((row) => row.map(formatCell).join('\t')).join('\n')}\n`;
}

async function runCommand(args, io, runtime) {
  const options = parseRunArgs(args);
  const config = await runtime.loadConfig(undefined, runtime.env);
  const prompt = requireText(options.prompt || await readStdin(io.stdin), 'Prompt');
  const records = await runtime.loadCatalog();
  const text = await generateFromSelection({
    explicitSelector: options.model,
    config,
    records,
    prompt,
    env: runtime.env,
    random: runtime.random,
    generate: runtime.generate,
    debug: runtime.debug,
    warn: runtime.warn,
  });
  io.stdout.write(text);
  return 0;
}

async function modelsCommand(args, io, runtime) {
  const filters = parseModelsArgs(args);
  const records = await runtime.loadCatalog();
  io.stdout.write(formatModelTable(listChatModels(records, filters)));
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

  const records = await runtime.loadCatalog();
  const output = await generateFromSelection({
    explicitSelector: options.model,
    config,
    records,
    prompt: buildClassificationPrompt(responseText),
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
  if (args.length === 0) {
    io.stderr.write(HELP);
    return 1;
  }
  if (args[0] === '--help' || args[0] === '-h') {
    io.stdout.write(HELP);
    return 0;
  }

  const env = dependencies.env ?? process.env;
  const runtime = {
    loadConfig: dependencies.loadConfig ?? loadConfig,
    loadCatalog: dependencies.loadCatalog ?? loadCatalog,
    generate: dependencies.generate ?? generateOneShot,
    random: dependencies.random ?? Math.random,
    env,
    debug: env.MINIPLAYER_DEBUG
      ? (message) => io.stderr.write(`debug: ${message}\n`)
      : undefined,
    warn: (message) => io.stderr.write(`warning: ${message}\n`),
  };
  const [command, ...commandArgs] = args;
  if (command === 'acp') return serveAcp(commandArgs, io, runtime);
  if (command === 'run') return runCommand(commandArgs, io, runtime);
  if (command === 'models') return modelsCommand(commandArgs, io, runtime);
  if (command === 'classify') return classifyCommand(commandArgs, io, runtime);
  throw new MiniplayerError(`Unknown command: ${command}`);
}
