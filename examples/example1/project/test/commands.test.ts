import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand } from '../src/commands';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cli-commands-'));
}

function memoryStdout() {
  let output = '';

  return {
    write(chunk: string) {
      output += chunk;
      return true;
    },
    get output() {
      return output;
    },
  };
}

test('runCommand create writes a note', async () => {
  const dir = tempDir();
  try {
    const stdout = memoryStdout();
    await runCommand(
      { command: 'create', name: 'alpha', text: 'hello' },
      { notesDir: dir, stdout }
    );

    assert.equal(fs.readFileSync(path.join(dir, 'alpha.txt'), 'utf8'), 'hello');
    assert.equal(stdout.output, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand create errors when note exists', async () => {
  const dir = tempDir();
  try {
    await runCommand(
      { command: 'create', name: 'alpha', text: 'one' },
      { notesDir: dir, stdout: memoryStdout() }
    );

    await assert.rejects(
      runCommand(
        { command: 'create', name: 'alpha', text: 'two' },
        { notesDir: dir, stdout: memoryStdout() }
      ),
      /Note already exists/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand overwrite errors when note is missing', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      runCommand(
        { command: 'overwrite', name: 'missing', text: 'x' },
        { notesDir: dir, stdout: memoryStdout() }
      ),
      /Note not found/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand delete errors when note is missing', async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      runCommand(
        { command: 'delete', name: 'missing' },
        { notesDir: dir, stdout: memoryStdout() }
      ),
      /Note not found/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand uses stdin text when text argument is absent', async () => {
  const dir = tempDir();
  try {
    await runCommand(
      { command: 'create', name: 'stdin-note' },
      {
        notesDir: dir,
        stdout: memoryStdout(),
        readStdin: async () => 'from stdin',
      }
    );

    assert.equal(
      fs.readFileSync(path.join(dir, 'stdin-note.txt'), 'utf8'),
      'from stdin'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand list prints sorted names one per line', async () => {
  const dir = tempDir();
  try {
    await runCommand(
      { command: 'create', name: 'b', text: 'b' },
      { notesDir: dir, stdout: memoryStdout() }
    );
    await runCommand(
      { command: 'create', name: 'a', text: 'a' },
      { notesDir: dir, stdout: memoryStdout() }
    );

    const stdout = memoryStdout();
    await runCommand({ command: 'list' }, { notesDir: dir, stdout });

    assert.equal(stdout.output, 'a\nb\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand list on missing directory prints nothing', async () => {
  const dir = tempDir();
  try {
    const stdout = memoryStdout();
    await runCommand(
      { command: 'list' },
      { notesDir: path.join(dir, 'missing'), stdout }
    );

    assert.equal(stdout.output, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runCommand show prints note content', async () => {
  const dir = tempDir();
  try {
    await runCommand(
      { command: 'create', name: 'alpha', text: 'hello' },
      { notesDir: dir, stdout: memoryStdout() }
    );

    const stdout = memoryStdout();
    await runCommand(
      { command: 'show', name: 'alpha' },
      { notesDir: dir, stdout }
    );

    assert.equal(stdout.output, 'hello');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
