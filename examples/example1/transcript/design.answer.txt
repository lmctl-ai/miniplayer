# Design: `notes` — a TypeScript CLI note taker

## Overview
A small command line note taker. Each note is a plain `.txt` file inside one
directory (`NOTES_DIR`, default `./notes`). The CLI never recurses, never
touches anything outside that directory, and uses only Node built-ins at
runtime (`node:fs`, `node:path`, `node:process`). All failures print one line
to stderr and exit non-zero.

## File layout
```
package.json          scripts, devDeps: typescript, tsx, @types/node
tsconfig.json         strict, module nodenext, rootDir ".", outDir "dist"
.gitignore            dist/, notes/, node_modules/
src/
  cli.ts              entry point: argv parsing, stdin, exit codes
  commands.ts         command implementations (create/list/show/overwrite/delete)
  notes.ts            notes-dir resolution, name validation, fs operations
  errors.ts           AppError + exit-code constants
test/
  notes.test.ts       unit tests for the fs/validation layer
  cli.test.ts         end-to-end tests spawning the CLI
notes/                default data directory (created on demand)
```
Build output mirrors this (`dist/src/...`, `dist/test/...`) so tests run
against either source or compiled sources.

## Module split
- **errors.ts** — `AppError { message, exitCode }`; codes `USAGE = 2`,
  `FAILURE = 1`. Nothing else in the codebase calls `process.exit`.
- **notes.ts** — the only module that touches the filesystem. Exports
  `validateName`, `resolvePath`, `createNote`, `overwriteNote`, `readNote`,
  `listNotes`, `deleteNote`. It is pure with respect to I/O targets: the notes
  directory is passed in, never read from `process.env` here, which makes unit
  testing trivial.
- **commands.ts** — one function per command. Maps argv/stdin input onto
  `notes.ts` calls, decides what goes to stdout, and translates missing-input
  cases into `AppError`.
- **cli.ts** — reads `process.argv.slice(2)`, resolves the notes directory from
  `NOTES_DIR` (falling back to `./notes`), parses the command word and
  positionals, supplies a stdin reader, dispatches, and sets
  `process.exitCode`. No options are defined, so the first token is always the
  command and later tokens are positional.

## Name validation and confinement
A note name must match `^[A-Za-z0-9_-]{1,64}$`. Anything else — empty, `.`,
`..`, slashes, backslashes, dots, spaces, absolute paths, NUL bytes — is
rejected with exit code 2 *before* any path is built. Validation, not path
normalisation, is the security boundary. As defence in depth, `resolvePath`
asserts that `path.dirname(joined) === notesDir` and otherwise raises an
internal error. The stored filename is always `<name>.txt`.

## Commands and error behaviour
| Command | Behaviour |
|---|---|
| `create <name> [text]` | Writes `<name>.txt`; fails if it already exists. |
| `list` | Prints note names without extension, sorted, one per line. Non-`.txt` files are ignored. Empty directory prints nothing, exit 0. |
| `show <name>` | Writes the file's bytes verbatim to stdout. |
| `overwrite <name> [text]` | Replaces an existing note; fails if missing. |
| `delete <name>` | Removes the note; fails if missing. |

When `[text]` is omitted, stdin is read to EOF and used verbatim (no trailing
newline is added or stripped). If the argument is present, stdin is not read at
all. If stdin is a TTY and `[text]` is omitted, the note is created empty.

Failures always produce one `error: <message>` line on stderr:

| Condition | Exit |
|---|---|
| Missing/unknown command, wrong arity, `NOTES_DIR` unusable | 2 |
| Invalid name | 2 |
| `create` on an existing note | 1 |
| `show`/`overwrite`/`delete` on a missing note | 1 |
| Filesystem error (EACCES, ENOSPC, …) | 1 |

Creating the notes directory is attempted lazily on write; `list` on a
nonexistent directory is treated as empty rather than an error.

## Build and test commands
Install: `npm install`
Build: `npm run build` → `tsc -p tsconfig.json`
Run compiled: `node dist/src/cli.js list`
Run from source: `npx tsx src/cli.ts list`
Test (source, default): `npm test` → `node --import tsx --test test`
Test (compiled): `npm run test:dist` → `npm run build && node --test dist/test`
Type-check only: `npx tsc --noEmit`

## Test plan
`test/notes.test.ts` (unit, against a fresh `mkdtemp` directory):
- validation table: accepted names (`a`, `A_1`, `my-note`, 64 chars) and
  rejected ones (`""`, `.`, `..`, `../x`, `a/b`, `a\\b`, `a b`, `a.txt`, `a.b`,
  65 chars, NUL).
- a traversal attempt (`../secret`) leaves the parent directory untouched.
- create writes expected content; create on existing note throws `AppError`
  with code 1.
- show/overwrite/delete on a missing note throw code 1; overwrite replaces
  content exactly.
- `listNotes` sorts, ignores `README.md` and subdirectories, and returns `[]`
  for a missing directory.

`test/cli.test.ts` (end-to-end, spawning `tsx src/cli.ts` via `execFile` with a
temporary `NOTES_DIR`): each command's stdout, stderr and exit code; text via
argument and via piped stdin, asserting argument precedence; empty stdin;
missing/unknown command and wrong arity give 2; invalid name gives 2 with no
file created; missing note gives 1; `list` output ordering across several
notes; round-trip `create` → `list` → `show` → `overwrite` → `delete`; content
preserved byte-for-byte including trailing newlines and non-ASCII text.

## Out of scope
Editing, search, subdirectories, file locking, a config file, and Windows
reserved-name handling.