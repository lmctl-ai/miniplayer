# AGENTS.md — Contributor & Agent Guide for Miniplayer (Harness v2)

Welcome to `miniplayer`. This repository provides a fast, minimal Node 20+ ESM harness for language models with pluggable external tools, interactive REPL, and Agent Client Protocol (ACP) support.

## Harness v2 Design Overview

1. **Zero Built-In Tools**: Miniplayer ships with NO built-in tools. Tools are supplied exclusively through configuration (`~/.config/miniplayer/config.json` or `$MINIPLAYER_CONFIG`). Missing or empty `tools` config means zero tools are exposed.
2. **External Tool Bridge (`src/external-tools.js`)**: Configured tools are exposed to the AI SDK as function tools taking `{ args: string[], stdin?: string }`. Each tool execution spawns a child process (`shell: false`) with detached process group, bounded output buffers (256 KiB stdout, 64 KiB stderr, `truncated` flags), and clean cancellation (SIGTERM then SIGKILL after 250 ms to process group).
3. **Initial Prompt Composition (`src/prompt-builder.js`)**: Every interactive REPL or ACP session builds a system prompt from:
   - Preamble with current working directory.
   - Outlines from configured external tools run in parallel with `--list` (3s timeout, 25-line cap, fallback to config `brief` or `--help`).
   - Project instructions from `AGENTS.md` (capped at 32 KiB).
   - Knowledge index from `durable-memory/index.md` (capped at 32 KiB) with instructions to read notes with configured tools as needed.
4. **Lifecycle & Wrap-Up (`src/cli.js`, `src/acp.js`)**:
   - REPL (`miniplayer` on TTY or `miniplayer chat`): prompts `> `, displays single-line tool traces `[tool] <name> <args...>` on stderr, supports `/exit`, `/help`, `/compact`, and Ctrl-C turn cancellation (cancels running turn; idle Ctrl-C exits 0 with wrap-up).
   - Wrap-up: When exiting REPL (via `/exit` or EOF), a final turn is requested to update durable memory. Disable via `--no-wrapup` or config `wrapUp: false`. One-shot `miniplayer run` can opt in via `--wrapup`.
5. **No Cold Resume & Context Compaction (`src/compaction.js`)**: Miniplayer does not restore past sessions across restarts. When conversation length exceeds the compaction threshold (default 70% of catalog context window or 100k tokens), miniplayer calls the model without tools to generate a summary and notes. Older turns are replaced with `Context summary: <summary>`, the last 2 user turns remain verbatim, notes are written to `durable-memory/<UTC yyyy-mm-dd-hhmmss>-session-notes.md`, and `durable-memory/index.md` is updated.

## Running Tests

All tests are hermetic and run via Node's native test runner without network or external tool dependencies:

```bash
npm test
```

Unit tests use `tests/fixtures/faketool.js` to simulate external tools.

## Adding a Tool to Configuration

Add an entry to `~/.config/miniplayer/config.json`:

```json
{
  "tools": [
    "git",
    {
      "name": "lmgit",
      "command": "lmgit",
      "brief": "Git operations tool"
    }
  ]
}
```

Tool names are sanitized to `[a-zA-Z0-9_-]`. The command must be an executable binary in `$PATH` or an absolute path.

## Testing via ACP

Miniplayer implements ACP JSON-RPC over stdin/stdout:

```bash
miniplayer acp -m ollama/qwen2.5:14b
```

Send JSON-RPC requests (`initialize`, `session/new`, `session/prompt`, `session/cancel`). To test offline without API keys or models, use synthetic mock selectors such as `-m mock/Echo` or `-m mock/Adder`.
