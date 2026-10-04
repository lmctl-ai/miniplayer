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
    candidates: selection.source === 'config-pool' && selection.ordered
      ? available
      : selection.source === 'built-in-pool'
        ? orderBuiltInCandidates(available, selection.selectors, random)
        : shuffled(available, random),
    skipped,
  };
}

function orderBuiltInCandidates(available, selectors, random) {
  const pinnedSelectors = selectors.slice(0, 2);
  const bySelector = new Map(available.map((candidate) => [candidate.selector, candidate]));
  const pinned = pinnedSelectors.flatMap((selector) => bySelector.has(selector) ? [bySelector.get(selector)] : []);
  const rest = available.filter((candidate) => !pinnedSelectors.includes(candidate.selector));
  return [...pinned, ...shuffled(rest, random)];
}

const CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
  'UND_ERR_ABORTED',
]);

function errorChain(error) {
  const seen = new Set();
  const chain = [];
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function isRateLimitError(error) {
  for (const current of errorChain(error)) {
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
  }
  return false;
}

export function isFailoverError(error) {
  if (isRateLimitError(error)) return true;
  const chain = errorChain(error);
  const hasHttpFailure = chain.some((current) => {
    const status = current.statusCode ?? current.status ?? current.response?.status;
    return Number.isInteger(status) && status >= 400;
  });
  if (hasHttpFailure) return false;

  return chain.some((current) => {
    if (CONNECTIVITY_CODES.has(current.code) || CONNECTIVITY_CODES.has(current.cause?.code)) return true;
    const details = [current.name, current.message, current.code].filter(Boolean).join(' ');
    return /\bAbortError\b|\bTimeoutError\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|fetch failed|socket hang\s*up|network (?:error|request failed)|connection (?:refused|reset)|connect(?:ion)? timed out|operation was aborted|request (?:aborted|timed out)/i.test(details);
  });
}

export async function generateFromSelection({
  explicitSelector,
  config = {},
  records,
  prompt,
  messages,
  signal,
  timeoutMs,
  env = process.env,
  random = Math.random,
  generate = generateOneShot,
  debug,
  warn,
  onResult,
}) {
  signal?.throwIfAborted();
  const input = { config, prompt, env,
    ...(messages !== undefined ? { messages } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(onResult !== undefined ? { onResult } : {}),
  };
  const plan = createExecutionPlan({ explicitSelector, config, records, env, random });

  if (!plan.pool) {
    return generate({ ...input, record: plan.candidates[0].record });
  }

  if (plan.source === 'config-pool' && plan.skipped.length > 0) {
    warn?.(`config pool skipped: ${describeCandidates(plan.skipped)}`);
  } else {
    for (const candidate of plan.skipped) {
      debug?.(`skipping pool model "${candidate.selector}": ${candidate.reason}`);
    }
  }

  const failedOver = [];
  for (const candidate of plan.candidates) {
    try {
      signal?.throwIfAborted();
      debug?.(`trying pool model "${candidate.selector}"`);
      return await generate({ ...input, record: candidate.record });
    } catch (error) {
      signal?.throwIfAborted();
      if (!isFailoverError(error)) throw error;
      failedOver.push(candidate);
      debug?.(`pool model "${candidate.selector}" hit a failover error; trying next model`);
    }
  }

  const tried = describeCandidates(failedOver, ' (failover error)');
  const skipped = describeCandidates(plan.skipped);
  throw new MiniplayerError(`Provider pool exhausted; tried: ${tried}; skipped: ${skipped}`);
}
