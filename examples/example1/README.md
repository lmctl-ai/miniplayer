# example1 — AI automation with stateless one-shot miniplayer calls

`lmscript` does everything deterministic and risky; `miniplayer` is only the brain (prompt in, text out, no tool use, no session).

- `notes-project.lms` — the script (~115 lines).
- `project/` — the project it produced, checked in as generated (no hand edits).
- `transcript/` — every prompt sent to miniplayer, every answer, and the run log.

```bash
export DEEPSEEK_API_KEY=...        # zero-config provider, see "Zero-config providers" in the main README
lmscript notes-project.lms deepseek/deepseek-v4.1-flash /tmp/notes-demo 5
```

miniplayer runs as a **managed lmctl provider** (`lm_agent({provider: "miniplayer", model: ...}, prompt)`, the same path as `lmctl prompt --provider miniplayer`), so `lmctl ls` and `lmctl cost` see every call. `miniplayer` must be on PATH. No timeouts are set in the script.

The script needs the agent-file helpers added to lmscript (`parse_file_blocks`, `write_files`, `read_tree`, `format_file_blocks`, `kv_from_last_paragraph`, `split_command`, `system` with `{cwd}`); see `lmscript help agent-files` in a version that has them.

Flow:

1. `lm_agent` writes a **design document** from the requirements (a TypeScript CLI note taker: create / list / show / overwrite / delete, notes as `.txt` files in one directory).
2. A second, fresh call **implements** the design. It replies with `=== FILE: path ===` blocks plus a last paragraph of `build_command: ...` and `test_command: ...` lines.
3. The script writes the files (`write_files` refuses any path that escapes the project directory) and **runs the build and test commands** with no shell (`split_command` + `system`, `cwd` = project).
4. On failure, the error output, the design and the current files (`read_tree`) go to a new call to **fix**; loop up to N rounds.

Creating the git repository is left to the caller. Every call is independent: the script re-sends whatever context the step needs (session resume is a later addition). The model's build/test commands are executed as written (no shell operators allowed), so use a scratch directory.

## The run checked in here (deepseek/deepseek-v4.1-flash, 2026-10-12)

Design -> implementation (9 files) -> round 0 failed -> one fix round rewrote 1 file -> build and 39 tests pass. Checked by hand afterwards: all five commands work, a name like `../x` is rejected, `create` works when the notes directory does not exist yet.

Runs differ, because the brain is a model. Earlier runs of the same flow once needed no fix round and once produced a `create` that failed on a missing notes directory (the design never said to create it): passing tests only prove what the design asked for.
