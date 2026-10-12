import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, stepCountIs } from 'ai';

import { MiniplayerError } from './errors.js';
import { resolveRequestTimeoutMs } from './config.js';
import { generateMock, isMockRecord } from './mock.js';
import { createExternalTools } from './external-tools.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
const PASSTHROUGH_MODEL_ID = /^[A-Za-z0-9._:-]+$/;

function usageConvention(record) {
  if (record?.source === 'openrouter') return 'input-includes-cache';
  if (record?.source === 'litellm' && record?.provider === 'anthropic') return 'input-excludes-cache';
  if (record?.source === 'litellm') return 'input-includes-cache';
  return 'unknown';
}

// Direct APIs that bill no separate cache-write bucket (caching is automatic and writes are free).
const NO_CACHE_WRITE_PROVIDERS = new Set(['openai', 'deepseek']);
function cacheWriteTokens(record, providerMetadata) {
  const native = providerMetadata?.anthropic?.cacheCreationInputTokens;
  if (Number.isFinite(native)) return { cacheWriteInputTokens: native };
  return record?.source === 'litellm' && NO_CACHE_WRITE_PROVIDERS.has(record.provider) ? { cacheWriteInputTokens: 0 } : {};
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

// ---- catalog routes (lmprice's `miniplayer` column) --------------------------------------------
// A record carrying `miniplayer: {id, provider, model, sdk, base_url, key_env}` is routed from that
// field alone: no provider knowledge is hardcoded on this path. LITELLM_PROVIDERS above stays the
// fallback for records without the column (older cached catalogs, offline fixtures).

const SDK_FACTORIES = {
  anthropic: createAnthropic,
  openai: createOpenAI,
  google: createGoogleGenerativeAI,
};
const PASSTHROUGH_ROUTED_MODEL = /^\S+$/;

function catalogRoute(record, config, env) {
  const route = record.miniplayer;
  const label = route.id ?? record.record_id;
  if (route.sdk !== 'openai-compatible' && !SDK_FACTORIES[route.sdk]) {
    throw new MiniplayerError(`Unsupported sdk "${route.sdk}" for model "${label}"`);
  }
  if (typeof route.model !== 'string' || route.model.length === 0) {
    throw new MiniplayerError(`Catalog route for "${label}" has no model`);
  }
  const settings = providerConfig(config, route.provider);
  // ollama: OLLAMA_HOST (host + /v1) replaces the catalog's default local address.
  const hostOverride = route.provider === 'ollama' && env.OLLAMA_HOST
    ? `${env.OLLAMA_HOST.replace(/\/+$/, '')}/v1`
    : undefined;
  const keyless = route.key_env === null || route.key_env === undefined;
  return {
    kind: route.sdk === 'openai-compatible' ? 'openai-compatible' : 'native',
    ...(route.sdk === 'openai-compatible' ? {} : { create: SDK_FACTORIES[route.sdk] }),
    name: route.provider,
    baseURL: settings.baseURL || hostOverride || route.base_url || undefined,
    apiKey: keyless ? undefined : env[route.key_env] || settings.apiKey,
    envKey: keyless ? undefined : route.key_env,
    requiresApiKey: !keyless,
    modelId: route.model,
  };
}

function fallbackSdk(mapping) {
  if (mapping.kind === 'openai-compatible') return 'openai-compatible';
  if (mapping.create === createAnthropic) return 'anthropic';
  if (mapping.create === createGoogleGenerativeAI) return 'google';
  return 'openai';
}

/**
 * One route per provider: from the catalog's `miniplayer` routes, plus the built-in fallback table
 * (passthrough providers and openrouter) for providers the catalog does not route.
 */
export function knownProviderRoutes(records = []) {
  const routes = new Map();
  for (const record of records) {
    const route = record?.miniplayer;
    if (!route?.provider || routes.has(route.provider)) continue;
    routes.set(route.provider, {
      provider: route.provider,
      sdk: route.sdk,
      base_url: route.base_url ?? null,
      key_env: route.key_env ?? null,
      source: 'catalog',
    });
  }
  const builtIn = [
    ['openrouter', { sdk: 'openai-compatible', base_url: OPENROUTER_BASE_URL, key_env: 'OPENROUTER_API_KEY' }],
    ...Object.entries(LITELLM_PROVIDERS)
      .filter(([, mapping]) => mapping.passthrough)
      .map(([name, mapping]) => [name, {
        sdk: fallbackSdk(mapping),
        base_url: typeof mapping.baseURL === 'function' ? mapping.baseURL({}) : mapping.baseURL ?? null,
        key_env: mapping.envKey ?? null,
      }]),
  ];
  for (const [name, route] of builtIn) {
    if (!routes.has(name)) routes.set(name, { provider: name, ...route, source: 'built-in' });
  }
  return routes;
}

/** `<provider>/<any-model>` for a provider the catalog routes (even a model it does not list). */
export function createRoutedPassthroughRecord(selector, records = []) {
  const separator = selector.indexOf('/');
  if (separator <= 0 || separator === selector.length - 1) return null;
  const provider = selector.slice(0, separator);
  const model = selector.slice(separator + 1);
  const route = knownProviderRoutes(records).get(provider);
  if (!route || route.source !== 'catalog' || !PASSTHROUGH_ROUTED_MODEL.test(model)) return null;
  return {
    record_id: `direct:${selector}`,
    source: provider === 'openrouter' ? 'openrouter' : 'litellm',
    provider,
    mode: 'chat',
    gateway_id: null,
    vendor_model_id: model,
    source_model_id: selector,
    canonical_slug: null,
    miniplayer: {
      id: selector,
      provider,
      model,
      sdk: route.sdk,
      base_url: route.base_url,
      key_env: route.key_env,
    },
  };
}

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
  if (record.miniplayer) return catalogRoute(record, config, env);

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
  if (route.requiresApiKey !== false && !route.apiKey) {
    // The env var to export, never a key value; the config key is a discouraged fallback.
    throw new MiniplayerError(`Missing API key for ${route.name}: export ${route.envKey}=... (or set provider.${route.name}.apiKey in the config; discouraged)`);
  }

  if (route.kind === 'openai-compatible') {
    const provider = createOpenAICompatible({
      name: route.name,
      baseURL: route.baseURL,
      ...(route.apiKey ? { apiKey: route.apiKey } : {}),
    });
    return provider(route.modelId);
  }

  const options = route.apiKey ? { apiKey: route.apiKey } : {};
  if (route.baseURL) options.baseURL = route.baseURL;
  return route.create(options)(route.modelId);
}

export async function generateOneShot({
  record,
  config,
  prompt,
  messages,
  system,
  signal,
  timeoutMs,
  cwd,
  tools,
  onToolEvent,
  env = process.env,
  generateText: callGenerateText = generateText,
  onResult,
  warn,
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
    const toolSet = tools !== undefined ? tools : createExternalTools({
      toolsConfig: config?.tools,
      cwd,
      env,
      signal: controller.signal,
      onToolEvent,
    });
    const hasTools = Boolean(toolSet && Object.keys(toolSet).length > 0);
    if (hasTools && record?.capabilities?.supports_function_calling === false) {
      const modelName = record.vendor_model_id || record.source_model_id || record.record_id;
      const msg = `model "${modelName}" does not support tool calling in catalog metadata; configured tools may fail`;
      if (warn) warn(msg);
      else try { process.stderr.write(`warning: ${msg}\n`); } catch {}
    }
    const result = await callGenerateText({
      model, ...(messages !== undefined ? { messages } : { prompt }),
      ...(system !== undefined ? { system } : {}),
      abortSignal: controller.signal,
      ...(hasTools ? { tools: toolSet, stopWhen: stepCountIs(32), maxRetries: 0,
        onStepFinish: step => onToolEvent?.({ type: 'step_finish', step, record,
          usageConvention: usageConvention(record),
          ...(Number.isFinite(step?.providerMetadata?.anthropic?.cacheCreationInputTokens)
            ? { cacheWriteInputTokens: step.providerMetadata.anthropic.cacheCreationInputTokens } : {}) }) } : {}),
    });
    if (hasTools) {
      const lastStep = result.steps?.at(-1);
      if (lastStep?.toolCalls?.length) {
        throw new MiniplayerError('Tool-call step limit reached before the model produced a final answer');
      }
    }
    onResult?.({ result, record, usageConvention: usageConvention(record),
      ...(Array.isArray(result.response?.messages) ? { messages: result.response.messages } : {}),
      ...cacheWriteTokens(record, result.providerMetadata) });
    // Explicit cancellation is never a successful result, even if a backend ignored it.
    signal?.throwIfAborted();
    return result.text;
  } finally { for (const remove of listeners) remove(); }
}
