import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DEFAULT_REQUEST_TIMEOUT_MS, loadConfig, resolveRequestTimeoutMs } from '../src/config.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test('missing MINIPLAYER_CONFIG path is an error', async () => {
  await assert.rejects(
    loadConfig(undefined, { MINIPLAYER_CONFIG: fixture('missing-config.json') }),
    /Unable to read config.*ENOENT/,
  );
});

test('malformed config JSON is an error', async () => {
  await assert.rejects(loadConfig(fixture('config-malformed.json')), /Invalid JSON in config/);
});

test('non-object config is an error', async () => {
  await assert.rejects(loadConfig(fixture('config-array.json')), /must contain a JSON object/);
});

test('an explicit empty config preserves built-in defaults', async () => {
  assert.deepEqual(await loadConfig(fixture('config-empty.json')), {});
});

test('poolOrdered must be boolean when configured', async () => {
  await assert.rejects(
    loadConfig(fixture('config-ordered-invalid.json')),
    /field "poolOrdered" must be a boolean/,
  );
});

test('request timeout uses environment precedence and defaults to 60 seconds', () => {
  assert.equal(resolveRequestTimeoutMs({}, {}), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs({ requestTimeoutMs: 45_000 }, {}), 45_000);
  assert.equal(resolveRequestTimeoutMs(
    { requestTimeoutMs: 45_000 },
    { MINIPLAYER_REQUEST_TIMEOUT_MS: '1234' },
  ), 1234);
});

test('invalid request timeout values are clean errors', async () => {
  assert.throws(
    () => resolveRequestTimeoutMs({}, { MINIPLAYER_REQUEST_TIMEOUT_MS: 'forever' }),
    /MINIPLAYER_REQUEST_TIMEOUT_MS must be a positive integer/,
  );
  await assert.rejects(
    loadConfig(fixture('config-timeout-invalid.json')),
    /requestTimeoutMs.*positive integer/,
  );
});

test('tools validation enforces strings or tool objects', async () => {
  const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'miniplayer-cfg-test-'));
  try {
    const validPath = join(dir, 'valid.json');
    await writeFile(validPath, JSON.stringify({
      tools: ['lmgit', { name: 'gh', command: 'lmgh', brief: 'GitHub CLI' }],
      wrapUp: false,
      compact: { thresholdRatio: 0.8, thresholdTokens: 50000 },
    }));
    const loaded = await loadConfig(validPath);
    assert.equal(loaded.tools.length, 2);
    assert.equal(loaded.wrapUp, false);
    assert.equal(loaded.compact.thresholdRatio, 0.8);

    const invalidToolsPath = join(dir, 'invalid-tools.json');
    await writeFile(invalidToolsPath, JSON.stringify({ tools: 'not-array' }));
    await assert.rejects(loadConfig(invalidToolsPath), /field "tools" must be an array/);

    const invalidItemPath = join(dir, 'invalid-item.json');
    await writeFile(invalidItemPath, JSON.stringify({ tools: [{ name: 'x' }] }));
    await assert.rejects(loadConfig(invalidItemPath), /requires a non-empty "command" string/);

    const invalidWrapUpPath = join(dir, 'invalid-wrapup.json');
    await writeFile(invalidWrapUpPath, JSON.stringify({ wrapUp: 'yes' }));
    await assert.rejects(loadConfig(invalidWrapUpPath), /field "wrapUp" must be a boolean/);

    const invalidCompactPath = join(dir, 'invalid-compact.json');
    await writeFile(invalidCompactPath, JSON.stringify({ compact: { thresholdRatio: 1.5 } }));
    await assert.rejects(loadConfig(invalidCompactPath), /compact\.thresholdRatio must be a number between 0 and 1/);

    const duplicateToolsPath = join(dir, 'duplicate-tools.json');
    await writeFile(duplicateToolsPath, JSON.stringify({ tools: ['/opt/a/lmgit', '/opt/b/lmgit'] }));
    await assert.rejects(loadConfig(duplicateToolsPath), /duplicate tool name "lmgit"/);

    const reservedToolPath = join(dir, 'reserved-tool.json');
    await writeFile(reservedToolPath, JSON.stringify({ tools: [{ name: '__proto__', command: 'git' }] }));
    await assert.rejects(loadConfig(reservedToolPath), /reserved property name/);

    const longToolPath = join(dir, 'long-tool.json');
    await writeFile(longToolPath, JSON.stringify({ tools: [{ name: 'a'.repeat(65), command: 'git' }] }));
    await assert.rejects(loadConfig(longToolPath), /exceeds 64 characters/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


