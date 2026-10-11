# miniplayer

`miniplayer` is a small Node 20+ CLI for one-shot language-model calls. It selects models from the
model catalog (the schema-version-1 JSON that `lmprice` produces), routes them to a supported provider, and exits after one response.
The `run` command handles one user request, including any model/tool steps needed
to answer it. `classify` stays tool-free. `miniplayer acp` supports live multi-turn
conversations with native tools. Miniplayer does not stream individual tokens,
resume sessions after process exit, or compact context.

## Install

From this repository:

```sh
npm install
npm link
miniplayer --help
```

## Model catalog

miniplayer selects models from a published catalog: schema-version-1 JSON containing a `records`
array. The dataset is produced by the `lmprice` project (compiled from OpenRouter, LiteLLM, and
Moonshot public data) and published at:

```
https://lmctl.com/dataset/model_list.json
```

Miniplayer operates **online-first with a local cache**:
* **Cache directory**: `(XDG_CACHE_HOME or ~/.cache)/miniplayer/lmprice` containing `model_list.json`
  and `meta.json` (`{ etag, last_checked }`). Created with per-user permissions (`0o700` directory,
  `0o600` files).
* **TTL**: Defaults to 6 hours. Override with `MINIPLAYER_PRICE_TTL` in seconds (`0` forces a refresh).
  Inside the TTL with a valid cache, miniplayer performs **no network calls at all**.
* **ETag revalidation**: Outside the TTL, miniplayer issues a fast `HEAD` request (1,000 ms timeout)
  and compares the `ETag` client-side. If the ETag matches, only `last_checked` in `meta.json` is updated
  without downloading the payload. If the ETag changed, miniplayer downloads the new catalog via `GET`
  (10,000 ms timeout), validates its schema (`schema_version === 1` and `Array.isArray(records)`), and
  promotes it to cache atomically.
* **Offline resilience**: Any network, DNS, timeout, HTTP error, malformed JSON, or failed schema
  validation falls back **silently** to the existing valid cache on disk. A failed download never corrupts
  or replaces a good cache. If no valid cache exists and no network is available, miniplayer exits with
  an error naming the URL, the cache directory, and the `MINIPLAYER_LMPRICE_CATALOG` escape hatch.
* **Pinned local catalog**: Set `MINIPLAYER_LMPRICE_CATALOG=/path/to/model_list.json` to pin to a
  specific local file. Pinning disables network checks and cache lookups entirely, ensuring deterministic
  and reproducible behavior in offline and test environments.

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
Standalone `run`/`classify` calls retain their configured 60,000 ms default model timeout. ACP turns have no implicit deadline. Set positive-integer config `requestTimeoutMs` or
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

## ACP turns

```sh
miniplayer acp -m ollama/qwen2.5:14b
```

This command speaks newline-delimited JSON-RPC on stdin/stdout. It supports
`initialize`, `session/new`, `session/prompt`, and `session/cancel`.
Each live `session/new` may receive multiple prompts; miniplayer retains the conversation in
memory for that ACP process. It emits one `agent_message_chunk` containing the completed reply, followed by
an `end_turn` result. Cancelled turns return `cancelled`, abort the SDK request,
and retain known tool/model observations with partial status. There is no implicit ACP prompt timeout;
`requestTimeoutMs` continues to apply to the existing one-shot commands only.

Turn metadata lives in `$MINIPLAYER_HOME/sessions/<uuid>.json`, defaulting to
`$XDG_DATA_HOME/miniplayer` or `~/.local/share/miniplayer`. New files are private
and replaced atomically. They contain the working directory, creation/update
timestamps, selected provider/model, and per-turn input/output plus native usage
metadata when available. Credentials/config are not saved. The files are for
session readers such as `lmctl tail`, export, and cost reporting; they are never
replayed into a later provider request. Turns are marked `running`, `complete`,
`aborted`, or `failed`; input and any usage observed before cancellation or failure
remain recorded, while failed turns have no invented output. `responseId` is a
local stable accounting identity; a provider response ID is retained separately
as `nativeResponseId`. Usage carries `usageConvention` so readers know whether
input includes cached tokens, and Anthropic cache writes are exposed as
`cacheWriteInputTokens`. Missing usage fields remain absent.

The built-in `mock/Echo`, `mock/Adder`, `mock/RateLimit`, and `mock/ServerError` selectors are
test-only and bypass config, catalogs, credentials, and network access. `mock/Adder` retains its
numeric accumulator for live turns but accepts decimal notation only. Mock usage is synthetic and
recorded as zero tokens with `usageConvention: "synthetic"`.

ACP accepts text prompts and executes the same five native tools as `run`.
It accepts text and resource links (links are represented as text; they are not
fetched). It rejects images, audio, embedded resources, and nonempty `mcpServers`;
configure clients with `mcpServers: []`. It executes tools locally without requesting client filesystem or
terminal operations. All tools are granted; there is no permission mode or
interactive TUI. ACP protocol
version 1 is advertised; unsupported methods return a JSON-RPC error.

Only one writer may prompt a session at a time, even across ACP processes.
Normal cancellation, EOF, and SIGTERM/SIGINT release the session's `.json.lock`.
A hard crash can leave a lock; the error identifies it. Verify its recorded PID
is no longer active before removing that specific lock. Cold resume remains unsupported. Locks are
never stolen automatically.

Select miniplayer directly by provider/model and optionally choose its session
directory. It does not require a teamfile alias or a resumable session. Miniplayer
has no interactive terminal command.

## Native tools

Tool-capable models receive all five tools in `run` and live ACP sessions. There
are no permission prompts, plan mode, enable/disable flags, or workspace sandbox.
Relative paths resolve against the session working directory; absolute paths are
accepted. Explicit mock models remain deterministic and never execute tools.

| Tool | Arguments and bounds |
| --- | --- |
| `list_directory` | `path`, optional entry `offset` and `limit`; 200 entries by default, at most 1,000 |
| `read_file` | `path`, optional byte `offset` and `maxBytes`; 64 KiB by default, at most 256 KiB |
| `write_file` | `path`, UTF-8 `content`; atomically creates/replaces a regular file, at most 1 MiB, preserves an existing file's mode |
| `shell` | `command`, optional `cwd`; POSIX shell with at most 64 KiB of combined raw stdout/stderr retained |
| `webget` | HTTP(S) `url`, optional byte `offset` and `maxBytes`; streaming GET, 64 KiB default and 256 KiB maximum returned body |

Reads return `content`, `bytesRead`, `nextOffset`, `eof` and `truncated`. Offsets
are bytes, not line numbers; a slice through a UTF-8 code point can contain a
replacement character. Directory output includes entry names/types and paging
metadata. Symlink write targets and non-regular file read/write targets are
rejected. Parent directories for a new file must already exist.

`webget` follows redirects and returns status, final URL and content type.
Non-2xx bodies remain readable as bounded results. Its offsets apply to the
response byte stream, and unused body data is cancelled at the limit. It permits
localhost/private addresses, like other HTTP URLs. Shell output is drained even
when truncated. Neither tool adds its own time deadline; explicit cancellation
aborts a web request or terminates the owned shell process group, escalating
only for cancellation when descendants ignore SIGTERM.

The model/tool loop is bounded to 32 model steps. An unfinished tool loop is an
error, even if the last step contained interim text. Once a tool starts, a later
model error cannot trigger automatic pool failover that could repeat effects.
ACP emits correlated tool-call progress and stores per-model-step usage plus
bounded tool observations. Known observations survive failure/cancellation;
unknown usage or I/O stays unknown. Live context retains complete SDK tool-call
and tool-result messages. Observation files are never used for cold resume.

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

If a selector matches multiple catalog records, resolution fails as ambiguous with exit code `1`
naming the colliding `record_id`s (for example, `deepseek/deepseek-v4-flash` matches both `litellm`
and `openrouter` catalog rows). When listed in a config `pool`, an ambiguous entry is skipped with a
stderr warning rather than halting immediately, silently degrading failover coverage. Because
catalog lookup only matches `gateway_id`, `vendor_model_id`, `source_model_id`, and `canonical_slug`
(the `record_id` prefix like `litellm:...` is not a supported selector), disambiguate by targeting a
more specific catalog identifier—such as the OpenRouter canonical slug
`deepseek/deepseek-v4-flash-20260423`—or using a deterministic provider passthrough such as
`deepseek/deepseek-flash`.

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

The ACP integration test starts the real CLI and AI SDK against an ephemeral
localhost OpenAI-compatible endpoint. It verifies repeated prompts, restart/load,
cancellation, and process-shutdown lock cleanup without making live model calls.

A successful turn records the provider response model when supplied by the SDK,
falling back to the selected catalog model. Context-limit failures remain provider
errors. A failed initial turn leaves an empty metadata session with no resumable
conversation state.


## License and third-party software

MIT, copyright Lattice Systems LLC; see `LICENSE`. miniplayer depends on the Vercel AI SDK
(`ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`;
Apache-2.0) and their transitive dependencies (Apache-2.0, MIT, and BSD-3-Clause/AFL-2.1). They
are installed from npm and are not bundled or modified here. The provider mapping for
LiteLLM-sourced model ids follows [LiteLLM](https://github.com/BerriAI/litellm)'s provider names.
