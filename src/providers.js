import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';

import { MiniplayerError } from './errors.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

const LITELLM_PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    configFallback: 'openai',
    kind: 'native',
    create: createOpenAI,
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
  },
  gemini: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    configFallback: 'gemini',
    kind: 'native',
    create: createGoogleGenerativeAI,
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
  },
  deepseek: {
    envKey: 'DEEPSEEK_API_KEY',
    configFallback: 'deepseek',
    kind: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
  },
};

function providerConfig(config, name, fallback = name) {
  return config.provider?.[name] ?? config.provider?.[fallback] ?? {};
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
      baseURL: settings.baseURL || mapping.baseURL,
      apiKey: env[mapping.envKey] || settings.apiKey,
      modelId: record.vendor_model_id,
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

export async function generateOneShot({ record, config, prompt }) {
  const model = createModel(record, config);
  const result = await generateText({ model, prompt });
  return result.text;
}
