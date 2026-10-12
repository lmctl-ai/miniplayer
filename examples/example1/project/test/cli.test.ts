import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const cliPath = path.resolve(process.cwd(), 'src/cli.ts');
const tsxCli = path.resolve(
  process.cwd(),
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs'
);

function runCli(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {}
) {
  return spawnSync(process.execPath, [tsxCli, cliPath, ...args], {
    input: options.input,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-cli-cli-'));
}

test('cli create/list/show/overwrite/delete', () => {
  const dir = tempDir();
  const env = { NOTES_DIR: dir };

  try {
    let result = runCli(['create', 'alpha', 'hello'], { env });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');

    result = runCli(['list'], { env });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'alpha\n');

    result = runCli(['show', 'alpha'], { env });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'hello');

    result = runCli(['overwrite', 'alpha', 'world'], { env });
    assert.equal(result.status, 0);

    result = runCli(['show', 'alpha'], { env });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'world');

    result = runCli(['delete', 'alpha'], { env });
    assert.equal(result.status, 0);

    result = runCli(['list'], { env });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli reads text from stdin when omitted', () => {
  const dir = tempDir();

  try {
    let result = runCli(['create', 'stdin-note'], {
      env: { NOTES_DIR: dir },
      input: 'from stdin\n',
    });
    assert.equal(result.status, 0);

    result = runCli(['show', 'stdin-note'], {
      env: { NOTES_DIR: dir },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'from stdin\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli rejects invalid name', () => {
  const dir = tempDir();

  try {
    const result = runCli(['create', 'bad/name', 'x'], {
      env: { NOTES_DIR: dir },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid note name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli rejects unknown command', () => {
  const dir = tempDir();

  try {
    const result = runCli(['bogus'], { env: { NOTES_DIR: dir } });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown command/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli reports missing note', () => {
  const dir = tempDir();

  try {
    const result = runCli(['show', 'missing'], {
      env: { NOTES_DIR: dir },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Note not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cli usage errors exit 2', () => {
  const dir = tempDir();

  try {
    let result = runCli([], { env: { NOTES_DIR: dir } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing command/);

    result = runCli(['create'], { env: { NOTES_DIR: dir } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing name/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
