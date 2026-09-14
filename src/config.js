import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MiniplayerError } from './errors.js';
import { validatePool } from './selection.js';

export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_TIMEOUT_MS = 2_147_483_647;

function parseRequestTimeout(value, source, allowString) {
  const parsed = allowString && typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_REQUEST_TIMEOUT_MS) {
    throw new MiniplayerError(`${source} must be a positive integer no greater than ${MAX_REQUEST_TIMEOUT_MS}`);
  }
  return parsed;
}

export function resolveRequestTimeoutMs(config = {}, env = process.env) {
  if (env.MINIPLAYER_REQUEST_TIMEOUT_MS !== undefined) {
    return parseRequestTimeout(env.MINIPLAYER_REQUEST_TIMEOUT_MS, 'MINIPLAYER_REQUEST_TIMEOUT_MS', true);
  }
  if (config.requestTimeoutMs !== undefined) {
    return parseRequestTimeout(config.requestTimeoutMs, 'Config field "requestTimeoutMs"', false);
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

export function defaultConfigPath() {
  return join(homedir(), '.config', 'miniplayer', 'config.json');
}

export async function loadConfig(filePath, env = process.env) {
  const explicitPath = filePath ?? env.MINIPLAYER_CONFIG;
  const resolvedPath = explicitPath ?? defaultConfigPath();
  let contents;
  try {
    contents = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && explicitPath === undefined) return {};
    throw new MiniplayerError(`Unable to read config ${resolvedPath}: ${error.message}`);
  }

  let config;
  try {
    config = JSON.parse(contents);
  } catch (error) {
    throw new MiniplayerError(`Invalid JSON in config ${resolvedPath}: ${error.message}`);
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new MiniplayerError(`Config ${resolvedPath} must contain a JSON object`);
  }
  if (config.aliases !== undefined && (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases))) {
    throw new MiniplayerError(`Config ${resolvedPath} field "aliases" must be an object`);
  }
  if (config.provider !== undefined && (!config.provider || typeof config.provider !== 'object' || Array.isArray(config.provider))) {
    throw new MiniplayerError(`Config ${resolvedPath} field "provider" must be an object`);
  }
  if (config.pool !== undefined) validatePool(config.pool, resolvedPath);
  if (config.poolOrdered !== undefined && typeof config.poolOrdered !== 'boolean') {
    throw new MiniplayerError(`Config ${resolvedPath} field "poolOrdered" must be a boolean`);
  }
  if (config.requestTimeoutMs !== undefined) resolveRequestTimeoutMs(config, {});

  return config;
}

export function resolveAlias(selector, aliases = {}) {
  let resolved = selector;
  const visited = new Set();

  while (Object.hasOwn(aliases, resolved)) {
    if (visited.has(resolved)) {
      throw new MiniplayerError(`Alias cycle detected while resolving "${selector}"`);
    }
    visited.add(resolved);
    const next = aliases[resolved];
    if (typeof next !== 'string' || next.length === 0) {
      throw new MiniplayerError(`Alias "${resolved}" must resolve to a non-empty string`);
    }
    resolved = next;
  }

  return resolved;
}
