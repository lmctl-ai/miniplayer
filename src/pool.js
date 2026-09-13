import { MiniplayerError } from './errors.js';
import { generateOneShot, hasProviderCredential } from './providers.js';
import { resolveCallableModel } from './selector.js';
import { resolveSelectionSource, shuffled } from './selection.js';

function describeCandidates(candidates, suffix = '') {
  return candidates.length === 0
    ? 'none'
    : candidates.map(({ selector, reason }) => `${selector}${reason ? ` (${reason})` : suffix}`).join(', ');
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
  const skipped = [];
  for (const selector of selection.selectors) {
    let resolved;
    try {
      resolved = resolveCallableModel(records, selector, config.aliases);
    } catch (error) {
      if (!selection.pool) throw error;
      skipped.push({ selector, reason: error.message });
      continue;
    }
    const { record, selector: resolvedSelector } = resolved;
    if (!unique.has(record.record_id)) {
      unique.set(record.record_id, { selector, resolvedSelector, record });
    }
  }
  const resolved = [...unique.values()];

  if (!selection.pool) {
    return { ...selection, candidates: resolved, skipped };
  }

  const available = [];
  for (const candidate of resolved) {
    try {
      if (hasProviderCredential(candidate.record, config, env)) available.push(candidate);
      else skipped.push({ ...candidate, reason: 'no credential' });
    } catch (error) {
      skipped.push({ ...candidate, reason: error.message });
    }
  }

  return {
    ...selection,
    candidates: selection.source === 'built-in-pool' && available[0]?.selector === selection.selectors[0]
      ? [available[0], ...shuffled(available.slice(1), random)]
      : shuffled(available, random),
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
    return generate({ record: plan.candidates[0].record, config, prompt, env });
  }

  for (const candidate of plan.skipped) {
    debug?.(`skipping pool model "${candidate.selector}": ${candidate.reason}`);
  }

  const rateLimited = [];
  for (const candidate of plan.candidates) {
    try {
      return await generate({ record: candidate.record, config, prompt, env });
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      rateLimited.push(candidate);
      debug?.(`pool model "${candidate.selector}" was rate-limited; trying next model`);
    }
  }

  const tried = describeCandidates(rateLimited, ' (rate-limited)');
  const skipped = describeCandidates(plan.skipped);
  throw new MiniplayerError(`Provider pool exhausted; tried: ${tried}; skipped: ${skipped}`);
}
