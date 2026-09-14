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
