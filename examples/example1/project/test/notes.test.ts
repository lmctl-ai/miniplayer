import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { AppError, FAILURE, USAGE } from '../src/errors.js';
import {
  createNote,
  deleteNote,
  listNotes,
  overwriteNote,
  readNote,
  resolvePath,
  validateName,
} from '../src/notes.js';

function exitedWith(code: number): (error: unknown) => boolean {
  return (error: unknown): boolean => error instanceof AppError && error.exitCode === code;
}

describe('validateName', () => {
  const accepted = ['a', 'A_1', 'my-note', 'x'.repeat(64)];

  for (const name of accepted) {
    it(`accepts ${JSON.stringify(name.length > 20 ? `${name.slice(0, 16)}...` : name)}`, () => {
      assert.doesNotThrow(() => {
        validateName(name);
      });
    });
  }

  const rejected: Array<[string, string]> = [
    ['empty string', ''],
    ['a single dot', '.'],
    ['double dots', '..'],
    ['parent traversal', '../x'],
    ['a forward slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a space', 'a b'],
    ['a .txt extension', 'a.txt'],
    ['a dot in the middle', 'a.b'],
    ['65 characters', 'x'.repeat(65)],
    ['a NUL byte', 'a\u0000b'],
  ];

  for (const [label, name] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => {
        validateName(name);
      }, exitedWith(USAGE));
    });
  }
});

describe('notes filesystem layer', () => {
  let root = '';
  let notesDir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'notes-unit-'));
    notesDir = path.join(root, 'notes');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves note paths inside the notes directory', () => {
    const dir = path.resolve('/tmp/notes');
    assert.equal(resolvePath(dir, 'a'), path.join(dir, 'a.txt'));
  });

  it('refuses a traversal name and leaves the parent directory untouched', async () => {
    await assert.rejects(createNote(notesDir, '../secret', 'nope'), exitedWith(USAGE));
    assert.throws(() => resolvePath(notesDir, '../secret'), exitedWith(USAGE));
    assert.deepEqual(await fs.readdir(root), []);
  });

  it('creates the notes directory lazily and writes the content', async () => {
    await createNote(notesDir, 'grocery', 'milk\n');
    const file = path.join(notesDir, 'grocery.txt');
    assert.equal(await fs.readFile(file, 'utf8'), 'milk\n');
  });

  it('fails with code 1 when the note already exists', async () => {
    await createNote(notesDir, 'grocery', 'milk');
    await assert.rejects(createNote(notesDir, 'grocery', 'bread'), exitedWith(FAILURE));
    assert.equal(await fs.readFile(path.join(notesDir, 'grocery.txt'), 'utf8'), 'milk');
  });

  it('reads back exactly the bytes that were written', async () => {
    const text = 'héllo\n\nwörld\n';
    await createNote(notesDir, 'unicode', text);
    const data = await readNote(notesDir, 'unicode');
    assert.equal(Buffer.compare(data, Buffer.from(text, 'utf8')), 0);
  });

  it('fails with code 1 when showing a missing note', async () => {
    await assert.rejects(readNote(notesDir, 'ghost'), exitedWith(FAILURE));
  });

  it('overwrites a note exactly, and fails with code 1 when it is missing', async () => {
    await assert.rejects(overwriteNote(notesDir, 'ghost', 'x'), exitedWith(FAILURE));

    await createNote(notesDir, 'note', 'a much longer original body\n');
    await overwriteNote(notesDir, 'note', 'short\n');
    assert.equal(await fs.readFile(path.join(notesDir, 'note.txt'), 'utf8'), 'short\n');
  });

  it('deletes a note, and fails with code 1 when it is missing', async () => {
    await assert.rejects(deleteNote(notesDir, 'ghost'), exitedWith(FAILURE));

    await createNote(notesDir, 'gone', 'bye');
    await deleteNote(notesDir, 'gone');
    await assert.rejects(fs.access(path.join(notesDir, 'gone.txt')));
  });

  it('lists notes sorted, ignoring non-.txt files and directories', async () => {
    await createNote(notesDir, 'beta', 'b');
    await createNote(notesDir, 'alpha', 'a');
    await createNote(notesDir, 'gamma', 'g');
    await fs.writeFile(path.join(notesDir, 'README.md'), '# not a note');
    await fs.mkdir(path.join(notesDir, 'subdir'));

    assert.deepEqual(await listNotes(notesDir), ['alpha', 'beta', 'gamma']);
  });

  it('returns an empty list for a missing directory', async () => {
    assert.deepEqual(await listNotes(path.join(root, 'does-not-exist')), []);
  });
});
