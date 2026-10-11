import { MiniplayerError } from './errors.js';
import { randomUUID } from 'node:crypto';

const MODELS = new Set(['Echo', 'RateLimit', 'ServerError', 'Adder', 'Compactor']);

export function mockRecord(selector) {
  if (typeof selector !== 'string' || !selector.startsWith('mock/')) return null;
  const model = selector.slice('mock/'.length);
  if (!MODELS.has(model)) return null;
  return {
    record_id: `mock:${model}`,
    source: 'mock',
    provider: 'mock',
    mode: 'chat',
    gateway_id: null,
    vendor_model_id: model,
    source_model_id: selector,
    canonical_slug: null,
  };
}

export function isMockRecord(record) {
  return record?.source === 'mock' && record?.provider === 'mock' && MODELS.has(record.vendor_model_id);
}

export class MockProviderError extends MiniplayerError {
  constructor(model, status, message) {
    super(message);
    this.name = 'MockProviderError';
    this.statusCode = status;
    this.data = { provider: 'mock', model, status, message };
  }
}

function numericPrompt(prompt) {
  const valueText = prompt.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(valueText)) {
    throw new MiniplayerError('Adder expects a finite decimal number');
  }
  const value = Number(valueText);
  if (!Number.isFinite(value)) throw new MiniplayerError('Adder expects a finite decimal number');
  return value;
}

/** Deterministic, keyless provider used only by miniplayer protocol tests. */
export async function generateMock({ record, prompt, signal, state = 0, onResult }) {
  signal?.throwIfAborted();
  const model = record.vendor_model_id;
  if (model === 'RateLimit') throw new MockProviderError(model, 429, 'mock rate limit exceeded');
  if (model === 'ServerError') throw new MockProviderError(model, 503, 'mock temporary server error');
  const responseId = `mock-${randomUUID()}`;
  let text;
  let nextState = state;
  if (model === 'Compactor') {
    text = JSON.stringify({ summary: 'Mock compacted summary', notes: 'Mock durable notes' });
  } else if (model === 'Echo') {
    if (typeof prompt === 'string' && prompt.includes('"summary"') && prompt.includes('"notes"')) {
      text = JSON.stringify({ summary: 'Echo compacted summary', notes: 'Echo durable notes' });
    } else {
      text = prompt;
    }
  } else {
    const value = numericPrompt(prompt);
    nextState = state + value;
    if (!Number.isFinite(nextState)) throw new MiniplayerError('Adder result is not finite');
    text = String(nextState);
  }
  onResult?.({ record, result: { response: { id: responseId, modelId: model },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 } },
  usageConvention: 'synthetic', nextState });
  return text;
}
