import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function defaultPackageRoot() {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function readPackageVersion(root = defaultPackageRoot()) {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // fall back
  }
  return '0.0.0';
}

function runGit(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

export function formatVersionDisplay(version, { sha, dirty, isTagged } = {}) {
  const base = version || '0.0.0';
  if (isTagged && !dirty) {
    return base;
  }
  if (sha) {
    return `${base}+${sha}${dirty ? '.dirty' : ''}`;
  }
  if (dirty) {
    return `${base}+dirty`;
  }
  return base;
}

export function resolveVersionDisplay(root = defaultPackageRoot(), overrides = {}) {
  // 1. Build-time defines for compiled binary (or explicit test overrides)
  const buildVersion = overrides.buildVersion ?? (typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : undefined);
  const buildSha = overrides.buildSha ?? (typeof __BUILD_GIT_SHA__ !== 'undefined' ? __BUILD_GIT_SHA__ : undefined);
  const buildDirty = overrides.buildDirty ?? (typeof __BUILD_GIT_DIRTY__ !== 'undefined' ? Boolean(__BUILD_GIT_DIRTY__) : undefined);
  const buildTagged = overrides.buildTagged ?? (typeof __BUILD_IS_TAGGED__ !== 'undefined' ? Boolean(__BUILD_IS_TAGGED__) : undefined);

  if (typeof buildVersion === 'string' && buildVersion.length > 0) {
    return formatVersionDisplay(buildVersion, {
      sha: buildSha,
      dirty: buildDirty,
      isTagged: buildTagged,
    });
  }

  // 2. Fall back to package.json under Node
  const version = readPackageVersion(root);

  // Probe git if package.json is tracked in a git worktree
  const gitRunner = overrides.runGit ?? runGit;
  if (gitRunner(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    return version;
  }
  if (gitRunner(root, ['ls-files', '--error-unmatch', '--', 'package.json']) === undefined) {
    return version;
  }
  const sha = gitRunner(root, ['rev-parse', '--short', 'HEAD']);
  if (!sha) {
    return version;
  }
  const exactTag = gitRunner(root, ['describe', '--tags', '--exact-match', 'HEAD']);
  const status = gitRunner(root, ['status', '--porcelain']);
  const dirty = status !== undefined && status.length > 0;
  const isTagged = exactTag === `v${version}`;

  return formatVersionDisplay(version, { sha, dirty, isTagged });
}
