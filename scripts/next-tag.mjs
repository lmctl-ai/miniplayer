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

export function verifyReleaseTagTarget(options = {}) {
  const rawTag = options.tag !== undefined
    ? options.tag
    : (process.env.RELEASE_TAG || '');
  const rawTargetSha = options.targetSha !== undefined
    ? options.targetSha
    : (process.env.TARGET_SHA || '');
  const cwd = options.cwd || rootDir;
  const remote = options.remote || 'origin';
  const gitCmd = options.gitCmd || process.env.GIT_BIN || 'git';

  const tag = validateReleaseTag(rawTag);

  if (typeof rawTargetSha !== 'string' || !/^[0-9a-f]{40}$/i.test(rawTargetSha.trim())) {
    throw new Error(`Invalid target commit SHA: "${rawTargetSha}". Must be a 40-character hex string`);
  }
  const targetSha = rawTargetSha.trim().toLowerCase();

  // 1. Local tag verification:
  // Exit code 0: tag exists locally and stdout contains peeled commit SHA
  // Exit code 1: tag positively does not exist locally
  // Any other exit code (e.g. 128, corruption, missing git): lookup error/fault
  let localCommitSha = null;
  try {
    const stdout = execFileSync(
      gitCmd,
      ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    localCommitSha = stdout.trim().toLowerCase();
  } catch (err) {
    if (err.status === 1) {
      localCommitSha = null;
    } else {
      const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
      throw new Error(`Local tag lookup failed with exit code ${err.status ?? 'unknown'}: ${msg}`);
    }
  }

  // 2. Remote tag verification:
  // Checks remote origin when configured (or when requireRemote=true)
  // Exit code 0 + empty stdout: tag positively does not exist on remote
  // Exit code 0 + non-empty: tag exists on remote (peeled commit or direct ref)
  // Non-zero exit code: lookup error/fault
  let remoteCommitSha = null;
  let remoteChecked = false;
  let hasRemote = false;

  try {
    const remotesOut = execFileSync(gitCmd, ['remote'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remotes = remotesOut.trim().split(/\s+/).filter(Boolean);
    hasRemote = remotes.includes(remote);
  } catch (err) {
    const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
    throw new Error(`Git remote check failed with exit code ${err.status ?? 'unknown'}: ${msg}`);
  }

  if (options.requireRemote && !hasRemote) {
    throw new Error(`Remote "${remote}" is required but not configured`);
  }

  if (hasRemote) {
    remoteChecked = true;
    try {
      const stdout = execFileSync(
        gitCmd,
        ['ls-remote', '--tags', remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length > 0) {
        let peeled = null;
        let direct = null;
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const sha = parts[0].toLowerCase();
            const ref = parts[1];
            if (ref === `refs/tags/${tag}^{}`) {
              peeled = sha;
            } else if (ref === `refs/tags/${tag}`) {
              direct = sha;
            }
          }
        }
        remoteCommitSha = peeled || direct;
      }
    } catch (err) {
      const msg = err.stderr ? err.stderr.trim() : (err.message || String(err));
      throw new Error(`Remote tag lookup on "${remote}" failed with exit code ${err.status ?? 'unknown'}: ${msg}`);
    }
  }

  // 3. Commit mismatch guards:
  if (localCommitSha && localCommitSha !== targetSha) {
    throw new Error(
      `Refusing to publish: tag ${tag} already exists locally and points to ${localCommitSha}, not target ${targetSha}`
    );
  }

  if (remoteCommitSha && remoteCommitSha !== targetSha) {
    throw new Error(
      `Refusing to publish: tag ${tag} already exists on remote "${remote}" and points to ${remoteCommitSha}, not target ${targetSha}`
    );
  }

  const exists = Boolean(localCommitSha || remoteCommitSha);
  return {
    tag,
    targetSha,
    exists,
    localCommitSha,
    remoteCommitSha,
    remoteChecked,
  };
}

// CLI execution
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.argv.includes('--verify-target') || process.argv.includes('--verify') || process.argv[2] === 'verify') {
    try {
      const res = verifyReleaseTagTarget();
      if (res.exists) {
        console.log(`Tag ${res.tag} verified matching target commit ${res.targetSha}`);
      } else {
        console.log(`Tag ${res.tag} positively absent; target commit ${res.targetSha}`);
      }
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
  } else {
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
}
