# miniplayer

`miniplayer` is a lightweight, fast Node 20+ CLI harness for language models with pluggable external
tools, an interactive REPL, one-shot execution, structured classification, and Agent Client Protocol
(ACP) support. It selects models from the published catalog (schema-version-1 JSON), routes them to
supported providers, manages external tool execution, and compacts conversation context.

## Install

From this repository:

```sh
npm install
npm link
miniplayer --help
```

## Model catalog

miniplayer selects models from a published catalog: schema-version-1 JSON containing a `records`
array. The dataset is compiled from OpenRouter, LiteLLM, and Moonshot public data and published at:

```
https://lmctl.com/dataset/model_list.json
```

Miniplayer operates **online-first with a local cache**:
* **Cache directory**: `(XDG_CACHE_HOME or ~/.cache)/miniplayer/catalog` containing `model_list.json`
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
  an error naming the URL, the cache directory, and the `MINIPLAYER_CATALOG` escape hatch.
* **Pinned local catalog**: Set `MINIPLAYER_CATALOG=/path/to/model_list.json` to pin to a
  specific local file. Pinning disables network checks and cache lookups entirely, ensuring deterministic
  and reproducible behavior in offline and test environments.

## Interaction modes

### 1. Interactive REPL (`miniplayer` or `miniplayer chat`)

When invoked on an interactive terminal (TTY) with no subcommands, or via `miniplayer chat`, miniplayer
starts an interactive REPL session:

```sh
miniplayer
miniplayer chat -m ollama/qwen2.5:14b
```

- **Prompt**: Displays `> ` for user input. Empty lines are ignored.
- **Tool tracing**: Emits single-line status traces to stderr for each tool invocation: `[tool] <name> <args...>`.
- **Slash commands**:
  - `/exit`: Ends the session cleanly and runs a final wrap-up turn (unless disabled).
  - `/help`: Displays available slash commands and keybindings.
  - `/compact`: Triggers manual context compaction.
- **Turn cancellation & interrupt**: On an interactive TTY, pressing `Ctrl-C` while a model turn or tool is running cancels that turn and returns immediately to the prompt. Pressing `Ctrl-C` while idle at the prompt closes the session cleanly (running a final wrap-up turn unless disabled) and exits with status 0.
- **Wrap-up**: On exit (`/exit`, EOF, or idle `Ctrl-C`), miniplayer runs a final turn prompting the model to summarize critical session state into durable memory notes if necessary. Disable wrap-up via the `--no-wrapup` CLI flag or by setting `"wrapUp": false` in configuration.
- **Non-TTY fallback**: Running `miniplayer` without arguments when stdin is piped (non-TTY) automatically routes to `run` mode reading the prompt from stdin.

### 2. One-shot prompt (`miniplayer run`)

Execute a single prompt and exit immediately after receiving the response:

```sh
miniplayer run -m gpt-5-nano "Summarize this repository in three bullets"
cat prompt.txt | miniplayer run
```

One-shot runs do not trigger wrap-up by default. You can opt in to wrap-up by passing the `--wrapup` flag.

### 3. Response classification (`miniplayer classify`)

Classify a response from stdin or a file without tools:

```sh
printf '%s\n' 'The assigned fix is complete; send the next task.' |
  miniplayer classify -m claude-haiku-4-5
miniplayer classify -m claude-haiku-4-5 --file response.txt
```

Classification outputs a single compact JSON object:

```json
{"label":"task-done","reason":"The current task is complete but more may remain","confidence":0.96}
```

### 4. Agent Client Protocol (`miniplayer acp`)

Miniplayer speaks JSON-RPC over stdin/stdout implementing the Agent Client Protocol (ACP):

```sh
miniplayer acp -m ollama/qwen2.5:14b
```

ACP sessions initialize with dynamic system prompts (cwd preamble, tool outlines via parallel `--list`,
`AGENTS.md`, and `durable-memory/index.md`), execute configured external tools, and run context compaction
when conversations approach model token limits.

## External tools

Miniplayer has **no built-in tools**. Tools are supplied exclusively through configuration in
`~/.config/miniplayer/config.json` (or `$MINIPLAYER_CONFIG`). Permissions and execution policies live
within each standalone tool executable; miniplayer discovers tool outlines via parallel `--list` calls
and invokes tools directly as child processes. If no tools are configured, miniplayer operates with zero tools.

### Configuration

Tools are declared in the `tools` array as command strings or objects:

```json
{
  "tools": [
    "git",
    {
      "name": "lmgit",
      "command": "/usr/local/bin/lmgit",
      "brief": "Git operations tool"
    }
  ]
}
```

Tool names are normalized to `[a-zA-Z0-9_-]`.

### Security and execution model

1. **Direct child process execution**: Tools are spawned directly using `child_process.spawn(command, args, { shell: false })`. No shell is invoked, preventing shell interpolation and command injection vulnerabilities.
2. **Process group isolation and clean cancellation**: Each tool is launched in a detached process group. Aborting or cancelling a turn sends `SIGTERM` to the process group (`-pid`), escalating to `SIGKILL` after 250 ms if the process does not terminate.
3. **Bounded I/O**: Standard output is capped at 256 KiB and standard error at 64 KiB. If limits are exceeded, remaining output is drained and discarded, and the tool result includes `truncated: true`.
4. **Resilient error handling**: Missing binaries (`ENOENT`) or spawn failures return structured tool error responses back to the model rather than crashing miniplayer.

## Levels and roles

Miniplayer is designed as a focused assistant and interpreter rather than a monolithic autonomous coder:

1. **Level 1 — No tools (Default)**: Classifier, summarizer, direct interpreter, or conversational assistant. Safe for unprivileged execution and rapid routing.
2. **Level 2 — Read-only inspection (`lmtools`, `lmprobe`)**: Inspector, code reviewer, and test failure analyzer. Can examine filesystem state, schemas, and probe diagnostic endpoints without mutation side-effects.
3. **Level 3 — Extended toolsets (`lmgit`, `lmgh`, `lmaws`, etc.)**: Coder's assistant, ticket updater, and operational helper.

Miniplayer is an interactive helper and reasoning component, not a standalone build-and-test runner. Heavy or risky workflows (such as repository-wide builds, deployments, or deterministic scripting) are driven by orchestrators like `lmscript`, which run deterministic recipes and pass outputs to miniplayer for interpretation and guidance.

## Context compaction & no-resume policy

Miniplayer adheres to a **no-resume** policy: it does not reload old conversation history across process
restarts. Inside live REPL and ACP sessions, long-running conversations are managed through dynamic context
compaction:

- **Compaction threshold**: Evaluated before each model request. Context token usage is estimated from
  provider usage metadata or character heuristics (`chars / 4`). If usage exceeds 70% of the model's
  context window (configurable via `compact.thresholdRatio` or `compact.thresholdTokens`, fallback 100,000
  tokens), compaction is triggered.
- **Compaction turn**: Miniplayer calls the model without tools, requesting a JSON object with `{ summary, notes }`.
- **Context pruning**: All but the last two user turns are replaced with `Context summary: <summary>`. The last two user turns are retained verbatim to preserve immediate conversational context.
- **Durable memory update**: The generated `notes` are written to `durable-memory/<timestamp>-session-notes.md`, and a pointer is automatically appended to `durable-memory/index.md`.
- **Failure tolerance**: If compaction fails, miniplayer falls back to the uncompacted context with a stderr warning.

## Configuration file

Configuration lives at `~/.config/miniplayer/config.json`. Set `MINIPLAYER_CONFIG=/path/to/config.json`
to specify an alternative file path.

Example configuration:

```json
{
  "model": "deepseek/deepseek-flash",
  "requestTimeoutMs": 60000,
  "wrapUp": true,
  "compact": {
    "thresholdRatio": 0.7,
    "thresholdTokens": 100000
  },
  "tools": [
    "git",
    "lmgit"
  ],
  "provider": {
    "deepseek": { "apiKey": "..." }
  }
}
```

### Config options

- `model`: Default model selector string.
- `pool`: Array of model selectors to try in sequence or randomly.
- `poolOrdered`: When `true`, candidates in `pool` are tried in strict order rather than shuffled.
- `requestTimeoutMs`: Request timeout in milliseconds for one-shot commands (default 60,000 ms).
- `wrapUp`: Boolean controlling whether REPL exit runs a durable-memory wrap-up turn (default `true`).
- `compact`: Object with `thresholdRatio` (float, default 0.7) and/or `thresholdTokens` (integer) to control when context compaction triggers.
- `tools`: Array of tool command strings or `{ name, command, brief }` objects.
- `provider`: Map of provider credentials and settings (e.g., `apiKey`, `baseURL`).

### Provider credentials and environment variables

Environment variables take precedence over config credentials:

| Route | Supported catalog provider | Environment variable |
| --- | --- | --- |
| OpenRouter | every `source: "openrouter"` row | `OPENROUTER_API_KEY` |
| LiteLLM / OpenAI | `openai`, `chatgpt` | `OPENAI_API_KEY` |
| LiteLLM / Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| LiteLLM / Google | `gemini`, `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| LiteLLM / Moonshot | `moonshot` | `MOONSHOT_API_KEY` |
| LiteLLM / DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Local Ollama | `ollama` | `OLLAMA_HOST` (optional; no API key) |

Ollama defaults to `http://localhost:11434/v1`. Set `OLLAMA_HOST` to the server origin (such as
`http://172.18.32.1:11434`). A configured `provider.ollama.baseURL` overrides the derived URL.

## Using ACP in lmctl Teamfiles

Miniplayer integrates directly with `lmctl` as an ACP provider. You can configure miniplayer as a member
inside an `lmctl` Teamfile:

```
_MEMBER_ alias=Worker provider=miniplayer model=anthropic/claude-3-5-sonnet sessiondir=.
```

In `lmctl`, the miniplayer profile invokes `miniplayer acp`. Configured tools from `~/.config/miniplayer/config.json`
are made available to the member, and conversation turns are processed through ACP JSON-RPC.

## Commands reference

List chat-capable catalog models and optionally filter them:

```sh
miniplayer models
miniplayer models --source openrouter --provider deepseek --max-input-price 1
```

Run one-shot prompt:

```sh
miniplayer run -m deepseek/deepseek-flash "Summarize recent commits"
```

Start interactive chat:

```sh
miniplayer chat -m ollama/qwen2.5:14b
```

Run ACP daemon:

```sh
miniplayer acp -m deepseek/deepseek-flash
```

## Test

Run the hermetic test suite:

```sh
npm test
```

Unit tests use fixtures such as `tests/fixtures/faketool.js` to simulate external tools, and do not make network calls.

## License

MIT, copyright Lattice Systems LLC; see `LICENSE`.
