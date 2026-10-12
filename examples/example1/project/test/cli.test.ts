import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const compiled = path.basename(projectRoot) === 'dist';

const cliPath = path.join(projectRoot, 'src', compiled ? 'cli.js' : 'cli.ts');
const cliArgs = compiled ? [cliPath] : ['--import', 'tsx', cliPath];

interface RunOptions {
  notesDir: string;
  input?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawns the CLI and always closes its stdin so it can never wait forever. */
function run(args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [...cliArgs, ...args],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, NOTES_DIR: options.notesDir },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : undefined;
        if (code === undefined) {
          reject(error);
          return;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );

    child.stdin?.on('error', () => {
      /* the child may exit before reading its stdin */
    });
    child.stdin?.end(options.input ?? '');
  });
}

async function readNoteFile(notesDir: string, name: string): Promise<string> {
  return fs.readFile(path.join(notesDir, `${name}.txt`), 'utf8');
}

describe('cli', () => {
  let root = '';
  let notesDir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-cli-'));
    notesDir = path.join(root, 'notes');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('exits 2 with a single stderr line when no command is given', async () => {
    const result = await run([], { notesDir });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^error: .*\n$/);
  });

  it('exits 2 for an unknown command', async () => {
    const result = await run(['frobnicate'], { notesDir });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^error: unknown command: frobnicate\n$/);
  });

  it('exits 2 for wrong arity', async () => {
    const cases: string[][] = [
      ['create'],
      ['create', 'a', 'b', 'c'],
      ['list', 'extra'],
      ['show'],
      ['show', 'a', 'b'],
      ['overwrite'],
      ['overwrite', 'a', 'b', 'c'],
      ['delete'],
      ['delete', 'a', 'b'],
    ];
    for (const args of cases) {
      const result = await run(args, { notesDir });
      assert.equal(result.code, 2, `${args.join(' ')} -> ${result.stderr}`);
      assert.match(result.stderr, /^error: /);
      assert.deepEqual(await fs.readdir(root), []);
    }
  });

  it('exits 2 when NOTES_DIR is not a directory', async () => {
    const filePath = path.join(root, 'notes-file');
    await fs.writeFile(filePath, 'not a directory');
    const result = await run(['list'], { notesDir: filePath });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /not a directory/);
  });

  it('creates a note from an argument without touching stdin', async () => {
    const result = await run(['create', 'first', 'from argument'], {
      notesDir,
      input: 'from stdin',
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(await readNoteFile(notesDir, 'first'), 'from argument');
  });

  it('creates a note from stdin verbatim', async () => {
    const text = 'line one\nline two\n\n';
    const result = await run(['create', 'piped'], { notesDir, input: text });
    assert.equal(result.code, 0);
    assert.equal(await readNoteFile(notesDir, 'piped'), text);
  });

  it('creates an empty note from empty stdin', async () => {
    const result = await run(['create', 'empty'], { notesDir, input: '' });
    assert.equal(result.code, 0);
    assert.equal(await readNoteFile(notesDir, 'empty'), '');
  });

  it('exits 1 when creating a note that already exists', async () => {
    await run(['create', 'dup', 'one'], { notesDir });
    const result = await run(['create', 'dup', 'two'], { notesDir });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^error: note already exists: dup\n$/);
    assert.equal(await readNoteFile(notesDir, 'dup'), 'one');
  });

  it('exits 2 for an invalid name without creating anything', async () => {
    const result = await run(['create', '../escape', 'nope'], {
      notesDir,
      input: 'ignored',
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /invalid note name/);
    assert.deepEqual(await fs.readdir(root), []);
  });

  it('exits 1 for show/overwrite/delete on a missing note', async () => {
    const cases: string[][] = [
      ['show', 'ghost'],
      ['overwrite', 'ghost', 'x'],
      ['delete', 'ghost'],
    ];
    for (const args of cases) {
      const result = await run(args, { notesDir });
      assert.equal(result.code, 1, `${args.join(' ')} -> ${result.stderr}`);
      assert.match(result.stderr, /^error: note not found: ghost\n$/);
    }
  });

  it('shows the stored bytes verbatim', async () => {
    const text = 'héllo\n\nwörld\n';
    await run(['create', 'unicode', text], { notesDir });
    const result = await run(['show', 'unicode'], { notesDir });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, text);
  });

  it('lists notes sorted, and prints nothing for an empty or missing directory', async () => {
    let result = await run(['list'], { notesDir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');

    await run(['create', 'charlie', 'c'], { notesDir });
    await run(['create', 'alpha', 'a'], { notesDir });
    await run(['create', 'bravo', 'b'], { notesDir });

    result = await run(['list'], { notesDir });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'alpha\nbravo\ncharlie\n');

    result = await run(['list'], { notesDir: path.join(root, 'nowhere') });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('round-trips create -> list -> show -> overwrite -> delete', async () => {
    const created = await run(['create', 'todo', 'buy milk\n'], { notesDir });
    assert.equal(created.code, 0);

    const listed = await run(['list'], { notesDir });
    assert.equal(listed.stdout, 'todo\n');

    const shown = await run(['show', 'todo'], { notesDir });
    assert.equal(shown.code, 0);
    assert.equal(shown.stdout, 'buy milk\n');

    const overwritten = await run(['overwrite', 'todo'], { notesDir, input: 'buy bread\n' });
    assert.equal(overwritten.code, 0);
    assert.equal(await readNoteFile(notesDir, 'todo'), 'buy bread\n');

    const deleted = await run(['delete', 'todo'], { notesDir });
    assert.equal(deleted.code, 0);

    const after = await run(['list'], { notesDir });
    assert.equal(after.stdout, '');
    assert.deepEqual(await fs.readdir(notesDir), []);
  });

  it('preserves trailing newlines and non-ASCII text byte for byte', async () => {
    const text = 'ßeta\n\n\n☃ snowman ☃\n';
    await run(['create', 'bytes'], { notesDir, input: text });
    assert.equal(await readNoteFile(notesDir, 'bytes'), text);

    const shown = await run(['show', 'bytes'], { notesDir });
    assert.equal(shown.stdout, text);

    const overwritten = await run(['overwrite', 'bytes', text.trimEnd()], { notesDir });
    assert.equal(overwritten.code, 0);
    assert.equal(await readNoteFile(notesDir, 'bytes'), text.trimEnd());
  });
});
