import { findSelectorMatches } from './catalog.js';
import { resolveAlias } from './config.js';
import { MiniplayerError } from './errors.js';
import { createPassthroughRecord, createRoutedPassthroughRecord, knownProviderRoutes } from './providers.js';
import { mockRecord } from './mock.js';

export function resolveCallableModel(records, selector, aliases = {}) {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new MiniplayerError('A model selector is required');
  }

  const resolvedSelector = resolveAlias(selector, aliases);
  const mock = mockRecord(resolvedSelector);
  if (mock) return { record: mock, selector: resolvedSelector, passthrough: true };
  const matches = findSelectorMatches(records, resolvedSelector);
  if (matches.length > 1) {
    const ids = matches.map((record) => record.record_id).join(', ');
    throw new MiniplayerError(`Selector "${resolvedSelector}" is ambiguous (${matches.length} matches: ${ids})`);
  }
  if (matches.length === 1) {
    return { record: matches[0], selector: resolvedSelector, passthrough: false };
  }

  // A provider the catalog routes takes any model id (e.g. a brand-new model); then the built-in
  // passthrough table (catalogs without routes).
  const routed = createRoutedPassthroughRecord(resolvedSelector, records);
  if (routed) return { record: routed, selector: resolvedSelector, passthrough: true };
  const record = createPassthroughRecord(resolvedSelector);
  if (record) return { record, selector: resolvedSelector, passthrough: true };

  const separator = resolvedSelector.indexOf('/');
  if (separator > 0) {
    const provider = resolvedSelector.slice(0, separator);
    const known = knownProviderRoutes(records);
    if (provider !== 'mock' && !known.has(provider)) {
      throw new MiniplayerError(
        `No model matches selector "${resolvedSelector}": unknown provider "${provider}" (known providers: ${[...known.keys()].sort().join(', ')})`,
      );
    }
  }
  throw new MiniplayerError(`No model matches selector "${resolvedSelector}"`);
}
