import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs } from 'ai';

import { MiniplayerError } from './errors.js';
import { resolveRequestTimeoutMs } from './config.js';
import { generateMock, isMockRecord } from './mock.js';
import { createTools } from './tools.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const PASSTHROUGH_MODEL_ID = /^[A-Za-z0-9._:-]+$/;

function usageConvention(record) {
  if (record?.source === 'openrouter') return 'input-includes-cache';
  if (record?.source === 'litellm' && record?.provider === 'anthropic') return 'input-excludes-cache';
  if (record?.source === 'litellm') return 'input-includes-cache';
  return 'unknown';
}

const LITELLM_PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    configFallback: 'openai',
    kind: 'native',
    create: createOpenAI,
    passthrough: true,
  },
  chatgpt: {
    envKey: 'OPENAI_API_KEY',
    configFallback: 'openai',
    kind: 'native',
    create: createOpenAI,
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    configFallback: 'anthropic',
    kind: 'native',
    create: createAnthropic,
    passthrough: true,
  },
  gemini: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    configFallback: 'gemini',
    kind: 'native',
    create: createGoogleGenerativeAI,
    passthrough: true,
  },
  google: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    configFallback: 'gemini',
    kind: 'native',
    create: createGoogleGenerativeAI,
  },
  moonshot: {
    envKey: 'MOONSHOT_API_KEY',
    configFallback: 'moonshot',
    kind: 'openai-compatible',
    baseURL: 'https://api.moonshot.ai/v1',
    passthrough: true,
  },
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    configFallback: 'deepseek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    passthrough: true,
  },
  ollama: {
    configFallback: 'ollama',
    kind: 'openai-compatible',
    baseURL: (env) => `${(env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '')}/v1`,
    passthrough: true,
    requiresApiKey: false,
  },
};

export function createPassthroughRecord(selector) {
  const separator = selector.indexOf('/');
  if (separator <= 0 || separator === selector.length - 1) return null;

  const provider = selector.slice(0, separator);
  const modelId = selector.slice(separator + 1);
  if (!LITELLM_PROVIDERS[provider]?.passthrough || !PASSTHROUGH_MODEL_ID.test(modelId)) return null;

  return {
    record_id: `direct:${selector}`,
    source: 'litellm',
    provider,
    mode: 'chat',
    gateway_id: null,
    vendor_model_id: modelId,
    source_model_id: selector,
    canonical_slug: null,
  };
}

function providerConfig(config, name, fallback = name) {
  return config.provider?.[name] ?? config.provider?.[fallback] ?? {};
}

function litellmVendorModelId(record) {
  const routingPrefix = `${record.provider}/`;
  return record.vendor_model_id.startsWith(routingPrefix)
    ? record.vendor_model_id.slice(routingPrefix.length)
    : record.vendor_model_id;
}

export function resolveProviderRoute(record, config = {}, env = process.env) {
  if (record.source === 'openrouter') {
    const settings = providerConfig(config, 'openrouter');
    if (!record.gateway_id) {
      throw new MiniplayerError(`Catalog record "${record.record_id}" has no gateway_id`);
    }
    return {
      kind: 'openai-compatible',
      name: 'openrouter',
      baseURL: settings.baseURL || OPENROUTER_BASE_URL,
      apiKey: env.OPENROUTER_API_KEY || settings.apiKey,
      envKey: 'OPENROUTER_API_KEY',
      modelId: record.gateway_id,
    };
  }

  if (record.source === 'litellm') {
    const mapping = LITELLM_PROVIDERS[record.provider];
    if (!mapping) {
      throw new MiniplayerError(`Unsupported litellm provider "${record.provider}" for model "${record.record_id}"`);
    }
    if (!record.vendor_model_id) {
      throw new MiniplayerError(`Catalog record "${record.record_id}" has no vendor_model_id`);
    }
    const settings = providerConfig(config, record.provider, mapping.configFallback);
    return {
      ...mapping,
      name: record.provider,
      baseURL: settings.baseURL || (typeof mapping.baseURL === 'function' ? mapping.baseURL(env) : mapping.baseURL),
      apiKey: mapping.requiresApiKey === false ? 'ollama' : env[mapping.envKey] || settings.apiKey,
      modelId: litellmVendorModelId(record),
    };
  }

  throw new MiniplayerError(`Unsupported catalog source "${record.source}" for model "${record.record_id}"`);
}

export function hasProviderCredential(record, config = {}, env = process.env) {
  return Boolean(resolveProviderRoute(record, config, env).apiKey);
}

export function createModel(record, config = {}, env = process.env) {
  const route = resolveProviderRoute(record, config, env);
  if (!route.apiKey) {
    throw new MiniplayerError(`Missing API key for provider "${route.name}"; set ${route.envKey} or configure provider.${route.name}.apiKey`);
  }

  if (route.kind === 'openai-compatible') {
    const provider = createOpenAICompatible({
      name: route.name,
      baseURL: route.baseURL,
      apiKey: route.apiKey,
    });
    return provider(route.modelId);
  }

  const options = { apiKey: route.apiKey };
  if (route.baseURL) options.baseURL = route.baseURL;
  return route.create(options)(route.modelId);
}

export async function generateOneShot({
  record,
  config,
  prompt,
  messages,
  signal,
  timeoutMs,
  cwd,
  tools,
  onToolEvent,
  env = process.env,
  generateText: callGenerateText = generateText,
  onResult,
}) {
  if (isMockRecord(record)) return generateMock({ record, prompt, signal, onResult });
  const deadline = timeoutMs ?? resolveRequestTimeoutMs(config, env);
  const signals = [signal, deadline > 0 ? AbortSignal.timeout(deadline) : undefined].filter(Boolean);
  const controller = new AbortController();
  const listeners = signals.map(source => {
    const abort = () => controller.abort(source.reason);
    if (source.aborted) abort();
    else source.addEventListener('abort', abort, { once: true });
    return () => source.removeEventListener('abort', abort);
  });
  try {
    controller.signal.throwIfAborted();
    const model = createModel(record, config, env);
    const toolSet = tools ?? (cwd ? createTools({ cwd, env, signal: controller.signal, onToolEvent }) : undefined);
    const result = await callGenerateText({
      model, ...(messages !== undefined ? { messages } : { prompt }),
      abortSignal: controller.signal,
      ...(toolSet ? { tools: toolSet, stopWhen: stepCountIs(32), maxRetries: 0,
        onStepFinish: step => onToolEvent?.({ type: 'step_finish', step, record,
          usageConvention: usageConvention(record),
          ...(Number.isFinite(step?.providerMetadata?.anthropic?.cacheCreationInputTokens)
            ? { cacheWriteInputTokens: step.providerMetadata.anthropic.cacheCreationInputTokens } : {}) }) } : {}),
    });
    if (toolSet) {
      const lastStep = result.steps?.at(-1);
      if (lastStep?.toolCalls?.length) {
        throw new MiniplayerError('Tool-call step limit reached before the model produced a final answer');
      }
    }
    const nativeUsage = result.providerMetadata?.anthropic;
    onResult?.({ result, record, usageConvention: usageConvention(record),
      ...(Array.isArray(result.response?.messages) ? { messages: result.response.messages } : {}),
      ...(Number.isFinite(nativeUsage?.cacheCreationInputTokens)
        ? { cacheWriteInputTokens: nativeUsage.cacheCreationInputTokens } : {}) });
    // Explicit cancellation is never a successful result, even if a backend ignored it.
    signal?.throwIfAborted();
    return result.text;
  } finally { for (const remove of listeners) remove(); }
}
