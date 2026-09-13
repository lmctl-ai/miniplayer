import { findSelectorMatches } from './catalog.js';
import { resolveAlias } from './config.js';
import { MiniplayerError } from './errors.js';
import { createPassthroughRecord } from './providers.js';

export function resolveCallableModel(records, selector, aliases = {}) {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new MiniplayerError('A model selector is required');
  }

  const resolvedSelector = resolveAlias(selector, aliases);
  const matches = findSelectorMatches(records, resolvedSelector);
  if (matches.length > 1) {
    const ids = matches.map((record) => record.record_id).join(', ');
    throw new MiniplayerError(`Selector "${resolvedSelector}" is ambiguous (${matches.length} matches: ${ids})`);
  }
  if (matches.length === 1) {
    return { record: matches[0], selector: resolvedSelector, passthrough: false };
  }

  const record = createPassthroughRecord(resolvedSelector);
  if (!record) {
    throw new MiniplayerError(`No model matches selector "${resolvedSelector}"`);
  }
  return { record, selector: resolvedSelector, passthrough: true };
}
