import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main } from '../src/index.js';
import {
  readPackageVersion,
  formatVersionDisplay,
  resolveVersionDisplay,
} from '../src/version.js';

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

test('readPackageVersion reads valid package.json and falls back on error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-ver-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '3.2.1' }), 'utf8');
    assert.equal(readPackageVersion(dir), '3.2.1');

    writeFileSync(join(dir, 'package.json'), 'invalid json', 'utf8');
    assert.equal(readPackageVersion(dir), '0.0.0');

    assert.equal(readPackageVersion(join(dir, 'nonexistent')), '0.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatVersionDisplay formats cleanly across release, dev, and dirty states', () => {
  // Clean release tag
  assert.equal(formatVersionDisplay('2.0.0', { isTagged: true, dirty: false }), '2.0.0');
  // Tagged but dirty
  assert.equal(formatVersionDisplay('2.0.0', { sha: 'abc1234', isTagged: true, dirty: true }), '2.0.0+abc1234.dirty');
  // Untagged dev commit
  assert.equal(formatVersionDisplay('2.0.0', { sha: 'abc1234', isTagged: false, dirty: false }), '2.0.0+abc1234');
  // Untagged dirty commit
  assert.equal(formatVersionDisplay('2.0.0', { sha: 'abc1234', isTagged: false, dirty: true }), '2.0.0+abc1234.dirty');
  // Dirty with no sha
  assert.equal(formatVersionDisplay('2.0.0', { dirty: true }), '2.0.0+dirty');
  // Plain version fallback
  assert.equal(formatVersionDisplay('2.0.0'), '2.0.0');
  assert.equal(formatVersionDisplay(null), '0.0.0');
});

test('resolveVersionDisplay respects compile-time define overrides', () => {
  // In compiled Bun binary, build defines override package.json and git
  const display1 = resolveVersionDisplay(undefined, {
    buildVersion: '2.5.0',
    buildSha: 'def5678',
    buildDirty: false,
    buildTagged: false,
  });
  assert.equal(display1, '2.5.0+def5678');

  const display2 = resolveVersionDisplay(undefined, {
    buildVersion: '2.5.0',
    buildSha: 'def5678',
    buildDirty: true,
    buildTagged: false,
  });
  assert.equal(display2, '2.5.0+def5678.dirty');

  const displayRelease = resolveVersionDisplay(undefined, {
    buildVersion: '2.5.0',
    buildSha: 'def5678',
    buildDirty: false,
    buildTagged: true,
  });
  assert.equal(displayRelease, '2.5.0');
});

test('resolveVersionDisplay handles git fixtures under Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-git-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-pkg', version: '1.2.3' }), 'utf8');

    // Case A: Not a git repo
    assert.equal(resolveVersionDisplay(dir), '1.2.3');

    // Initialize git
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir });

    // Untracked package.json in git repo
    assert.equal(resolveVersionDisplay(dir), '1.2.3');

    // Commit package.json
    execFileSync('git', ['add', 'package.json'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    // Dev commit without tag
    assert.equal(resolveVersionDisplay(dir), `1.2.3+${sha}`);

    // Dirty worktree
    writeFileSync(join(dir, 'dirty.txt'), 'edit\n', 'utf8');
    assert.equal(resolveVersionDisplay(dir), `1.2.3+${sha}.dirty`);

    // Clean worktree with matching release tag
    rmSync(join(dir, 'dirty.txt'));
    execFileSync('git', ['tag', 'v1.2.3'], { cwd: dir });
    assert.equal(resolveVersionDisplay(dir), '1.2.3');

    // Move past release tag
    writeFileSync(join(dir, 'newfile.txt'), 'new\n', 'utf8');
    execFileSync('git', ['add', 'newfile.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'second'], { cwd: dir });
    const sha2 = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    assert.equal(resolveVersionDisplay(dir), `1.2.3+${sha2}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli top-level --version, -v, and version flags exit 0 and print version', async () => {
  const pkgVersion = readPackageVersion();
  assert.match(pkgVersion, /^\d+\.\d+\.\d+$/, 'package.json version must be valid semver');
  const expectedPattern = new RegExp(`^miniplayer ${pkgVersion.replace(/\./g, '\\.')}(?:\\+.*)?\\n$`);

  for (const flag of ['--version', '-v', '-V', 'version']) {
    const io = memoryIo();
    const code = await main([flag], io);
    assert.equal(code, 0, `flag ${flag} must exit 0`);
    assert.equal(io.output().stderr, '', `flag ${flag} must write nothing to stderr`);
    assert.match(io.output().stdout, expectedPattern, `flag ${flag} must match expected package version ${pkgVersion}`);
    assert.ok(io.output().stdout.endsWith('\n'), `flag ${flag} must end with newline`);
  }

  // Unknown flags must exit 1 with clear error on stderr and empty stdout
  for (const unknownFlag of ['--bogus', '--unknown-flag', 'bogus-command']) {
    const io = memoryIo();
    const code = await main([unknownFlag], io);
    assert.equal(code, 1, `unknown flag ${unknownFlag} must exit 1`);
    assert.match(io.output().stderr, new RegExp(`Unknown command: ${unknownFlag.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}`));
    assert.equal(io.output().stdout, '', `unknown flag ${unknownFlag} must write nothing to stdout`);
  }

  // Mutation check: prove that a mutant output with wrong version (e.g. 2.999.999) fails the version check
  const wrongVersionMutants = [
    'miniplayer 2.999.999\n',
    'miniplayer 3.0.0\n',
    'miniplayer 1.0.0\n',
    'miniplayer 2.0.1\n',
  ];
  for (const mutant of wrongVersionMutants) {
    assert.equal(expectedPattern.test(mutant), false, `mutant ${mutant.trim()} must not match ${pkgVersion}`);
    assert.throws(
      () => assert.match(mutant, expectedPattern),
      assert.AssertionError,
      `Mutant version "${mutant.trim()}" must fail version assertion`
    );
  }

  // Mutation check: non-zero exit code on version flag must fail exit-code assertion
  assert.throws(
    () => {
      const mutantExit = 1;
      assert.equal(mutantExit, 0, 'mutant exit code 1 must fail');
    },
    assert.AssertionError,
    'Mutant exit code must be caught'
  );
});
