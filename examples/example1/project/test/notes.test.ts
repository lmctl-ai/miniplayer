import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createNote,
  deleteNote,
  listNotes,
  overwriteNote,
  showNote,
  validateName,
} from '../src/notes';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cli-notes-'));
}

test('validateName accepts valid names', () => {
  for (const name of ['a', 'A', '0', 'foo-bar', 'foo_bar', 'abc123']) {
    assert.doesNotThrow(() => validateName(name));
  }
});

test('validateName rejects invalid names', () => {
  for (const name of ['', '..', 'a/b', 'a\\b', 'a b', 'a.b', 'é', 'a$']) {
    assert.throws(() => validateName(name), /Invalid note name/);
  }
});

test('notes CRUD against a temp directory', () => {
  const dir = tempDir();
  try {
    createNote(dir, 'alpha', 'one');
    assert.equal(showNote(dir, 'alpha'), 'one');
    assert.deepEqual(listNotes(dir), ['alpha']);

    overwriteNote(dir, 'alpha', 'two');
    assert.equal(showNote(dir, 'alpha'), 'two');

    deleteNote(dir, 'alpha');
    assert.deepEqual(listNotes(dir), []);
    assert.throws(() => showNote(dir, 'alpha'), /Note not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listNotes ignores non-txt files and sorts names', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'c.md'), 'c');
    fs.mkdirSync(path.join(dir, 'd.txt'));

    assert.deepEqual(listNotes(dir), ['a', 'b']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listNotes returns empty for missing directory', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(listNotes(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createNote errors when note already exists', () => {
  const dir = tempDir();
  try {
    createNote(dir, 'alpha', 'one');
    assert.throws(() => createNote(dir, 'alpha', 'two'), /Note already exists/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overwriteNote errors when note is missing', () => {
  const dir = tempDir();
  try {
    assert.throws(() => overwriteNote(dir, 'missing', 'x'), /Note not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteNote errors when note is missing', () => {
  const dir = tempDir();
  try {
    assert.throws(() => deleteNote(dir, 'missing'), /Note not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
