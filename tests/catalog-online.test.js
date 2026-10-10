import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { _resetCatalogMemoForTests, loadCatalog } from '../src/catalog.js';

const sampleRecords = [
  {
    source: 'openrouter',
    source_model_id: 'test/model-1',
    record_id: 'openrouter:test/model-1',
    gateway_id: 'test/model-1',
    mode: 'chat',
    pricing: { input_per_1m_tokens: 1.0, output_per_1m_tokens: 2.0 },
  },
];

const sampleCatalog = {
  schema_version: 1,
  generated_at: '2026-10-10T00:00:00.000Z',
  records: sampleRecords,
};

const sampleCatalogJson = JSON.stringify(sampleCatalog);

function createTempDir(prefix = 'miniplayer-catalog-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createMockFetch(handlers = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ url, options, method });
    if (handlers[method]) {
      return handlers[method](url, options);
    }
    if (handlers.default) {
      return handlers.default(url, options);
    }
    throw new Error(`Unhandled ${method} request to ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function mockHeaders(headersObj = {}) {
  return {
    get: (key) => headersObj[key.toLowerCase()] ?? null,
    ...headersObj,
  };
}

test('1. first run downloads and caches model catalog', async () => {
  const tempDir = createTempDir();
  try {
    const fetchImpl = createMockFetch({
      HEAD: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v1"' }),
      }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v1"' }),
        text: async () => sampleCatalogJson,
      }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      now: 1700000000000,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].method, 'HEAD');
    assert.equal(fetchImpl.calls[1].method, 'GET');

    const cachedList = JSON.parse(readFileSync(join(tempDir, 'model_list.json'), 'utf8'));
    assert.equal(cachedList.schema_version, 1);
    assert.equal(cachedList.records.length, 1);

    const cachedMeta = JSON.parse(readFileSync(join(tempDir, 'meta.json'), 'utf8'));
    assert.equal(cachedMeta.etag, '"v1"');
    assert.equal(typeof cachedMeta.last_checked, 'string');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('2. second run inside TTL makes zero fetch calls', async () => {
  const tempDir = createTempDir();
  try {
    const t0 = 1700000000000;
    const fetchImpl1 = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }), text: async () => sampleCatalogJson }),
    });

    await loadCatalog({ cacheDir: tempDir, fetchImpl: fetchImpl1, now: t0 });

    const fetchImpl2 = createMockFetch({
      default: async () => {
        throw new Error('Network should not be called inside TTL');
      },
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl: fetchImpl2,
      now: t0 + 60 * 1000, // 1 minute later (within 6h default TTL)
    });

    assert.equal(records.length, 1);
    assert.equal(fetchImpl2.calls.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('3. stale TTL + HEAD same ETag -> no GET and last_checked updated', async () => {
  const tempDir = createTempDir();
  try {
    const t0 = 1700000000000;
    const tStale = t0 + 7 * 60 * 60 * 1000; // 7 hours later

    // Seed cache
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(t0).toISOString() }),
      { mode: 0o600 },
    );

    const fetchImpl = createMockFetch({
      HEAD: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v1"' }),
      }),
      GET: async () => {
        throw new Error('GET should not be called when ETag matches');
      },
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      now: tStale,
    });

    assert.equal(records.length, 1);
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].method, 'HEAD');

    const meta = JSON.parse(readFileSync(join(tempDir, 'meta.json'), 'utf8'));
    assert.equal(meta.etag, '"v1"');
    assert.equal(meta.last_checked, new Date(tStale).toISOString());
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('4. changed ETag -> GET and cache replaced', async () => {
  const tempDir = createTempDir();
  try {
    const t0 = 1700000000000;
    const tStale = t0 + 7 * 60 * 60 * 1000;

    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(t0).toISOString() }),
      { mode: 0o600 },
    );

    const updatedCatalog = {
      schema_version: 1,
      generated_at: '2026-10-10T07:00:00.000Z',
      records: [
        {
          source: 'openrouter',
          source_model_id: 'test/model-2',
          record_id: 'openrouter:test/model-2',
          gateway_id: 'test/model-2',
          mode: 'chat',
        },
      ],
    };

    const fetchImpl = createMockFetch({
      HEAD: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v2"' }),
      }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v2"' }),
        text: async () => JSON.stringify(updatedCatalog),
      }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      now: tStale,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-2');
    assert.equal(fetchImpl.calls.length, 2);

    const meta = JSON.parse(readFileSync(join(tempDir, 'meta.json'), 'utf8'));
    assert.equal(meta.etag, '"v2"');
    assert.equal(meta.last_checked, new Date(tStale).toISOString());

    const onDisk = JSON.parse(readFileSync(join(tempDir, 'model_list.json'), 'utf8'));
    assert.equal(onDisk.records[0].record_id, 'openrouter:test/model-2');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('5. HEAD fails -> cache used silently', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(1700000000000).toISOString() }),
      { mode: 0o600 },
    );

    const fetchImpl = createMockFetch({
      HEAD: async () => {
        throw new TypeError('fetch failed: offline');
      },
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      ttlMs: 0, // Force refresh attempt
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('6. GET returns malformed JSON -> previous valid cache kept and used', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(1700000000000).toISOString() }),
      { mode: 0o600 },
    );

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v2"' }) }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v2"' }),
        text: async () => 'not json at all {',
      }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      ttlMs: 0,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');

    const onDisk = JSON.parse(readFileSync(join(tempDir, 'model_list.json'), 'utf8'));
    assert.equal(onDisk.records[0].record_id, 'openrouter:test/model-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('7. GET returns wrong schema_version -> previous valid cache kept and used', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v2"' }) }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v2"' }),
        text: async () => JSON.stringify({ schema_version: 99, records: [] }),
      }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      ttlMs: 0,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('8. GET returns records not an array -> previous valid cache kept and used', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v2"' }) }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v2"' }),
        text: async () => JSON.stringify({ schema_version: 1, records: 'not an array' }),
      }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      ttlMs: 0,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('9. no cache + offline -> clear error mentioning URL and the env var', async () => {
  const tempDir = createTempDir();
  try {
    const fetchImpl = createMockFetch({
      HEAD: async () => {
        throw new TypeError('getaddrinfo ENOTFOUND lmctl.com');
      },
    });

    const targetUrl = 'https://lmctl.com/dataset/model_list.json';
    await assert.rejects(
      () => loadCatalog({ cacheDir: tempDir, fetchImpl, url: targetUrl }),
      (error) => {
        assert.match(error.message, /Unable to load model catalog/);
        assert.ok(error.message.includes(targetUrl), `Error message should contain URL ${targetUrl}`);
        assert.ok(error.message.includes(tempDir), `Error message should contain cacheDir ${tempDir}`);
        assert.ok(error.message.includes('MINIPLAYER_LMPRICE_CATALOG'), 'Error message should mention MINIPLAYER_LMPRICE_CATALOG');
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('10. TTL=0 forces refresh', async () => {
  const tempDir = createTempDir();
  try {
    const t0 = 1700000000000;
    // Just checked 1 ms ago
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(t0).toISOString() }),
      { mode: 0o600 },
    );

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
    });

    await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      now: t0 + 1,
      ttlMs: 0,
    });

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(fetchImpl.calls[0].method, 'HEAD');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('11. MINIPLAYER_LMPRICE_CATALOG disables network (assert fetch never called)', async () => {
  const tempDir = createTempDir();
  try {
    const pinnedPath = join(tempDir, 'pinned_catalog.json');
    writeFileSync(pinnedPath, sampleCatalogJson, { mode: 0o600 });

    const fetchImpl = createMockFetch({
      default: async () => {
        throw new Error('fetch should NEVER be called when catalog is pinned');
      },
    });

    const records = await loadCatalog({
      env: { MINIPLAYER_LMPRICE_CATALOG: pinnedPath },
      fetchImpl,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
    assert.equal(fetchImpl.calls.length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('12. atomic write (no partial file when rename fails or when validation fails)', async () => {
  const tempDir = createTempDir();
  try {
    // A) Validation failure: no temporary or partial files created
    const fetchImplInvalid = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v1"' }),
        text: async () => JSON.stringify({ schema_version: 2 }), // invalid schema
      }),
    });

    await assert.rejects(() => loadCatalog({ cacheDir: tempDir, fetchImpl: fetchImplInvalid }));

    const filesAfterInvalid = existsSync(tempDir) ? readdirSync(tempDir) : [];
    assert.equal(filesAfterInvalid.filter((f) => f.includes('.tmp-')).length, 0);
    assert.equal(existsSync(join(tempDir, 'model_list.json')), false);

    // B) Successful write leaves zero temporary files behind
    const fetchImplValid = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({
        ok: true,
        headers: mockHeaders({ etag: '"v1"' }),
        text: async () => sampleCatalogJson,
      }),
    });

    await loadCatalog({ cacheDir: tempDir, fetchImpl: fetchImplValid });

    const filesAfterValid = readdirSync(tempDir);
    assert.ok(filesAfterValid.includes('model_list.json'));
    assert.ok(filesAfterValid.includes('meta.json'));
    assert.equal(filesAfterValid.filter((f) => f.includes('.tmp-')).length, 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('13. timeouts are passed via AbortSignal', async () => {
  const tempDir = createTempDir();
  try {
    const originalTimeout = AbortSignal.timeout;
    const timeoutCalls = [];

    AbortSignal.timeout = (ms) => {
      timeoutCalls.push(ms);
      return originalTimeout.call(AbortSignal, ms);
    };

    try {
      const fetchImpl = createMockFetch({
        HEAD: async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal);
          return { ok: true, headers: mockHeaders({ etag: '"v1"' }) };
        },
        GET: async (url, options) => {
          assert.ok(options.signal instanceof AbortSignal);
          return {
            ok: true,
            headers: mockHeaders({ etag: '"v1"' }),
            text: async () => sampleCatalogJson,
          };
        },
      });

      await loadCatalog({ cacheDir: tempDir, fetchImpl });

      assert.deepEqual(timeoutCalls, [1000, 10000]);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('14. cache dir mode 0o700, files mode 0o600', async () => {
  const baseDir = createTempDir();
  const cacheDir = join(baseDir, 'nested', 'cache', 'dir');
  try {
    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }), text: async () => sampleCatalogJson }),
    });

    await loadCatalog({ cacheDir, fetchImpl });

    const dirStat = statSync(cacheDir);
    assert.equal((dirStat.mode & 0o777).toString(8), '700');

    const modelListStat = statSync(join(cacheDir, 'model_list.json'));
    assert.equal((modelListStat.mode & 0o777).toString(8), '600');

    const metaStat = statSync(join(cacheDir, 'meta.json'));
    assert.equal((metaStat.mode & 0o777).toString(8), '600');
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('15. XDG_CACHE_HOME is respected when cacheDir is not specified', async () => {
  const tempDir = createTempDir();
  try {
    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }), text: async () => sampleCatalogJson }),
    });

    const records = await loadCatalog({
      env: { XDG_CACHE_HOME: tempDir },
      fetchImpl,
    });

    assert.equal(records.length, 1);
    const expectedDir = join(tempDir, 'miniplayer', 'lmprice');
    assert.ok(existsSync(join(expectedDir, 'model_list.json')));
    assert.ok(existsSync(join(expectedDir, 'meta.json')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('16. concurrent calls do not corrupt the cache', async () => {
  const tempDir = createTempDir();
  try {
    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }), text: async () => sampleCatalogJson }),
    });

    const results = await Promise.all([
      loadCatalog({ cacheDir: tempDir, fetchImpl }),
      loadCatalog({ cacheDir: tempDir, fetchImpl }),
      loadCatalog({ cacheDir: tempDir, fetchImpl }),
      loadCatalog({ cacheDir: tempDir, fetchImpl }),
      loadCatalog({ cacheDir: tempDir, fetchImpl }),
    ]);

    for (const res of results) {
      assert.equal(res.length, 1);
      assert.equal(res[0].record_id, 'openrouter:test/model-1');
    }

    const cachedList = JSON.parse(readFileSync(join(tempDir, 'model_list.json'), 'utf8'));
    assert.equal(cachedList.records.length, 1);

    const cachedMeta = JSON.parse(readFileSync(join(tempDir, 'meta.json'), 'utf8'));
    assert.equal(cachedMeta.etag, '"v1"');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('17. GET returns non-ok HTTP status (e.g. 500) -> previous valid cache used', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v2"' }) }),
      GET: async () => ({ ok: false, status: 500 }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      ttlMs: 0,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('18. corrupt cache on disk is replaced by valid network download', async () => {
  const tempDir = createTempDir();
  try {
    writeFileSync(join(tempDir, 'model_list.json'), '{corrupt garbage JSON...', { mode: 0o600 });

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
      GET: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }), text: async () => sampleCatalogJson }),
    });

    const records = await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
    });

    assert.equal(records.length, 1);
    assert.equal(records[0].record_id, 'openrouter:test/model-1');

    const onDisk = JSON.parse(readFileSync(join(tempDir, 'model_list.json'), 'utf8'));
    assert.equal(onDisk.records.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('19. MINIPLAYER_PRICE_TTL env override (including 0 forces refresh)', async () => {
  const tempDir = createTempDir();
  try {
    const t0 = 1700000000000;
    writeFileSync(join(tempDir, 'model_list.json'), sampleCatalogJson, { mode: 0o600 });
    writeFileSync(
      join(tempDir, 'meta.json'),
      JSON.stringify({ etag: '"v1"', last_checked: new Date(t0).toISOString() }),
      { mode: 0o600 },
    );

    const fetchImpl = createMockFetch({
      HEAD: async () => ({ ok: true, headers: mockHeaders({ etag: '"v1"' }) }),
    });

    await loadCatalog({
      cacheDir: tempDir,
      fetchImpl,
      now: t0 + 1000,
      env: { MINIPLAYER_PRICE_TTL: '0' },
    });

    assert.equal(fetchImpl.calls.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('20. memoization: default no-arg loadCatalog memoized per process, test seam allows reset', async () => {
  const tempDir = createTempDir();
  try {
    const pinnedPath = join(tempDir, 'model_list.json');
    writeFileSync(pinnedPath, sampleCatalogJson, { mode: 0o600 });

    const originalEnv = process.env.MINIPLAYER_LMPRICE_CATALOG;
    process.env.MINIPLAYER_LMPRICE_CATALOG = pinnedPath;

    try {
      _resetCatalogMemoForTests();
      const p1 = loadCatalog();
      const p2 = loadCatalog();
      assert.strictEqual(p1, p2, 'Expected identical memoized Promise reference');

      const r1 = await p1;
      const r2 = await p2;
      assert.strictEqual(r1, r2);

      _resetCatalogMemoForTests();
      const p3 = loadCatalog();
      assert.notStrictEqual(p1, p3, 'Expected new Promise after memo reset');
    } finally {
      _resetCatalogMemoForTests();
      if (originalEnv === undefined) {
        delete process.env.MINIPLAYER_LMPRICE_CATALOG;
      } else {
        process.env.MINIPLAYER_LMPRICE_CATALOG = originalEnv;
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a failed default load is not memoized, so a later call can recover', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadCatalog, _resetCatalogMemoForTests } = await import('../src/catalog.js');
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-memo-'));
  const saved = { fetch: globalThis.fetch, xdg: process.env.XDG_CACHE_HOME, pin: process.env.MINIPLAYER_LMPRICE_CATALOG };
  try {
    delete process.env.MINIPLAYER_LMPRICE_CATALOG;
    process.env.XDG_CACHE_HOME = dir;
    _resetCatalogMemoForTests();
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(() => loadCatalog(), /Unable to load model catalog/);
    const body = JSON.stringify({ schema_version: 1, records: [{ record_id: 'x' }] });
    globalThis.fetch = async (_url, init) => ({
      ok: true,
      headers: new Headers({ etag: '"e1"' }),
      text: async () => (init?.method === 'HEAD' ? '' : body),
    });
    const records = await loadCatalog();
    assert.equal(records.length, 1);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.pin !== undefined) process.env.MINIPLAYER_LMPRICE_CATALOG = saved.pin;
    _resetCatalogMemoForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
