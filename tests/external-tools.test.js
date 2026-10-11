import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createExternalTools,
  executeExternalTool,
  parseToolConfigItem,
  sanitizeToolName,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
} from '../src/external-tools.js';

const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

test('sanitizeToolName normalizes tool names to [a-zA-Z0-9_-]', () => {
  assert.equal(sanitizeToolName('lmgit'), 'lmgit');
  assert.equal(sanitizeToolName('my-tool_1'), 'my-tool_1');
  assert.equal(sanitizeToolName('@lmctl-ai/lmgit.js'), '_lmctl-ai_lmgit_js');
  assert.equal(sanitizeToolName('tool.with.dots!'), 'tool_with_dots_');
  assert.equal(sanitizeToolName(''), 'tool');
  assert.equal(sanitizeToolName('   '), 'tool');
});

test('parseToolConfigItem handles strings and objects', () => {
  assert.deepEqual(parseToolConfigItem('lmgit'), {
    command: 'lmgit',
    name: 'lmgit',
    brief: undefined,
  });

  assert.deepEqual(parseToolConfigItem('/usr/bin/faketool.js'), {
    command: '/usr/bin/faketool.js',
    name: 'faketool',
    brief: undefined,
  });

  assert.deepEqual(parseToolConfigItem({
    name: 'custom_git',
    command: 'lmgit',
    brief: 'Git operations',
  }), {
    name: 'custom_git',
    command: 'lmgit',
    brief: 'Git operations',
  });

  assert.throws(() => parseToolConfigItem(null), /Invalid tool config item/);
  assert.throws(() => parseToolConfigItem(123), /Invalid tool config item/);
});

test('createExternalTools returns empty object when no tools configured', () => {
  assert.deepEqual(createExternalTools(), Object.create(null));
  assert.deepEqual(createExternalTools({ toolsConfig: [] }), Object.create(null));
  assert.deepEqual(createExternalTools({ toolsConfig: null }), Object.create(null));
});

test('external tool executes successfully and captures argv exactness without shell expansion', async () => {
  const tools = createExternalTools({
    toolsConfig: [{ name: 'faketool', command: faketool }],
  });
  assert.ok(tools.faketool);

  // Normal execution
  const res1 = await tools.faketool.execute({ args: ['echo', 'hello', 'world'] });
  assert.equal(res1.exit_code, 0);
  assert.equal(res1.stdout, 'hello world\n');
  assert.equal(res1.stderr, '');
  assert.equal(res1.truncated, false);

  // Shell metacharacters must not be expanded or executed
  const res2 = await tools.faketool.execute({ args: ['echo', 'a; rm -rf /; echo b'] });
  assert.equal(res2.exit_code, 0);
  assert.equal(res2.stdout, 'a; rm -rf /; echo b\n');
  assert.equal(res2.stderr, '');
  assert.equal(res2.truncated, false);
});

test('external tool passes stdin to child process', async () => {
  const tools = createExternalTools({
    toolsConfig: [faketool],
  });
  const res = await tools.faketool.execute({
    args: ['echo'],
    stdin: 'custom input data',
  });
  assert.equal(res.exit_code, 0);
  assert.equal(res.stdout, 'stdin:custom input data\n');
  assert.equal(res.stderr, '');
  assert.equal(res.truncated, false);
});

test('external tool captures non-zero exit code and stderr', async () => {
  const tools = createExternalTools({
    toolsConfig: [faketool],
  });
  const res = await tools.faketool.execute({ args: ['fail', 'something went wrong'] });
  assert.equal(res.exit_code, 1);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, 'error: something went wrong\n');
  assert.equal(res.truncated, false);
});

test('external tool bounds stdout to 256 KiB and sets truncated flag', async () => {
  const tools = createExternalTools({
    toolsConfig: [faketool],
  });
  const res = await tools.faketool.execute({ args: ['big', 'stdout', '300000'] });
  assert.equal(res.exit_code, 0);
  assert.equal(Buffer.byteLength(res.stdout, 'utf8'), MAX_STDOUT_BYTES);
  assert.equal(res.truncated, true);
});

test('external tool bounds stderr to 64 KiB and sets truncated flag', async () => {
  const tools = createExternalTools({
    toolsConfig: [faketool],
  });
  const res = await tools.faketool.execute({ args: ['big', 'stderr', '100000'] });
  assert.equal(res.exit_code, 0);
  assert.equal(Buffer.byteLength(res.stderr, 'utf8'), MAX_STDERR_BYTES);
  assert.equal(res.truncated, true);
});

test('external tool spawn failure (ENOENT) returns tool error result rather than crashing', async () => {
  const tools = createExternalTools({
    toolsConfig: ['nonexistent-binary-that-should-never-exist-xyz'],
  });
  const res = await tools['nonexistent-binary-that-should-never-exist-xyz'].execute({ args: ['test'] });
  assert.equal(res.exit_code, null);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('ENOENT') || res.stderr.includes('spawn'));
  assert.equal(res.truncated, false);
});

test('external tool emits telemetry tool_call and tool_result events', async () => {
  const events = [];
  const tools = createExternalTools({
    toolsConfig: [{ name: 'faketool', command: faketool }],
    onToolEvent: ev => events.push(ev),
  });

  await tools.faketool.execute({ args: ['echo', 'hi'] }, { toolCallId: 'call-123' });
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'tool_call');
  assert.equal(events[0].toolName, 'faketool');
  assert.equal(events[0].toolCallId, 'call-123');
  assert.deepEqual(events[0].input, { args: ['echo', 'hi'] });

  assert.equal(events[1].type, 'tool_result');
  assert.equal(events[1].toolName, 'faketool');
  assert.equal(events[1].toolCallId, 'call-123');
  assert.equal(events[1].status, 'completed');
  assert.equal(events[1].result.exit_code, 0);
});

test('external tool abort cancels in-flight execution and throws AbortError', async () => {
  const controller = new AbortController();
  const tools = createExternalTools({
    toolsConfig: [faketool],
    signal: controller.signal,
  });

  const promise = tools.faketool.execute({ args: ['sleep', '10000'] });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(promise, { name: 'AbortError' });
});

test('pre-aborted signal throws immediately without spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  const tools = createExternalTools({
    toolsConfig: [faketool],
    signal: controller.signal,
  });

  await assert.rejects(tools.faketool.execute({ args: ['echo', 'hi'] }), { name: 'AbortError' });
});

test('external tool handles tool early exit with large stdin without EPIPE crash', async () => {
  const tools = createExternalTools({
    toolsConfig: [faketool],
  });
  const largeStdin = 'a'.repeat(2 * 1024 * 1024); // 2 MiB
  const res = await tools.faketool.execute({
    args: ['fail', 'immediate failure'],
    stdin: largeStdin,
  });
  assert.equal(res.exit_code, 1);
  assert.equal(res.stdout, '');
  assert.ok(res.stderr.includes('immediate failure'));
});

