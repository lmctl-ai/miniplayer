import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { MiniplayerError } from './errors.js';

const DEFAULT_CATALOG_URL = new URL('../../lmprice/dist/model_list.json', import.meta.url);
const SELECTOR_FIELDS = ['gateway_id', 'vendor_model_id', 'source_model_id', 'canonical_slug'];

export function defaultCatalogPath() {
  return fileURLToPath(DEFAULT_CATALOG_URL);
}

export async function loadCatalog(filePath = process.env.MINIPLAYER_LMPRICE_CATALOG || defaultCatalogPath()) {
  let contents;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new MiniplayerError(`Unable to read model catalog ${filePath}: ${error.message}`);
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
