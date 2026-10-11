import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { MiniplayerError } from './errors.js';

export const DEFAULT_CATALOG_URL = 'https://lmctl.com/dataset/model_list.json';
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const HEAD_TIMEOUT_MS = 1000;
const GET_TIMEOUT_MS = 10000;
const SELECTOR_FIELDS = ['gateway_id', 'vendor_model_id', 'source_model_id', 'canonical_slug'];

let memoizedCatalog = null;

export function _resetCatalogMemoForTests() {
  memoizedCatalog = null;
}

function ensureDirMode(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {}
}

function writeCacheFileAtomic(targetPath, content, mode = 0o600) {
  const dir = dirname(targetPath);
  ensureDirMode(dir, 0o700);
  const tmp = join(dir, `${basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, content, { mode });
    try {
      chmodSync(tmp, mode);
    } catch {}
    renameSync(tmp, targetPath);
    try {
      chmodSync(targetPath, mode);
    } catch {}
  } catch (err) {
    try {
      if (existsSync(tmp)) {
        unlinkSync(tmp);
      }
    } catch {}
    throw err;
  }
}

function readCachedCatalog(cacheDir) {
  const modelListPath = join(cacheDir, 'model_list.json');
  const metaPath = join(cacheDir, 'meta.json');
  let document = null;
  let rawText = null;

  try {
    rawText = readFileSync(modelListPath, 'utf8');
    const parsed = JSON.parse(rawText);
    if (parsed?.schema_version === 1 && Array.isArray(parsed.records)) {
      document = parsed;
    }
  } catch {
    document = null;
  }

  let meta = { etag: null, last_checked: null };
  try {
    const metaText = readFileSync(metaPath, 'utf8');
    const metaParsed = JSON.parse(metaText);
    if (metaParsed && typeof metaParsed === 'object') {
      meta = {
        etag: typeof metaParsed.etag === 'string' ? metaParsed.etag : null,
        last_checked: metaParsed.last_checked ?? null,
      };
    }
  } catch {
    // Keep default meta
  }

  return { document, meta, rawText };
}

function isCacheFresh(cachedDocument, meta, now, ttlMs) {
  if (!cachedDocument) return false;
  if (!meta || !meta.last_checked) return false;
  const lastCheckedMs = typeof meta.last_checked === 'number'
    ? meta.last_checked
    : Date.parse(meta.last_checked);
  if (!Number.isFinite(lastCheckedMs)) return false;
  if (now < lastCheckedMs) return false;
  return (now - lastCheckedMs) < ttlMs;
}

async function loadOnlineCatalog({ url, cacheDir, fetchImpl, now, ttlMs }) {
  const modelListPath = join(cacheDir, 'model_list.json');
  const metaPath = join(cacheDir, 'meta.json');

  const cached = readCachedCatalog(cacheDir);

  if (isCacheFresh(cached.document, cached.meta, now, ttlMs)) {
    return cached.document.records;
  }

  let headOk = false;
  let headEtag = null;
  try {
    const headRes = await fetchImpl(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    if (headRes && headRes.ok) {
      headOk = true;
      headEtag = headRes.headers?.get ? headRes.headers.get('etag') : (headRes.headers?.etag ?? null);
    }
  } catch {
    headOk = false;
  }

  if (headOk && cached.document && headEtag && cached.meta.etag && headEtag === cached.meta.etag) {
    try {
      ensureDirMode(cacheDir, 0o700);
      const updatedMeta = {
        etag: headEtag,
        last_checked: new Date(now).toISOString(),
      };
      writeCacheFileAtomic(metaPath, JSON.stringify(updatedMeta));
    } catch {
      // Best-effort cache meta update
    }
    return cached.document.records;
  }

  if (!headOk && cached.document) {
    return cached.document.records;
  }

  if (!headOk && !cached.document) {
    throw new MiniplayerError(
      `Unable to load model catalog from ${url} (network failure) and no valid cache found in ${cacheDir}. ` +
      `Set MINIPLAYER_CATALOG to a local model catalog to work offline.`
    );
  }

  let getOk = false;
  let newRecords = null;
  let newRawText = null;
  let newEtag = headEtag;

  try {
    const getRes = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
    if (getRes && getRes.ok) {
      const text = await getRes.text();
      const parsed = JSON.parse(text);
      if (parsed?.schema_version === 1 && Array.isArray(parsed.records)) {
        getOk = true;
        newRecords = parsed.records;
        newRawText = text;
        const resEtag = getRes.headers?.get ? getRes.headers.get('etag') : (getRes.headers?.etag ?? null);
        if (resEtag) {
          newEtag = resEtag;
        }
      }
    }
  } catch {
    getOk = false;
  }

  if (getOk) {
    try {
      ensureDirMode(cacheDir, 0o700);
      writeCacheFileAtomic(modelListPath, newRawText);
      const meta = {
        etag: newEtag,
        last_checked: new Date(now).toISOString(),
      };
      writeCacheFileAtomic(metaPath, JSON.stringify(meta));
    } catch {
      // Best effort cache write
    }
    return newRecords;
  }

  if (cached.document) {
    return cached.document.records;
  }

  throw new MiniplayerError(
    `Unable to load model catalog from ${url} and no valid cache found in ${cacheDir}. ` +
    `Set MINIPLAYER_CATALOG to a local model catalog to work offline.`
  );
}

async function loadCatalogInternal(options = {}) {
  const env = options.env ?? process.env;
  // MINIPLAYER_LMPRICE_CATALOG is the legacy name, kept working for existing setups.
  const filePath = options.filePath || env.MINIPLAYER_CATALOG || env.MINIPLAYER_LMPRICE_CATALOG;

  if (filePath) {
    let contents;
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch (error) {
      const hint = error?.code === 'ENOENT'
        ? ' Set MINIPLAYER_CATALOG to a schema_version 1 model catalog (see "Model catalog" in the README).'
        : '';
      throw new MiniplayerError(`Unable to read model catalog ${filePath}: ${error.message}.${hint}`);
    }

    let document;
    try {
      document = JSON.parse(contents);
    } catch (error) {
      throw new MiniplayerError(`Invalid JSON in model catalog ${filePath}: ${error.message}`);
    }

    if (document?.schema_version !== 1 || !Array.isArray(document.records)) {
      throw new MiniplayerError(`Unsupported model catalog schema in ${filePath}`);
    }

    return document.records;
  }

  const url = options.url || DEFAULT_CATALOG_URL;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now ?? Date.now();

  let ttlMs = DEFAULT_TTL_MS;
  if (options.ttlMs !== undefined) {
    ttlMs = options.ttlMs;
  } else if (env.MINIPLAYER_PRICE_TTL !== undefined && env.MINIPLAYER_PRICE_TTL !== '') {
    const sec = Number(env.MINIPLAYER_PRICE_TTL);
    if (Number.isFinite(sec) && sec >= 0) {
      ttlMs = sec * 1000;
    }
  }

  const cacheDir = options.cacheDir || join(
    env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'miniplayer',
    'catalog'
  );

  return loadOnlineCatalog({
    url,
    cacheDir,
    fetchImpl,
    now,
    ttlMs,
  });
}

export function loadCatalog(options) {
  if (typeof options === 'string') {
    return loadCatalogInternal({ filePath: options });
  }

  const isNoArg = options === undefined || (typeof options === 'object' && options !== null && Object.keys(options).length === 0);
  if (isNoArg) {
    if (!memoizedCatalog) {
      // A failed load must not be remembered: a long-running `miniplayer acp` should recover
      // once the network or cache is back instead of failing until restart.
      memoizedCatalog = loadCatalogInternal({}).catch((error) => {
        memoizedCatalog = null;
        throw error;
      });
    }
    return memoizedCatalog;
  }

  return loadCatalogInternal(options ?? {});
}

export function findSelectorMatches(records, selector) {
  return records.filter((record) => SELECTOR_FIELDS.some((field) => record[field] === selector));
}

export function listChatModels(records, filters = {}) {
  const maxInputPrice = filters.maxInputPrice;
  return records.filter((record) => {
    if (record.mode !== 'chat') return false;
    if (filters.source && record.source !== filters.source) return false;
    if (filters.provider && record.provider !== filters.provider) return false;
    if (maxInputPrice !== undefined) {
      const price = record.pricing?.input_per_1m_tokens;
      if (typeof price !== 'number' || price > maxInputPrice) return false;
    }
    return true;
  });
}

export function modelListId(record) {
  return record.gateway_id ?? record.vendor_model_id ?? record.source_model_id ?? record.canonical_slug;
}
