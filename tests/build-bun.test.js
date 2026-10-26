import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALL_TARGETS, buildTargets, findBun, resolveBuildMetadata } from '../scripts/build-bun.mjs';

test('ALL_TARGETS defines all 5 cross-compilation targets with correct names', () => {
  const ids = ALL_TARGETS.map(t => t.id);
  assert.deepEqual(ids, ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'windows-x64']);

  const expectedFiles = {
    'linux-x64': 'miniplayer-linux-x64',
    'linux-arm64': 'miniplayer-linux-arm64',
    'darwin-arm64': 'miniplayer-darwin-arm64',
    'darwin-x64': 'miniplayer-darwin-x64',
    'windows-x64': 'miniplayer-windows-x64.exe',
  };

  for (const t of ALL_TARGETS) {
    assert.equal(t.outfile, expectedFiles[t.id]);
  }
});

test('findBun locates a valid bun executable', () => {
  const bun = findBun();
  assert.ok(bun && existsSync(bun), `bun executable must exist: ${bun}`);
  const version = execFileSync(bun, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^\d+\.\d+\.\d+/, 'bun must return version string');
});

test('resolveBuildMetadata derives version and git information', () => {
  const meta = resolveBuildMetadata();
  assert.match(meta.version, /^\d+\.\d+\.\d+/, 'version must match semver');
  assert.equal(typeof meta.isDirty, 'boolean');
  assert.equal(typeof meta.isTagged, 'boolean');
  assert.equal(typeof meta.gitSha, 'string');
});

test('buildTargets builds linux-x64 standalone binary and creates SHA256SUMS', { timeout: 30000 }, async () => {
  const outdir = mkdtempSync(join(tmpdir(), 'miniplayer-build-test-'));
  try {
    const linuxTarget = ALL_TARGETS.filter(t => t.id === 'linux-x64');
    const built = await buildTargets({
      outdir,
      targets: linuxTarget,
      metadata: {
        version: '9.9.9',
        gitSha: 'testsha',
        isDirty: false,
        isTagged: true,
      },
    });

    assert.equal(built.length, 1);
    const binPath = join(outdir, 'miniplayer-linux-x64');
    assert.ok(existsSync(binPath), 'binary must exist');

    const shaPath = join(outdir, 'SHA256SUMS');
    assert.ok(existsSync(shaPath), 'SHA256SUMS must exist');
    const shaContent = readFileSync(shaPath, 'utf8');
    assert.match(shaContent, /^[0-9a-f]{64}\s+miniplayer-linux-x64$/m);

    // Verify binary execution in isolated environment without Node
    const verRes = execFileSync(binPath, ['--version'], {
      env: { PATH: '/usr/bin:/bin', HOME: outdir },
      encoding: 'utf8',
    }).trim();
    assert.equal(verRes, 'miniplayer 9.9.9');

    const helpRes = execFileSync(binPath, ['--help'], {
      env: { PATH: '/usr/bin:/bin', HOME: outdir },
      encoding: 'utf8',
    });
    assert.match(helpRes, /^Usage:/);

    // Offline run CLI smoke
    const runRes = execFileSync(binPath, ['run', '-m', 'mock/Echo', 'smoke test'], {
      env: { PATH: '/usr/bin:/bin', HOME: outdir },
      encoding: 'utf8',
    }).trim();
    assert.equal(runRes, 'smoke test');
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
});
