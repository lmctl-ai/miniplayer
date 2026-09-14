# miniplayer

`miniplayer` is a small Node 20+ CLI for one-shot language-model calls. It selects models from the
[`lmprice`](../lmprice) catalog, routes them to a supported provider, and exits after one response.
It does not stream, invoke tools, or retain sessions.

## Install

From this repository:

```sh
npm install
npm link
miniplayer --help
```

The default catalog is `../lmprice/dist/model_list.json`. Set
`MINIPLAYER_LMPRICE_CATALOG=/path/to/model_list.json` to use another schema-version-1 catalog.

## Configuration

Configuration is optional and lives at `~/.config/miniplayer/config.json`. With no config,
`ollama/qwen2.5:14b` is the primary model and metered `deepseek/deepseek-flash` is its first
failover. Local-first is free, offloads inference compute, and avoids burning subscription rate
limits. A minimal file-based DeepSeek credential config is:

```json
{
  "requestTimeoutMs": 60000,
  "provider": {
    "deepseek": { "apiKey": "..." }
  }
}
```

Set `MINIPLAYER_CONFIG=/path/to/config.json` to use an alternate config path.
Every provider call has a 60,000 ms total timeout. Set positive-integer config `requestTimeoutMs` or
environment `MINIPLAYER_REQUEST_TIMEOUT_MS` to override it; the environment value wins. Invalid,
zero, negative, or excessively large values are configuration errors.

`model` may be used instead of `pool` for a single default. Aliases are resolved before exact catalog
lookup; matching is never fuzzy. Environment credentials take precedence over config credentials:

| Route | Supported catalog provider | Environment variable |
| --- | --- | --- |
| OpenRouter | every `source: "openrouter"` row | `OPENROUTER_API_KEY` |
| LiteLLM / OpenAI | `openai`, `chatgpt` | `OPENAI_API_KEY` |
| LiteLLM / Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| LiteLLM / Google | `gemini`, `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| LiteLLM / Moonshot | `moonshot` | `MOONSHOT_API_KEY` |
| LiteLLM / DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Local Ollama | `ollama` | `OLLAMA_HOST` (optional; no API key) |

Ollama defaults to `http://localhost:11434/v1`. Set `OLLAMA_HOST` to the server origin, such as
`http://172.18.32.1:11434`; miniplayer trims trailing slashes and appends `/v1`. A configured
`provider.ollama.baseURL` overrides the derived URL. Select local models with passthrough IDs such as
`ollama/qwen2.5:14b`. Ollama is always pool-eligible because it needs no credential; reachability is
checked only when the call runs.

To make local Ollama the strict primary and metered DeepSeek failover-only, configure:

```json
{
  "pool": ["ollama/qwen2.5:14b", "deepseek/deepseek-flash"],
  "poolOrdered": true,
  "provider": {
    "deepseek": { "apiKey": "..." }
  }
}
```

### Model selection and failover

Each invocation resolves models in this order:

1. `-m <selector>` forces that model and bypasses every pool.
2. Config `pool` supplies candidates. By default they are randomized for load spreading. With
   `poolOrdered: true`, the first resolvable, credentialed entry wins and later entries are
   failover-only.
3. Config `model` supplies one default model.
4. With neither, miniplayer first tries `ollama/qwen2.5:14b`, then metered
   `deepseek/deepseek-flash`. It shuffles the remaining built-in pool for rate-limit, timeout, or
   connectivity failover: `deepseek/deepseek-v4-flash-20260423`, `deepseek-chat`, `claude-haiku-4-5`,
   `gemini/gemini-3.7-flash`, `gpt-5-nano`, and `moonshot/kimi-latest-8k`.

Pool entries without credentials are skipped. One eligible entry is chosen randomly, and another is
tried only when the call reports HTTP 429, rate limiting, quota exhaustion, an AbortSignal timeout,
or a connectivity failure such as connection refusal, failed fetch, or socket hangup. The timeout
covers the complete SDK call, including a response that hangs after connecting. HTTP 400/401/500,
authentication, invalid-model, and other application errors fail immediately. Set
`MINIPLAYER_DEBUG=1` to write skip and failover details to stderr. If no candidate succeeds, the
exhaustion error names failed-over and skipped candidates.

`poolOrdered` governs only operator-authored `pool` arrays and defaults to `false`. It does not alter
the built-in pool, which pins local Qwen first and DeepSeek Flash second before random fallbacks.
Skipped configured entries still produce one stderr warning with their reasons.

## Commands

Run a one-shot prompt from an argument or stdin:

```sh
miniplayer run -m gpt-5-nano "Summarize this in one sentence"
printf '%s\n' 'Summarize this' | miniplayer run
```

Classify a team response from stdin (preferred) or a file:

```sh
printf '%s\n' 'The assigned fix is complete; send the next task.' |
  miniplayer classify -m claude-haiku-4-5
miniplayer classify -m claude-haiku-4-5 --file response.txt
```

Classification emits exactly one compact object with one of five labels:

```json
{"label":"task-done","reason":"The current task is complete but more may remain","confidence":0.96}
```

List chat-capable catalog rows and optionally filter them:

```sh
miniplayer models
miniplayer models --source openrouter --provider deepseek --max-input-price 1
```

The table contains the model ID, provider, total context tokens, and input/output prices per million
tokens.

## Output and errors

Successful command results are the only content written to stdout. Diagnostics go to stderr. Exit
code `0` means success. Exit code `1` covers usage, catalog, pool exhaustion, configuration,
credential, provider, and API errors. Exit code `2` is reserved for a model response that cannot be
parsed as a valid classifier object.

Call selectors resolve in three stages: config alias, exact catalog match, then direct provider
passthrough. Exact catalog matching checks `gateway_id`, `vendor_model_id`, `source_model_id`, and
`canonical_slug`; no fuzzy matching occurs. If the catalog has no match, a selector shaped as
`provider/model` may call `model` directly when `provider` is `deepseek`, `moonshot`, `openai`,
`anthropic`, `gemini`, or `ollama`. This is why `deepseek/deepseek-flash` and
`ollama/qwen2.5:14b` work even when absent from the catalog. Passthrough models are call-only and do
not appear in `miniplayer models` unless a matching catalog record also exists.

Bare IDs such as `claude-haiku-4-5` work when that is the catalog value. Other provider-prefixed
forms work only through an exact catalog value, a configured alias, or the approved passthrough rule.
For example, `-m claude-haiku-4-5` is a catalog match, while `-m claude/claude-haiku-4-5` would call
the literal model ID `claude-haiku-4-5` only if `claude` were an approved passthrough provider—it is
not. Unknown prefixes, unknown bare IDs, and ambiguous catalog matches are errors.

## Add a LiteLLM provider

Install the matching AI SDK provider package, import its factory in `src/providers.js`, and add one
entry to `LITELLM_PROVIDERS` with its API-key environment variable and factory. Keep provider mapping
explicit so a catalog row cannot silently route to the wrong API. Add missing-key and construction
coverage in `tests/providers.test.js` before enabling it.

## Test

```sh
npm test
```

Tests use the small catalog under `tests/fixtures/`; they do not load the production catalog.
