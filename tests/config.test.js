import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadConfig } from '../src/config.js';

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

test('poolOrdered must be boolean when configured', async () => {
  await assert.rejects(
    loadConfig(fixture('config-ordered-invalid.json')),
    /field "poolOrdered" must be a boolean/,
  );
});
