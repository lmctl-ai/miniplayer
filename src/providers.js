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
    create: createOpenAI,
  },
  chatgpt: {
    envKey: 'OPENAI_API_KEY',
    configFallback: 'openai',
    create: createOpenAI,
  },
  anthropic: {
    envKey: 'ANTHROPIC_API_KEY',
    configFallback: 'anthropic',
    create: createAnthropic,
  },
  gemini: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    configFallback: 'gemini',
    create: createGoogleGenerativeAI,
  },
  google: {
    envKey: 'GOOGLE_GENERATIVE_AI_API_KEY',
    configFallback: 'gemini',
    create: createGoogleGenerativeAI,
  },
};

function providerConfig(config, name, fallback = name) {
  return config.provider?.[name] ?? config.provider?.[fallback] ?? {};
}

function requireApiKey(env, envKey, settings, providerName) {
  const apiKey = env[envKey] || settings.apiKey;
  if (!apiKey) {
    throw new MiniplayerError(`Missing API key for provider "${providerName}"; set ${envKey} or configure provider.${providerName}.apiKey`);
  }
  return apiKey;
}

export function createModel(record, config = {}, env = process.env) {
  if (record.source === 'openrouter') {
    const settings = providerConfig(config, 'openrouter');
    const apiKey = requireApiKey(env, 'OPENROUTER_API_KEY', settings, 'openrouter');
    if (!record.gateway_id) {
      throw new MiniplayerError(`Catalog record "${record.record_id}" has no gateway_id`);
    }
    const provider = createOpenAICompatible({
      name: 'openrouter',
      baseURL: settings.baseURL || OPENROUTER_BASE_URL,
      apiKey,
    });
    return provider(record.gateway_id);
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
    const apiKey = requireApiKey(env, mapping.envKey, settings, record.provider);
    const options = { apiKey };
    if (settings.baseURL) options.baseURL = settings.baseURL;
    const provider = mapping.create(options);
    return provider(record.vendor_model_id);
  }

  throw new MiniplayerError(`Unsupported catalog source "${record.source}" for model "${record.record_id}"`);
}

export async function generateOneShot({ record, config, prompt }) {
  const model = createModel(record, config);
  const result = await generateText({ model, prompt });
  return result.text;
}
