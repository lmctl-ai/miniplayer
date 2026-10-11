import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MiniplayerError } from './errors.js';
import { validatePool } from './selection.js';
import { parseToolConfigItem } from './external-tools.js';

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
  if (config.tools !== undefined) {
    if (!Array.isArray(config.tools)) {
      throw new MiniplayerError(`Config ${resolvedPath} field "tools" must be an array`);
    }
    const seenNames = new Set();
    const FORBIDDEN_TOOL_NAMES = new Set([
      '__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
      'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString'
    ]);
    for (const item of config.tools) {
      if (typeof item === 'string') {
        if (!item.trim()) throw new MiniplayerError(`Config ${resolvedPath} tools item must not be empty`);
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        if (typeof item.command !== 'string' || !item.command.trim()) {
          throw new MiniplayerError(`Config ${resolvedPath} tool item requires a non-empty "command" string`);
        }
        if (item.name !== undefined && (typeof item.name !== 'string' || !item.name.trim())) {
          throw new MiniplayerError(`Config ${resolvedPath} tool item "name" must be a non-empty string`);
        }
        if (item.brief !== undefined && typeof item.brief !== 'string') {
          throw new MiniplayerError(`Config ${resolvedPath} tool item "brief" must be a string`);
        }
      } else {
        throw new MiniplayerError(`Config ${resolvedPath} tools items must be strings or tool objects`);
      }

      const parsed = parseToolConfigItem(item);
      if (parsed.name.length > 64) {
        throw new MiniplayerError(`Config ${resolvedPath} tool name "${parsed.name}" exceeds 64 characters`);
      }
      if (FORBIDDEN_TOOL_NAMES.has(parsed.name)) {
        throw new MiniplayerError(`Config ${resolvedPath} tool name "${parsed.name}" is a reserved property name`);
      }
      if (seenNames.has(parsed.name)) {
        throw new MiniplayerError(`Config ${resolvedPath} duplicate tool name "${parsed.name}"`);
      }
      seenNames.add(parsed.name);
    }
  }
  if (config.wrapUp !== undefined && typeof config.wrapUp !== 'boolean') {
    throw new MiniplayerError(`Config ${resolvedPath} field "wrapUp" must be a boolean`);
  }
  if (config.contextFiles !== undefined && typeof config.contextFiles !== 'boolean') {
    throw new MiniplayerError(`Config ${resolvedPath} field "contextFiles" must be a boolean`);
  }
  if (config.compact !== undefined) {
    if (!config.compact || typeof config.compact !== 'object' || Array.isArray(config.compact)) {
      throw new MiniplayerError(`Config ${resolvedPath} field "compact" must be an object`);
    }
    if (config.compact.thresholdRatio !== undefined) {
      const r = config.compact.thresholdRatio;
      if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0 || r > 1) {
        throw new MiniplayerError(`Config ${resolvedPath} compact.thresholdRatio must be a number between 0 and 1`);
      }
    }
    if (config.compact.thresholdTokens !== undefined) {
      const t = config.compact.thresholdTokens;
      if (!Number.isInteger(t) || t <= 0) {
        throw new MiniplayerError(`Config ${resolvedPath} compact.thresholdTokens must be a positive integer`);
      }
    }
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
