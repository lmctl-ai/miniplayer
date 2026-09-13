import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { loadCatalog } from '../src/catalog.js';
import { main } from '../src/index.js';

const catalogPath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
const configPath = fileURLToPath(new URL('./fixtures/config-pool.json', import.meta.url));

function memoryIo(input = '') {
  let stdout = '';
  let stderr = '';
  return {
    stdin: Readable.from([input]),
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    output: () => ({ stdout, stderr }),
  };
}

test('zero arguments prints usage to stderr and exits 1', async () => {
  const io = memoryIo();
  assert.equal(await main([], io), 1);
  assert.equal(io.output().stdout, '');
  assert.match(io.output().stderr, /^Usage:/);
});

test('--help prints usage to stdout and exits 0', async () => {
  const io = memoryIo();
  assert.equal(await main(['--help'], io), 0);
  assert.equal(io.output().stderr, '');
  assert.match(io.output().stdout, /^Usage:/);
});

test('models uses the injected catalog loader', async () => {
  const io = memoryIo();
  const records = await loadCatalog(catalogPath);
  const exitCode = await main(['models', '--provider', 'vendor'], io, {
    loadCatalog: async () => records,
  });
  assert.equal(exitCode, 0);
  assert.equal(io.output().stderr, '');
  assert.match(io.output().stdout, /vendor\/fast\tvendor/);
});

test('invalid classification exits 2 through main with empty stdout', async () => {
  const io = memoryIo('team response');
  const records = await loadCatalog(catalogPath);
  const exitCode = await main(['classify'], io, {
    loadConfig: async () => ({ pool: ['vendor/fast'] }),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'key' },
    generate: async () => 'garbage',
  });
  assert.equal(exitCode, 2);
  assert.equal(io.output().stdout, '');
  assert.match(io.output().stderr, /invalid classification object/);
});

test('-- terminates run options so prompts may start with a dash', async () => {
  const io = memoryIo();
  const records = await loadCatalog(catalogPath);
  const exitCode = await main(['run', '-m', 'vendor/fast', '--', '--literal prompt'], io, {
    loadConfig: async () => ({}),
    loadCatalog: async () => records,
    env: { OPENROUTER_API_KEY: 'key' },
    generate: async ({ prompt }) => prompt,
  });
  assert.equal(exitCode, 0);
  assert.equal(io.output().stdout, '--literal prompt');
});

test('injected MINIPLAYER_CONFIG wins over the ambient process environment', async () => {
  const io = memoryIo();
  const records = await loadCatalog(catalogPath);
  const previous = process.env.MINIPLAYER_CONFIG;
  process.env.MINIPLAYER_CONFIG = '/definitely/not/the/injected/config.json';
  try {
    const exitCode = await main(['run', 'hello'], io, {
      loadCatalog: async () => records,
      env: { MINIPLAYER_CONFIG: configPath, OPENROUTER_API_KEY: 'key' },
      generate: async () => 'ok',
    });
    assert.equal(exitCode, 0);
    assert.equal(io.output().stdout, 'ok');
    assert.equal(io.output().stderr, '');
  } finally {
    if (previous === undefined) delete process.env.MINIPLAYER_CONFIG;
    else process.env.MINIPLAYER_CONFIG = previous;
  }
});

test('ambient MINIPLAYER_CONFIG does not leak when injected env omits it', async () => {
  const io = memoryIo();
  const records = await loadCatalog(catalogPath);
  const injectedEnv = { OPENROUTER_API_KEY: 'key' };
  const previous = process.env.MINIPLAYER_CONFIG;
  process.env.MINIPLAYER_CONFIG = '/ambient/path/that/must/not/leak.json';
  try {
    const exitCode = await main(['run', 'hello'], io, {
      loadConfig: async (filePath, env) => {
        assert.equal(filePath, undefined);
        assert.equal(env, injectedEnv);
        assert.equal(env.MINIPLAYER_CONFIG, undefined);
        return { pool: ['vendor/fast'] };
      },
      loadCatalog: async () => records,
      env: injectedEnv,
      generate: async () => 'ok',
    });
    assert.equal(exitCode, 0);
    assert.equal(io.output().stdout, 'ok');
    assert.equal(io.output().stderr, '');
  } finally {
    if (previous === undefined) delete process.env.MINIPLAYER_CONFIG;
    else process.env.MINIPLAYER_CONFIG = previous;
  }
});
