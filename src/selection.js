import { MiniplayerError } from './errors.js';

export const BUILT_IN_POOL = Object.freeze([
  'deepseek/deepseek-flash',
  'deepseek/deepseek-v4-flash-20260423',
  'deepseek-chat',
  'claude-haiku-4-5',
  'gemini/gemini-3.7-flash',
  'gpt-5-nano',
  'moonshot/kimi-latest-8k',
]);

export function resolveSelectionSource(explicitSelector, config = {}) {
  if (explicitSelector !== undefined) {
    return { selectors: [explicitSelector], pool: false, source: 'flag' };
  }
  if (config.pool !== undefined) {
    return { selectors: [...config.pool], pool: true, source: 'config-pool' };
  }
  if (config.model !== undefined) {
    return { selectors: [config.model], pool: false, source: 'config-model' };
  }
  return { selectors: [...BUILT_IN_POOL], pool: true, source: 'built-in-pool' };
}

export function shuffled(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function validatePool(pool, configPath) {
  if (!Array.isArray(pool) || pool.length === 0) {
    throw new MiniplayerError(`Config ${configPath} field "pool" must be a non-empty array`);
  }
  if (pool.some((selector) => typeof selector !== 'string' || selector.length === 0)) {
    throw new MiniplayerError(`Config ${configPath} field "pool" must contain only non-empty strings`);
  }
}
