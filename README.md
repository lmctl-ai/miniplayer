# miniplayer

`miniplayer` is a fast, lightweight Node 20+ CLI harness for language models built on one core principle:
**PROMPT IN, TEXT OUT**. It has no concept of skills or autonomous tool dependencies; it does not depend
on LLM provider tool-calling support, so it works reliably with weak local models (such as `ollama/qwen2.5:14b`
running without tool use).

In the `lmscript`-driven setting, the script decides everything: it runs tools, probes, and builds deterministically,
and puts the results directly into the prompt; miniplayer only interprets.

The core product story:
1. **Pure classifier & interpreter for `lmscript`** (stdin/file in, text/JSON out): fully deterministic, tool-free, and ideal for automation.
2. **Interactive assistant with external tools** (optional): accessible in interactive REPL (`chat`) and Agent Client Protocol (`acp`) when tools are configured.

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

## Zero-config providers

No config file is needed. Export the provider's API key and pick a model by its id:

```sh
export ANTHROPIC_API_KEY=...
miniplayer run -m anthropic/claude-opus-5-5 "Summarize this repository"
miniplayer providers            # every provider: sdk, base URL, key env var, key set yes/no
miniplayer models --routed      # every routed model id, and whether its key is set
miniplayer models --routed --provider xai --json
```

How it works: each catalog record miniplayer can call directly carries a ready-made route in its
`miniplayer` field (`{id, provider, model, sdk, base_url, key_env}`, published by lmprice). The
`-m` selector matches `miniplayer.id` first (for example `anthropic/claude-opus-5-5`,
`openai/gpt-6`, `gemini/gemini-3-pro`, `together_ai/meta-llama/...`, `openrouter/<gateway id>`,
`ollama/qwen2.5`), then the other id fields. The route alone decides the SDK
(`anthropic`, `openai`, `google` or `openai-compatible`), the base URL and the key env var, so
miniplayer needs no provider table of its own.

- **Brand-new models**: `<provider>/<any-model>` works for any provider the catalog routes, even if
  that exact model is not listed yet. An unknown provider fails with the list of known providers.
- **Keys**: read from the environment variable the route names (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, ...).
  miniplayer never stores keys and never prints them; a missing key fails with
  `Missing API key for <provider>: export <KEY_ENV>=...`. A plaintext `provider.<name>.apiKey` in the
  config file still works as a fallback but is discouraged.
- **Overrides**: the config file is only needed to change a base URL
  (`"provider": {"together_ai": {"baseURL": "https://proxy.example/v1"}}`).
- **Ollama** is keyless; `OLLAMA_HOST` (server origin) replaces the default `http://localhost:11434/v1`.
- **Older catalogs** (cached before the column existed, or pinned files without it) keep working
  through the built-in table below (`source: built-in` in `miniplayer providers`).

## Interaction modes

### 1. Interactive REPL (`miniplayer` or `miniplayer chat`)

When invoked on an interactive terminal (TTY) with no subcommands, or via `miniplayer chat`, miniplayer
starts an interactive REPL session:

```sh
miniplayer
miniplayer chat -m ollama/qwen2.5:14b
miniplayer chat -m ollama/qwen2.5:14b --no-context-files
miniplayer chat -m deepseek/deepseek-flash --system-file custom-sys.txt
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

### 2. Pure one-shot prompt (`miniplayer run`)

Execute a single prompt and exit immediately after receiving the response. `run` is **pure**: it never sends tools to the provider, includes no cwd preamble, and reads no context files. The model receives strictly the prompt given:

```sh
miniplayer run -m gpt-5-nano "Summarize this repository in three bullets"
cat prompt.txt | miniplayer run -m ollama/qwen2.5:14b
miniplayer run -m ollama/qwen2.5:14b --file prompt.txt
miniplayer run -m deepseek/deepseek-flash --system "You are an expert editor." "Review this diff"
miniplayer run -m ollama/qwen2.5:14b --system-file sys.txt < input.txt
```

One-shot runs do not trigger wrap-up by default. You can opt in to wrap-up by passing the `--wrapup` flag.

### 3. Pure response classification (`miniplayer classify`)

Classify a response from stdin or a file without tools or extra system material:

```sh
printf '%s\n' 'The assigned fix is complete; send the next task.' |
  miniplayer classify -m claude-haiku-4-5
miniplayer classify -m ollama/qwen2.5:14b --file response.txt
miniplayer classify -m ollama/qwen2.5:14b --system "Custom classification rules" --file response.txt
```

Classification outputs a single compact JSON object:

```json
{"label":"task-done","reason":"The current task is complete but more may remain","confidence":0.96}
```

### 4. Agent Client Protocol (`miniplayer acp`)

Miniplayer speaks JSON-RPC over stdin/stdout implementing the Agent Client Protocol (ACP):

```sh
miniplayer acp -m ollama/qwen2.5:14b
miniplayer acp -m deepseek/deepseek-flash --no-context-files
miniplayer acp -m deepseek/deepseek-flash --system-file agent-prompt.txt
```

ACP sessions initialize with dynamic system prompts (cwd preamble, tool outlines via parallel `--list`,
`AGENTS.md`, and `durable-memory/index.md`), execute configured external tools, and run context compaction
when conversations approach model token limits.

## Who decides the initial prompt (precedence)

Miniplayer follows strict precedence for constructing the system prompt:

1. **Level 1 — Explicit caller override (`--system <text>` or `--system-file <path>`)**:
   The caller owns the system prompt completely. Miniplayer injects **nothing else**: no cwd preamble, no tool outlines, and no context files. Supported across `run`, `classify`, `chat`, and `acp`.
2. **Level 2 — Context files (`AGENTS.md` and `durable-memory/index.md`)**:
   Context files are optional reference material:
   - In `run` and `classify`: Context files are **always OFF**.
   - In `chat` and `acp`: Context files are **ON by default**, but can be disabled via the `--no-context-files` CLI flag or by configuring `"contextFiles": false` in `~/.config/miniplayer/config.json`.
   - Missing context files are never an error (silently omitted).
3. **Level 3 — Configured tool outlines**:
   Outlines via `<command> --list` are gathered **only in interactive `chat` and `acp` sessions**, and only if the `tools` array in configuration is non-empty. `run` and `classify` never generate tool outlines or send tools.
4. **Default fallback**:
   If no system override is provided, interactive sessions receive the directory preamble, tool outlines (if tools are configured), and context files (if enabled). Pure `run` and `classify` receive no system prompt unless `--system` or `--system-file` is specified.

## External tools

Miniplayer has **no built-in tools**. Tools are an **optional feature** active only when declared in
`~/.config/miniplayer/config.json` (or `$MINIPLAYER_CONFIG`) AND the session is interactive (`chat` or `acp`).
In pure `run` and `classify` modes, miniplayer never exposes or sends tools to the provider.

Permissions and execution policies live within each standalone tool executable; miniplayer discovers tool outlines
via parallel `--list` calls and invokes tools directly as child processes. If no tools are configured, miniplayer
operates with zero tools.

### Function calling capability check

Miniplayer respects model catalog metadata. If a model's catalog entry specifies `capabilities.supports_function_calling === false`,
miniplayer **never** attempts to send tools to that model. If tools are configured, miniplayer prints a clear warning to stderr:
```
warning: Model <model_id> does not support tool calling; running without tools.
```
and executes the session tool-free. This allows weak local models (such as `ollama/qwen2.5:14b`) to run reliably without
failing on unsupported tool-calling schemas.

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
2. **Process group isolation and clean cancellation**: On POSIX, each tool is launched in a detached process group; cancellation sends SIGTERM and escalates to SIGKILL after 250 ms. Windows uses `taskkill /T /F` for the process tree. Explicit JavaScript file paths (`.js`, `.mjs`, `.cjs`) run through the current Node executable on every OS, without a shell or dependence on shebang support.
3. **Bounded I/O**: Standard output is capped at 256 KiB and standard error at 64 KiB. If limits are exceeded, remaining output is drained and discarded, and the tool result includes `truncated: true`.
4. **Resilient error handling**: Missing binaries (`ENOENT`) or spawn failures return structured tool error responses back to the model rather than crashing miniplayer.

## Levels and roles

Miniplayer is designed as a focused assistant and interpreter rather than a monolithic autonomous coder:

1. **Level 1 — No tools (Default)**: Classifier, summarizer, direct interpreter, or conversational assistant. Safe for unprivileged execution, rapid routing, and local models.
2. **Level 2 — Read-only inspection (`lmtools`, `lmprobe`)**: Inspector, code reviewer, and test failure analyzer. Can examine filesystem state, schemas, and probe diagnostic endpoints without mutation side-effects.
3. **Level 3 — Extended toolsets (`lmgit`, `lmgh`, `lmaws`, etc.)**: Coder's assistant, ticket updater, and operational helper.

Miniplayer is an interactive helper and reasoning component, not a standalone build-and-test runner. Heavy or risky workflows (such as repository-wide builds, deployments, or deterministic scripting) are driven by orchestrators like `lmscript`, which run deterministic recipes and pass outputs to miniplayer for interpretation and guidance.

## Session resume and context compaction

One-shot runs can resume too: `miniplayer run --session new --json "..."` returns a session id and
`miniplayer run --session <id> "..."` continues it (see `examples/example2`).

ACP sessions can be resumed across process restarts (`session/load`, `session/resume`; `loadSession: true`).
The store keeps each completed turn's text, so a resumed session rebuilds its history from those turns, in the
same working directory only. Tool steps inside a turn are not replayed, and a compaction summary is not
persisted. `session/load` also replays the stored turns as updates, as ACP requires. Inside live REPL and ACP
sessions, long-running conversations are managed through dynamic context compaction:

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
  "contextFiles": true,
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
- `contextFiles`: Boolean controlling whether interactive sessions (`chat`, `acp`) include `AGENTS.md` and `durable-memory/index.md` (default `true`).
- `compact`: Object with `thresholdRatio` (float, default 0.7) and/or `thresholdTokens` (integer) to control when context compaction triggers.
- `tools`: Array of tool command strings or `{ name, command, brief }` objects.
- `provider`: Map of provider credentials and settings (e.g., `apiKey`, `baseURL`).

### Provider credentials and environment variables

With a current catalog the route's `key_env` names the variable (see "Zero-config providers";
`miniplayer providers` lists them). The table below is the built-in fallback for catalog records
without a route. Environment variables take precedence over config credentials:

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

List chat-capable catalog models and optionally filter them (`id` is the selector to pass to `-m`;
`--json` for machine-readable output):

```sh
miniplayer models
miniplayer models --source openrouter --provider deepseek --max-input-price 1
miniplayer models --routed --provider anthropic     # id, provider, key_set (yes | no | keyless)
```

List providers with their route and whether the key env var is set right now (never its value):

```sh
miniplayer providers
miniplayer providers --json
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

## Manual check with local Ollama

While automated CI and test suites run hermetically without requiring external servers, a manual verification script is provided for developers testing against a real local Ollama instance (such as on WSL2):

```sh
# Defaults to http://localhost:11434 and ollama/qwen2.5:14b
./scripts/manual-ollama-check.sh

# Or with a custom host or model:
OLLAMA_HOST=http://172.18.32.1:11434 ./scripts/manual-ollama-check.sh ollama/qwen2.5:14b
```

The script verifies:
1. `miniplayer run -m <model> "prompt"` (pure prompt execution).
2. `miniplayer classify -m <model> --file <response>` (JSON classification).
3. `miniplayer run -m <model> --system-file <sys> < <input>` (caller-owned system prompt and piped input).

## Platforms

CI runs the hermetic suite on **Node 20 and 22** independently on `ubuntu-latest` (x64), `ubuntu-24.04-arm`, `macos-latest` (arm64), `macos-15-intel` and `windows-latest`. A final gate lists and requires all ten legs; no OS is continue-on-error. Tests are enumerated by a Node launcher rather than shell globs, and tool arguments are always passed without shell expansion.

POSIX permission-bit assertions and the Python `pty` Ctrl-C integration fixture require their native Unix facilities; those individual checks are explicitly reported as skipped on Windows (the rest of each suite still runs). Windows file privacy relies on the user profile's ACLs rather than Unix chmod bits. The manual Ollama shell script requires Bash; CI syntax-checks it using Git for Windows Bash on Windows. JavaScript tool files are launched with the active Node runtime, while native executables are launched directly.

## License

MIT, copyright Lattice Systems LLC; see `LICENSE`.
