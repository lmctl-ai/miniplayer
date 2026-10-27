#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const STRICT_TAG_REGEX = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

export function validateReleaseTag(tag) {
  if (typeof tag !== 'string' || !STRICT_TAG_REGEX.test(tag.trim())) {
    throw new Error(`Invalid release tag format: "${tag}". Must match ^v[0-9]+\\.[0-9]+\\.[0-9]+$`);
  }
  return tag.trim();
}

export function computeNextPatchTag(pkgVersion, existingTags = []) {
  const m = pkgVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) {
    throw new Error(`Invalid package.json version: "${pkgVersion}"`);
  }
  const major = m[1];
  const minor = m[2];
  const targetPatch = parseInt(m[3] || '0', 10);

  const re = new RegExp(`^v${major}\\.${minor}\\.(\\d+)$`);
  const patches = [];
  for (const t of existingTags) {
    const tm = typeof t === 'string' ? t.match(re) : null;
    if (tm) {
      patches.push(parseInt(tm[1], 10));
    }
  }

  if (patches.length === 0) {
    return `v${major}.${minor}.${targetPatch}`;
  }
  return `v${major}.${minor}.${Math.max(...patches) + 1}`;
}

export function listGitTags(cwd = rootDir) {
  try {
    const out = execFileSync('git', ['tag', '-l'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

export function readPackageJsonVersion(cwd = rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function determineReleaseTag(options = {}) {
  const rawInput = options.inputTag !== undefined
    ? options.inputTag
    : (process.env.RELEASE_TAG || process.env.MANUAL_TAG || '');
  const inputTag = typeof rawInput === 'string' ? rawInput.trim() : '';

  if (inputTag.length > 0) {
    return validateReleaseTag(inputTag);
  }

  const pkgVersion = options.pkgVersion || readPackageJsonVersion(options.cwd || rootDir);
  const existingTags = options.existingTags || listGitTags(options.cwd || rootDir);
  return computeNextPatchTag(pkgVersion, existingTags);
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const tag = determineReleaseTag();
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`, 'utf8');
    }
    console.log(`tag=${tag}`);
    console.log(`Release tag: ${tag}`);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
