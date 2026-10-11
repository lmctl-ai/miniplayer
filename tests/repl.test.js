import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { main } from '../src/index.js';
import { formatToolTrace, WRAP_UP_PROMPT } from '../src/cli.js';

function scriptedIo(lines = [], { isTTY = false } = {}) {
  let stdout = '';
  let stderr = '';
  const text = lines.map(l => `${l}\n`).join('');
  const stream = Readable.from([text]);
  stream.isTTY = isTTY;
  return {
    stdin: stream,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    output: () => ({ stdout, stderr }),
  };
}

test('formatToolTrace renders single-line stderr trace without ANSI escapes', () => {
  const line1 = formatToolTrace({
    type: 'tool_call',
    toolName: 'lmgit',
    input: { args: ['status', '--short'] },
  });
  assert.equal(line1, '[tool] lmgit status --short\n');

  const line2 = formatToolTrace({
    type: 'tool_call',
    toolName: 'lmgh',
    input: { args: [] },
  });
  assert.equal(line2, '[tool] lmgh\n');
});

test('REPL chat loop processes user messages, /help, and /exit with wrap-up', async () => {
  const io = scriptedIo(['hello world', '/help', '/exit'], { isTTY: true });
  const exitCode = await main(['chat', '-m', 'mock/Echo'], io);

  assert.equal(exitCode, 0);
  const { stdout } = io.output();
  assert.ok(stdout.includes('hello world'));
  assert.ok(stdout.includes('/exit'));
  assert.ok(stdout.includes('/compact'));
  assert.ok(stdout.includes('/help'));
  assert.ok(stdout.includes('nothing to update'));
});

test('REPL --no-wrapup disables wrap-up on exit', async () => {
  const io = scriptedIo(['test message', '/exit'], { isTTY: true });
  const exitCode = await main(['chat', '-m', 'mock/Echo', '--no-wrapup'], io);

  assert.equal(exitCode, 0);
  assert.ok(!io.output().stdout.includes('nothing to update'));
});

test('REPL config wrapUp: false disables wrap-up on exit', async () => {
  const io = scriptedIo(['test message', '/exit'], { isTTY: true });
  const exitCode = await main(['chat', '-m', 'mock/Echo'], io, {
    loadConfig: async () => ({ wrapUp: false }),
  });

  assert.equal(exitCode, 0);
  assert.ok(!io.output().stdout.includes('nothing to update'));
});

test('REPL wrap-up failure prints 1 line to stderr and never blocks exit', async () => {
  const io = scriptedIo(['test message', '/exit'], { isTTY: true });
  const exitCode = await main(['chat', '-m', 'ollama/test'], io, {
    loadCatalog: async () => [{ record_id: 'direct:ollama/test', source: 'litellm', provider: 'ollama', vendor_model_id: 'test' }],
    loadConfig: async () => ({}),
    generate: async ({ prompt }) => {
      if (prompt === WRAP_UP_PROMPT) {
        throw new Error('simulated network timeout in wrapup');
      }
      return `reply:${prompt}`;
    },
  });

  assert.equal(exitCode, 0);
  const { stderr } = io.output();
  assert.ok(stderr.includes('wrap-up error: simulated network timeout in wrapup'));
});

test('run command does not wrap up by default but wraps up when --wrapup flag is passed', async () => {
  // Default: no wrap-up
  const io1 = scriptedIo([]);
  await main(['run', '-m', 'mock/Echo', 'run prompt'], io1);
  assert.equal(io1.output().stdout.includes('nothing to update'), false);

  // With --wrapup
  const io2 = scriptedIo([]);
  await main(['run', '-m', 'mock/Echo', '--wrapup', 'run prompt'], io2);
  assert.ok(io2.output().stdout.includes('nothing to update'));
});

test('non-TTY stdin with no args behaves as run reading stdin', async () => {
  const io = scriptedIo(['piped stdin input'], { isTTY: false });
  const exitCode = await main([], io, {
    generate: async ({ prompt }) => `processed:${prompt}`,
    loadCatalog: async () => [],
    loadConfig: async () => ({}),
  });

  assert.equal(exitCode, 0);
  assert.ok(io.output().stdout.includes('processed:piped stdin input'));
});
