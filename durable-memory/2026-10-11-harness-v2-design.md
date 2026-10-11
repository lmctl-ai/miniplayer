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
  - Cancellation sends SIGTERM to the process group (`-child.pid`), escalating to SIGKILL after 500 ms if needed.
  - Missing commands (`ENOENT`) return structured tool error results instead of crashing the harness.

### 2. Initial System Prompt Builder (`src/prompt-builder.js`)
Interactive sessions (REPL and ACP) initialize with a structured prompt:
- **Preamble**: Current working directory and execution environment (3-5 lines).
- **Tool Outlines**: Parallel execution of `<command> --list` across all configured tools (3-second timeout, 25-line cap), falling back to config `brief` or `--help`.
- **Project Guidelines**: Ingestion of `AGENTS.md` up to 32 KiB.
- **Durable Memory Index**: Ingestion of `durable-memory/index.md` up to 32 KiB with instructions directing the model to read referenced notes when relevant.

### 3. Context Compaction & Durable Notes (`src/compaction.js`)
- **No Cold Resume**: Miniplayer avoids resuming stale conversation logs from disk.
- **Dynamic Compaction**: Before sending prompts in REPL or ACP, context token usage is estimated (via `usage.inputTokens` or character heuristics `chars/4`).
- **Threshold**: Defaults to 70% of catalog context window (`context_window.total_tokens` or `input_tokens`), configurable via `compact.thresholdRatio` or `compact.thresholdTokens`, falling back to 100,000 tokens.
- **Compaction Execution**: Calls the model without tools, requesting JSON `{ summary, notes }`.
  - Replaces all but the last 2 user turns with `"Context summary: " + summary`.
  - Retains the last 2 user turns verbatim.
  - Writes `notes` to `durable-memory/<UTC yyyy-mm-dd-hhmm>-session-notes.md`.
  - Appends a reference link to `durable-memory/index.md`.
  - On compaction failure, gracefully preserves the uncompacted context and logs a warning.

### 4. Interactive REPL & Wrap-Up (`src/cli.js`)
- **TTY Default / `miniplayer chat`**: Simple interactive loop with `> ` prompt.
- **Trace Output**: Single-line stderr trace `[tool] <name> <args...>` without ANSI escapes.
- **Commands**: `/exit`, `/help`, `/compact`.
- **Interrupt Handling**: Ctrl-C aborts the active turn without terminating the REPL; Ctrl-C while idle exits.
- **Wrap-Up Turn**: On `/exit` or EOF, REPL runs a wrap-up model turn requesting durable memory updates. Can be disabled via `--no-wrapup` or config `wrapUp: false`. In `run` mode, wrap-up is opt-in via `--wrapup`.
- **Non-TTY Input**: Invoking `miniplayer` without arguments on non-TTY stdin acts as `miniplayer run` reading from stdin.

### 5. ACP Alignment (`src/acp.js`)
- Employs initial system prompt builder upon `session/new`.
- Integrates external tools configured for the session.
- Runs context compaction prior to model invocation in `session/prompt`.
- Maintains clean session lifecycle, signal handling, and JSON-RPC message framing.
