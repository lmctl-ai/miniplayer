import { MiniplayerError } from './errors.js';
import { generateOneShot, hasProviderCredential } from './providers.js';
import { resolveCallableModel } from './selector.js';
import { resolveSelectionSource, shuffled } from './selection.js';

function describeCandidates(candidates, suffix) {
  return candidates.length === 0
    ? 'none'
    : candidates.map(({ selector }) => `${selector}${suffix}`).join(', ');
}

export function createExecutionPlan({
  explicitSelector,
  config = {},
  records,
  env = process.env,
  random = Math.random,
}) {
  const selection = resolveSelectionSource(explicitSelector, config);
  const unique = new Map();
  for (const selector of selection.selectors) {
    const { record, selector: resolvedSelector } = resolveCallableModel(records, selector, config.aliases);
    if (!unique.has(record.record_id)) {
      unique.set(record.record_id, { selector, resolvedSelector, record });
    }
  }
  const resolved = [...unique.values()];

  if (!selection.pool) {
    return { ...selection, candidates: resolved, skipped: [] };
  }

  const available = [];
  const skipped = [];
  for (const candidate of resolved) {
    if (hasProviderCredential(candidate.record, config, env)) available.push(candidate);
    else skipped.push(candidate);
  }

  return {
    ...selection,
    candidates: shuffled(available, random),
    skipped,
  };
}

export function isRateLimitError(error) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current.statusCode === 429 || current.status === 429 || current.response?.status === 429) {
      return true;
    }
    const details = [
      current.name,
      current.message,
      current.code,
      current.data?.error?.code,
      current.data?.error?.message,
    ].filter(Boolean).join(' ');
    if (/\b429\b|rate[\s_-]*limit|too many requests|quota exceeded|resource exhausted|exceeded[^\n]*quota/i.test(details)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

export async function generateFromSelection({
  explicitSelector,
  config = {},
  records,
  prompt,
  env = process.env,
  random = Math.random,
  generate = generateOneShot,
  debug,
}) {
  const plan = createExecutionPlan({ explicitSelector, config, records, env, random });

  if (!plan.pool) {
    return generate({ record: plan.candidates[0].record, config, prompt });
  }

  for (const candidate of plan.skipped) {
    debug?.(`skipping pool model "${candidate.selector}": no provider credential`);
  }

  const rateLimited = [];
  for (const candidate of plan.candidates) {
    try {
      return await generate({ record: candidate.record, config, prompt });
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      rateLimited.push(candidate);
      debug?.(`pool model "${candidate.selector}" was rate-limited; trying next model`);
    }
  }

  const tried = describeCandidates(rateLimited, ' (rate-limited)');
  const skipped = describeCandidates(plan.skipped, ' (no credential)');
  throw new MiniplayerError(`Provider pool exhausted; tried: ${tried}; skipped: ${skipped}`);
}
