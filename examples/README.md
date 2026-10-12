# Examples

## notes-project.lms — AI automation with stateless one-shot miniplayer calls

`lmscript` does everything risky and deterministic; `miniplayer` is only the brain (prompt in, text out, no tool use, no session).

```bash
export DEEPSEEK_API_KEY=...        # zero-config provider, see "Zero-config providers"
MINIPLAYER="miniplayer" lmscript examples/notes-project.lms deepseek/deepseek-v4.1-flash /tmp/notes-demo 5
```

Flow:

1. `miniplayer run` writes a **design document** from the requirements (a TypeScript CLI note taker: create / list / show / overwrite / delete, notes as `.txt` files in one directory).
2. A second, fresh `miniplayer run` **implements** the design. It replies with `=== FILE: path ===` blocks plus a last paragraph of `build_command: ...` and `test_command: ...` lines.
3. The script writes the files, then **runs the build and test commands** (`sh -c`, in the project directory).
4. On failure the error output, the design and the current files go to a new `miniplayer run` to **fix**; loop up to N rounds.
5. When both pass, one more call writes a **commit message**, and the script does `git init` + `git commit`.

Every miniplayer call is independent: the script re-sends whatever context the step needs. Session resume is a later addition.

The model's build/test commands are executed as written, so use a scratch directory.

### A real run (deepseek/deepseek-v4.1-flash, 2026-10-12)

Design (96 lines) -> implementation (10 files) -> round 0 failed (`npm test` error) -> one fix round rewrote 1 file -> build and 25 tests pass -> committed `Add create, list, show, overwrite, and delete commands`.

Honest caveat from checking the result by hand afterwards: all five commands work, names that try to escape the directory are rejected, and the 25 tests pass, but `create` fails with `ENOENT` when the notes directory does not exist yet, because the design never said to create it on first use. Passing tests only prove what the design asked for. A review step (another one-shot call that reads the design and the code) would be a natural next addition.
