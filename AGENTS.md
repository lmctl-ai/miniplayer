# AGENTS.md — Contributor & Agent Guide for Miniplayer (Harness v2)

Welcome to `miniplayer`. This repository provides a fast, minimal Node 20+ ESM harness for language models built on the core principle: **PROMPT IN, TEXT OUT**.

Miniplayer has no concept of skills or autonomous tool dependencies; it does not depend on provider tool-calling support, ensuring reliable operation even with weak local models (such as `ollama/qwen2.5:14b`). In the `lmscript`-driven setting, the orchestrator script decides everything: it runs deterministic recipes, tools, and probes, feeding structured output directly into the prompt. Miniplayer serves as an interpreter and classifier.

## Core Architecture & Design Principles

1. **Pure One-Shot Execution (`run`, `classify`)**:
   - `miniplayer run` and `miniplayer classify` are **pure**: the model receives strictly what the caller provided (stdin, argv, `--file`), plus an optional caller system prompt (`--system <text>` or `--system-file <path>`).
   - No working directory preamble, no tool outlines, and no context files are injected.
   - Tools are **never** passed to the provider in `run` or `classify`.
   - Wrap-up does not run by default (opt-in via `--wrapup`).
2. **Context Files are Optional Material**:
   - `AGENTS.md` and `durable-memory/index.md` are optional prompt material.
   - In `run` and `classify`: Context files are **always OFF** (never read).
   - In `chat` and `acp`: Context files are ON by default, but toggleable via `--no-context-files` / `--context-files` or config `"contextFiles": false`.
   - Missing or unreadable context files are non-fatal and omitted silently.
3. **Prompt Precedence & Ownership**:
   - The caller owns the system prompt completely when passing `--system <text>` or `--system-file <path>`.
   - When specified, this replaces all built-in composition across all modes (`run`, `classify`, `chat`, `acp`) with no preamble, no tool outlines, and no context files.
   - In `chat` and `acp` without caller overrides, the system prompt composes: preamble, tool outlines (if configured and supported), and context files (if enabled).
4. **External Tools Demoted to Optional Feature (`src/external-tools.js`)**:
   - Miniplayer ships with NO built-in tools.
   - Tools are active only when configured in `~/.config/miniplayer/config.json` (or `$MINIPLAYER_CONFIG`) AND the session is interactive (`chat` or `acp`).
   - **Capability Gate**: If the catalog entry for the selected model defines `capabilities.supports_function_calling === false`, miniplayer warns on stderr (`warning: Model <id> does not support tool calling; running without tools.`) and executes tool-free without sending tools to the provider.
   - Configured tools are spawned directly via `child_process.spawn(command, args, { shell: false })` in a detached process group, with bounded output (256 KiB stdout, 64 KiB stderr, `truncated` flags), clean cancellation (SIGTERM then SIGKILL to process group), and EPIPE tolerance on stdin.
5. **Interactive REPL & ACP (`src/cli.js`, `src/acp.js`)**:
   - REPL (`miniplayer` on TTY or `miniplayer chat`): prompts `> `, displays single-line stderr tool traces `[tool] <name> <args...>`, and supports `/exit`, `/help`, `/compact`, and Ctrl-C turn cancellation (cancels running turn; idle Ctrl-C exits 0 with wrap-up).
   - Wrap-up: When exiting REPL (via `/exit`, EOF, or idle Ctrl-C), a final turn summarizes session notes into durable memory. Disable via `--no-wrapup` or config `wrapUp: false`.
   - ACP: Implements Agent Client Protocol JSON-RPC over stdin/stdout.
6. **No Cold Resume & Context Compaction (`src/compaction.js`)**:
   - Miniplayer does not restore past sessions across process restarts.
   - In live sessions exceeding compaction thresholds, a tool-free compaction turn generates `{ summary, notes }`. Older turns are folded into a summary block, the last 2 user turns remain verbatim, notes are written to `durable-memory/<timestamp>-session-notes.md`, and pointers are appended to `durable-memory/index.md`.

## Provider routing (catalog routes)

- A catalog record with `miniplayer: {id, provider, model, sdk, base_url, key_env}` (lmprice) is
  routed from that field alone in `src/providers.js` (`catalogRoute`): sdk -> AI SDK factory,
  baseURL = config `provider.<p>.baseURL` > `OLLAMA_HOST`+/v1 (ollama) > record `base_url` > SDK
  default, apiKey = `env[key_env]` > config `provider.<p>.apiKey` (discouraged), `key_env: null` =
  keyless. Do not add provider knowledge on this path.
- Selectors match `miniplayer.id` first (`src/catalog.js findSelectorMatches`); `<provider>/<model>`
  passes through for any catalog-routed provider (`createRoutedPassthroughRecord`).
- `LITELLM_PROVIDERS` + `createPassthroughRecord` are the fallback for records without the column
  (old caches, fixtures); their routes must stay unchanged (the existing provider tests pin them).
- Errors name the env var to export, never a key value. `miniplayer providers` / `models --routed`
  report key_set yes/no/keyless only.

## Running Tests

All tests are hermetic and run via Node's native test runner without network or external tool dependencies:

```bash
npm test
```

Unit tests use `tests/fixtures/faketool.js` to simulate external tools, and mock OpenAI/catalog responses locally.

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

## Manual Ollama Verification

To verify real behavior on WSL2 or local setups with Ollama:

```bash
./scripts/manual-ollama-check.sh
```

Tests `run`, `classify`, and `run --system-file` against `OLLAMA_HOST` (default `http://localhost:11434`) using `ollama/qwen2.5:14b`.

## Testing via ACP

Miniplayer implements ACP JSON-RPC over stdin/stdout:

```bash
miniplayer acp -m ollama/qwen2.5:14b
```

Send JSON-RPC requests (`initialize`, `session/new`, `session/prompt`, `session/cancel`). To test offline without API keys or models, use synthetic mock selectors such as `-m mock/Echo` or `-m mock/Adder`.
