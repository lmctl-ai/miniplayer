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

Configuration is optional and lives at `~/.config/miniplayer/config.json`:

```json
{
  "model": "codex/gpt-5.3-codex-spark",
  "aliases": {
    "codex/gpt-5.3-codex-spark": "chatgpt/gpt-5.3-codex-spark",
    "claude/claude-haiku-4-5": "claude-haiku-4-5",
    "dsh/deepseek-v4-flash": "deepseek/deepseek-v4-flash-20260423"
  },
  "provider": {
    "openai": { "apiKey": "...", "baseURL": "https://api.openai.com/v1" },
    "anthropic": { "apiKey": "..." },
    "gemini": { "apiKey": "..." },
    "openrouter": { "apiKey": "...", "baseURL": "https://openrouter.ai/api/v1" }
  }
}
```

Aliases are resolved before an exact catalog lookup. Catalog matching is never fuzzy. Environment
credentials take precedence over config credentials:

| Route | Supported catalog provider | Environment variable |
| --- | --- | --- |
| OpenRouter | every `source: "openrouter"` row | `OPENROUTER_API_KEY` |
| LiteLLM / OpenAI | `openai`, `chatgpt` | `OPENAI_API_KEY` |
| LiteLLM / Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| LiteLLM / Google | `gemini`, `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |

## Commands

Run a one-shot prompt from an argument or stdin:

```sh
miniplayer run -m openai/gpt-4o-mini "Summarize this in one sentence"
printf '%s\n' 'Summarize this' | miniplayer run -m openai/gpt-4o-mini
```

Classify a team response from stdin (preferred) or a file:

```sh
printf '%s\n' 'The assigned fix is complete; send the next task.' |
  miniplayer classify -m codex/gpt-5.3-codex-spark
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
code `1` covers usage, catalog, configuration, credential, provider, and API errors. Exit code `2` is
reserved for a model response that cannot be parsed as a valid classifier object.

Selectors exact-match `gateway_id`, `vendor_model_id`, `source_model_id`, or `canonical_slug`.
No match and multiple matches are both errors; use a more specific catalog selector or an explicit
alias.

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
