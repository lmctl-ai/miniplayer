import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MiniplayerError } from './errors.js';
import { validatePool } from './selection.js';

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
