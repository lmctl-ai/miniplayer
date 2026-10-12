# example1 — AI automation with stateless one-shot miniplayer calls

`lmscript` does everything deterministic and risky; `miniplayer` is only the brain (prompt in, text out, no tool use, no session).

- `notes-project.lms` — the script.
- `project/` — the project it produced, checked in as generated (no hand edits).
- `transcript/` — every prompt sent to miniplayer, every answer, and the run log.

```bash
export DEEPSEEK_API_KEY=...        # zero-config provider, see "Zero-config providers" in the main README
MINIPLAYER="miniplayer" lmscript examples/example1/notes-project.lms deepseek/deepseek-v4.1-flash /tmp/notes-demo 5
```

Flow:

1. `miniplayer run` writes a **design document** from the requirements (a TypeScript CLI note taker: create / list / show / overwrite / delete, notes as `.txt` files in one directory).
2. A second, fresh `miniplayer run` **implements** the design. It replies with `=== FILE: path ===` blocks plus a last paragraph of `build_command: ...` and `test_command: ...` lines.
3. The script writes the files, then **runs the build and test commands** (`sh -c`, in the project directory).
4. On failure, the error output, the design and the current files go to a new `miniplayer run` to **fix**; loop up to N rounds.

Creating the git repository is left to the caller. Every miniplayer call is independent: the script re-sends whatever context the step needs (session resume is a later addition). The model's build/test commands are executed as written, so use a scratch directory.

## The run checked in here (deepseek/deepseek-v4.1-flash, 2026-10-12)

Design -> implementation (12 files) -> build and 22 tests pass on round 0, no fix rounds needed. Checked by hand afterwards: all five commands work, names that try to escape the directory are rejected, and `create` works when the notes directory does not exist yet.

An earlier run of the same script needed one fix round (the first `npm test` failed, the error went back to miniplayer, one file was rewritten, then everything passed). That run also produced a `create` that failed on a missing notes directory, because the design never said to create it: passing tests only prove what the design asked for. Runs differ; that is the nature of the brain being a model.
