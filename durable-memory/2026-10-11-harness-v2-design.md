# Harness v2 Refactor Design & Implementation (2026-10-11)

## Context & Rationale

Miniplayer v1 provided five built-in tools (`list_directory`, `read_file`, `write_file`, `shell`, `webget`) coupled directly to the agent harness. As the ecosystem evolved toward modular CLI tools (such as `@lmctl-ai/lmgit`, `@lmctl-ai/lmgh`, `@lmctl-ai/lmaws`), maintaining hard-coded built-in tools introduced unnecessary surface area, rigid execution assumptions, and potential security issues.

Harness v2 re-architects Miniplayer around external tools, dynamic prompt construction, context compaction, and clear operational lifecycles for both interactive and agent-protocol modes.

## Architectural Changes

### 1. External Tool Bridge (`src/external-tools.js`)
- **Zero Built-In Tools**: All built-in tools (`src/tools.js`) were removed. Tools are provided exclusively via user configuration (`~/.config/miniplayer/config.json` or `$MINIPLAYER_CONFIG`).
- **Bridge Semantics**: Each configured tool is exposed as an AI SDK tool taking `{ args: string[], stdin?: string }`.
- **Safe Child Process Spawning**:
  - `child_process.spawn(command, args, { shell: false, cwd, env: process.env })`.
  - Executed without shell interpolation, preventing argument injection.
  - Spawned in a detached process group (`detached: true`).
  - Output bounded to 256 KiB stdout and 64 KiB stderr, setting a `truncated: true` flag if truncated.
  - Cancellation sends SIGTERM to the process group (`-child.pid`), escalating to SIGKILL after 250 ms if needed.
  - Missing commands (`ENOENT`) return structured tool error results instead of crashing the harness.
  - `child.stdin.on('error', () => {})` ignores EPIPE when a tool exits early without consuming stdin.
  - Validates tool names against prototype injection (`__proto__`, `constructor`, `prototype`), duplicates, and names > 64 chars. Tools map instantiated with `Object.create(null)`.

### 2. Initial System Prompt Builder (`src/prompt-builder.js`)
Interactive sessions (REPL and ACP) initialize with a structured prompt:
- **Preamble**: Current working directory and execution environment (3-5 lines).
- **Tool Outlines**: Parallel execution of `<command> --list` across all configured tools (3-second timeout, 25-line cap), falling back to config `brief` or `--help`. Runaway `--list` processes are terminated with process-group SIGKILL at 32 KiB cap, and stderr is drained.
- **Project Guidelines**: Ingestion of `AGENTS.md` up to 32 KiB (read failures isolated with stderr warning, non-fatal).
- **Durable Memory Index**: Ingestion of `durable-memory/index.md` up to 32 KiB with instructions directing the model to read referenced notes with configured tools as needed (read failures isolated with stderr warning, non-fatal).

### 3. Context Compaction & Durable Notes (`src/compaction.js`)
- **No Cold Resume**: Miniplayer avoids resuming stale conversation logs from disk.
- **Dynamic Compaction**: Before sending prompts in REPL or ACP, context token usage is estimated (via last turn's `usage.inputTokens` or character heuristics `chars/4`).
- **Threshold**: Defaults to 70% of catalog context window (`context_window.total_tokens` or `input_tokens`), configurable via `compact.thresholdRatio` or `compact.thresholdTokens`, falling back to 100,000 tokens.
- **Compaction Execution**: Calls the model without tools (empty `tools: {}` prevents tool re-injection), requesting JSON `{ summary, notes }`.
  - Folds summary directly into the first kept user turn (`"Context summary: ... \n\n<original user turn>"`) to maintain strict user/assistant message alternation.
  - Retains the last 2 user turns.
  - Writes `notes` to `durable-memory/<UTC yyyy-mm-dd-hhmmss>-session-notes.md` with collision suffix retry (`wx` flag).
  - Appends reference link to `durable-memory/index.md` (handling missing newline to prevent corrupting previous lines).
  - On compaction failure, gracefully preserves the uncompacted context and logs a warning.

### 4. Interactive REPL & Wrap-Up (`src/cli.js`)
- **TTY Default / `miniplayer chat`**: Simple interactive loop with `> ` prompt.
- **Trace Output**: Single-line stderr trace `[tool] <name> <args...>` without ANSI escapes.
- **Commands**: `/exit`, `/help`, `/compact`.
- **Interrupt Handling**: On TTY, readline intercepts `SIGINT`. Pressing Ctrl-C while a turn or tool runs aborts that turn and returns to prompt. Pressing Ctrl-C while idle exits with status 0 (running wrap-up).
- **No REPL Timeout**: Chat turns pass `timeoutMs: 0` so extended tool reasoning turns are not aborted by the 60s one-shot deadline.
- **Wrap-Up Turn**: On `/exit`, EOF, or idle Ctrl-C, REPL runs a wrap-up model turn requesting durable memory updates. Can be disabled via `--no-wrapup` or config `wrapUp: false`. In `run` mode, wrap-up is opt-in via `--wrapup`.
- **Non-TTY Input**: Invoking `miniplayer` without arguments on non-TTY stdin acts as `miniplayer run` reading from stdin.
- **Strict Config Validation**: Malformed JSON or invalid schema in `~/.config/miniplayer/config.json` fails fast with an exit code 1 naming the offending file and field.

### 5. ACP Alignment (`src/acp.js`)
- Employs initial system prompt builder upon `session/new`.
- Integrates external tools configured for the session; updates default to `kind: 'execute'`.
- Runs context compaction prior to model invocation in `session/prompt`, tracking last turn's usage input tokens.
- Invalid configuration returns JSON-RPC error code -32602 naming the file and field.
- Maintains clean session lifecycle, signal handling, and JSON-RPC message framing.

## Levels and Roles

Miniplayer operates at three distinct operational levels:

1. **Level 1 — No Tools (Default)**:
   - Classifier, summarizer, direct translator, or simple conversational agent.
   - Zero tool configuration required; completely unprivileged and safe for rapid evaluation.
2. **Level 2 — Read-Only Inspection (`lmtools`, `lmprobe`)**:
   - Inspector, code reviewer, documentation searcher, and test failure analyzer.
   - Read-only tools allow deep inspection of repo trees, schema definitions, and system diagnostics without modification side-effects.
3. **Level 3 — Extended Toolsets (`lmgit`, `lmgh`, `lmaws`, etc.)**:
   - Coder's assistant, issue and PR updater, deployment helper.
   - Note on role: Miniplayer is an interactive reasoning assistant and synthesizer, NOT a standalone monolithic coder or test runner. Risky or deterministic operations (such as compiling code, running full test suites, or multi-step release scripts) belong in deterministic orchestrators like `lmscript`. `lmscript` executes recipes reliably and feeds structured results to miniplayer for interpretation and diagnosis.

## Design Correction: Prompt In, Text Out & Optional Tool Support (2026-10-11)

### Context & Principle
The owner clarified the foundational principle of Miniplayer:
**PROMPT IN, TEXT OUT**.

Miniplayer has no concept of skills or autonomous tool dependencies; it does not depend on provider tool-calling support, ensuring it works reliably with weak local models (such as `ollama/qwen2.5:14b`, which do tool use badly). In an `lmscript`-driven environment, the script decides everything: it runs deterministic recipes, tools, and probes, feeding structured output directly into the prompt. Miniplayer's role is purely interpretation and classification.

### Key Corrections
1. **Pure One-Shot Execution (`run`, `classify`)**:
   - `miniplayer run` and `miniplayer classify` are pure: the model receives exactly what the caller passed (`stdin`, argv, `--file`), plus an optional caller system prompt (`--system <text>` or `--system-file <path>`).
   - No working directory preamble, no tool outlines, no context files (`AGENTS.md`, `durable-memory/index.md`), and no wrap-up (unless `--wrapup`).
   - No tools are ever passed in the provider request body.
2. **Context Files are Optional Everywhere**:
   - `run` and `classify`: Context files are OFF (never read).
   - `chat` and `acp`: Context files are ON by default, but toggleable via `--no-context-files` / `--context-files` or config `"contextFiles": false`.
   - Missing or unreadable context files are non-fatal and silently omitted.
   - Caller system prompt overrides (`--system <text>` or `--system-file <path>`): caller owns the system prompt completely; when provided, miniplayer skips preambles, tool outlines, and context files.
3. **Demoted External Tool Support**:
   - Tools are an optional feature active only in interactive sessions (`chat`, `acp`) when `tools` are configured.
   - Catalog capability check: If a selected model has `capabilities.supports_function_calling === false`, miniplayer warns on stderr (`warning: Model <id> does not support tool calling; running without tools.`) and executes tool-free without sending tools to the provider.
4. **Local Ollama Support**:
   - Automated test suite remains hermetic using local OpenAI-compatible stubs.
   - Added `scripts/manual-ollama-check.sh` allowing WSL2 team members to verify `run`, `classify`, and `run --system-file` against local Ollama (`ollama/qwen2.5:14b`, honoring `OLLAMA_HOST`).

### CHANGELOG
- **cli**: Added `--file`, `--system`, `--system-file`, `--compact` flags to `run` and `classify`.
- **cli/acp**: Added `--system`, `--system-file`, `--context-files`, and `--no-context-files` flags to `chat` and `acp`.
- **prompt-builder**: Added `includeContextFiles` option to `buildInitialSystemPrompt`.
- **config**: Added boolean `contextFiles` setting to config schema.
- **pool/providers**: Added tool-calling capability check against `capabilities.supports_function_calling === false`, emitting stderr warning and stripping tools.
- **scripts**: Added `scripts/manual-ollama-check.sh` and syntax/executable validation test.
