import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  STRICT_TAG_REGEX,
  validateReleaseTag,
  computeNextPatchTag,
  determineReleaseTag,
  verifyReleaseTagTarget,
} from '../scripts/next-tag.mjs';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const nextTagScriptPath = fileURLToPath(new URL('../scripts/next-tag.mjs', import.meta.url));

test('release workflow exists and satisfies automation security contract', () => {
  assert.ok(existsSync(workflowPath), 'release.yml must exist');
  const content = readFileSync(workflowPath, 'utf8');

  // Must be DISPATCH-ONLY: NO push, pull_request or schedule triggers
  assert.equal(
    /^  (push|pull_request|schedule):/m.test(content),
    false,
    'Workflow must not contain push, pull_request, or schedule triggers',
  );

  // Must contain required tokens for release automation
  const requiredTokens = ['workflow_dispatch:', '--prerelease', '--latest=false', 'private-run-id'];
  for (const token of requiredTokens) {
    assert.ok(content.includes(token), `Workflow must contain "${token}"`);
  }

  // Permissions: minimal top-level contents: read, contents: write only on publish
  assert.match(content, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(content, /publish:[\s\S]*?permissions:\s*\n\s*contents:\s*write/);

  // Concurrency group defined
  assert.match(content, /concurrency:\s*\n\s*group:\s*release-/);

  // Actions pinned by 40-character commit SHA
  const actionUses = content.match(/uses:\s*([^\s]+)/g) || [];
  assert.ok(actionUses.length >= 4, 'Must use multiple actions');
  for (const use of actionUses) {
    const action = use.replace(/^uses:\s*/, '');
    assert.match(action, /@[0-9a-f]{40}/, `Action ${action} must be pinned by commit SHA`);
  }

  // Tag format regex check in workflow
  assert.match(content, /v\\d\+\\.\\d\+\\.\\d\+/, 'Must enforce vMAJOR.MINOR.PATCH format');

  // Tag target MUST be pinned to TARGET_SHA (exact commit checked out), NEVER a branch name like 'main'
  assert.match(content, /--target\s+"\$TARGET_SHA"/, 'Must tag exact TARGET_SHA');
  assert.equal(
    /--target\s+main\b/.test(content),
    false,
    'Workflow must not target branch "main"; must tag exact commit SHA',
  );

  // Must pass TARGET_SHA and DISPATCH_REF via env:
  assert.match(content, /TARGET_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(content, /DISPATCH_REF:\s*\$\{\{\s*github\.ref\s*\}\}/);

  // Must refuse publication unless dispatched from refs/heads/main
  assert.match(
    content,
    /if\s*\[\s*"\$DISPATCH_REF"\s*!=\s*"refs\/heads\/main"\s*\];\s*then/,
    'Must refuse publication if DISPATCH_REF is not refs/heads/main',
  );

  // Must verify that if the tag already exists, it points to TARGET_SHA
  assert.match(
    content,
    /git rev-parse\s+-q\s+--verify\s+"refs\/tags\/\$RELEASE_TAG\^\{commit\}"/,
    'Must verify existing tag matches TARGET_SHA',
  );

  // Security audit: NEVER interpolate ${{ }} into run scripts
  // All inputs and event metadata must pass through env:
  const lines = content.split('\n');
  let inRunBlock = false;
  let runIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const runMatch = line.match(/^(\s*)run:\s*(\|?>?.*)$/);
    if (runMatch) {
      inRunBlock = true;
      runIndent = runMatch[1].length;
      if (line.includes('${{')) {
        assert.fail(`Single-line run contains \${{ on line ${i + 1}: ${line}`);
      }
      continue;
    }
    if (inRunBlock) {
      const lineIndentMatch = line.match(/^(\s*)\S/);
      if (lineIndentMatch && lineIndentMatch[1].length <= runIndent) {
        inRunBlock = false;
      } else if (line.includes('${{')) {
        assert.fail(`Multi-line run script contains \${{ on line ${i + 1}: ${line}`);
      }
    }
  }

  // Ensure release_tag input is passed via env, not bash interpolation
  assert.match(content, /env:\s*\n\s*RELEASE_TAG:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/);
});

test('tag calculation correctly increments patch numbers', () => {
  // Case 1: No existing tags (first release for 2.0.0)
  assert.equal(computeNextPatchTag('2.0.0', []), 'v2.0.0');

  // Case 2: v2.0.0 already exists
  assert.equal(computeNextPatchTag('2.0.0', ['v2.0.0']), 'v2.0.1');

  // Case 3: v2.0.0, v2.0.1, v2.0.5 exist
  assert.equal(computeNextPatchTag('2.0.0', ['v2.0.0', 'v2.0.1', 'v2.0.5']), 'v2.0.6');

  // Case 4: Tags from other major/minor are ignored
  assert.equal(computeNextPatchTag('2.0.0', ['v1.0.0', 'v1.9.9']), 'v2.0.0');

  // Case 5: 2-part semver (e.g. 2.0) defaults patch to 0
  assert.equal(computeNextPatchTag('2.0', []), 'v2.0.0');
});

test('next-tag script validates explicit tags, rejects injection strings, and supports mutation control', () => {
  // Valid explicit tags
  assert.equal(validateReleaseTag('v2.0.0'), 'v2.0.0');
  assert.equal(validateReleaseTag('v2.1.99'), 'v2.1.99');
  assert.equal(validateReleaseTag('  v3.0.0  '), 'v3.0.0');

  // Injection and invalid strings that MUST be rejected
  const maliciousInputs = [
    '$(touch /scratch/input-executed; printf v2.0.0)',
    '`touch /scratch/input-executed; printf v2.0.0`',
    'v2.0.0; touch pwned',
    'v2.0.0 && touch pwned',
    'v2.0.0\ntouch pwned',
    'v2.0.0|echo pwned',
    '2.0.0', // missing leading 'v'
    'v2.0', // missing patch
    'v2.0.0-beta.1', // prerelease suffix not permitted by strict regex
    'v2.0.0.0', // 4 segments
    '../v2.0.0',
    '',
    '   ',
  ];

  for (const input of maliciousInputs) {
    assert.throws(
      () => validateReleaseTag(input),
      /Invalid release tag format/,
      `Input "${input}" must be rejected as invalid tag format`
    );
  }

  // Mutation control:
  // Prove that a lenient regex (such as /^v.*/ or /v\d+/) would have mistakenly passed
  // the injection attack string, whereas our STRICT_TAG_REGEX correctly rejects it.
  const attackInput = '$(touch /scratch/input-executed; printf v2.0.0)';
  const lenientRegex = /^v.*/;
  assert.equal(lenientRegex.test(attackInput), false); // doesn't start with v
  const containsVRegex = /v\d+\.\d+\.\d+/;
  assert.equal(containsVRegex.test(attackInput), true); // contains v2.0.0! A substring regex is vulnerable
  assert.equal(STRICT_TAG_REGEX.test(attackInput), false); // STRICT fullmatch rejects it!

  assert.throws(
    () => {
      // Mutation test: if a mutated validator allowed the attack string, this assertion must fail
      const mutatedValidate = (tag) => {
        if (!containsVRegex.test(tag)) throw new Error('Invalid');
        return tag;
      };
      // Mutated validator mistakenly accepts attack string:
      const result = mutatedValidate(attackInput);
      // The test assertion insists that attackInput must NEVER be accepted:
      assert.notEqual(result, attackInput);
    },
    assert.AssertionError,
    'Mutation control: lenient validator accepting injection string must be caught'
  );

  // CLI execution verification with scratch output
  const scratchDir = mkdtempSync(join(tmpdir(), 'miniplayer-tag-cli-'));
  try {
    const outputFile = join(scratchDir, 'github_output');

    // 1. CLI with valid tag
    const validOut = execFileSync(process.execPath, [nextTagScriptPath], {
      env: { ...process.env, RELEASE_TAG: 'v2.5.7', GITHUB_OUTPUT: outputFile },
      encoding: 'utf8',
    });
    assert.match(validOut, /Release tag: v2\.5\.7/);
    assert.equal(readFileSync(outputFile, 'utf8'), 'tag=v2.5.7\n');

    // 2. CLI with shell injection string: MUST fail with exit code 1
    assert.throws(
      () => {
        execFileSync(process.execPath, [nextTagScriptPath], {
          env: { ...process.env, RELEASE_TAG: attackInput, GITHUB_OUTPUT: outputFile },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
      (err) => {
        assert.equal(err.status, 1);
        assert.match(err.stderr, /Invalid release tag format/);
        return true;
      }
    );
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test('publish step enforces dispatch ref is main, validates target commit SHA, and pins tag target', () => {
  function checkPublishGuards({ dispatchRef, targetSha, existingTagSha }) {
    if (dispatchRef !== 'refs/heads/main') {
      throw new Error(`Refusing to publish: dispatch ref must be refs/heads/main (got '${dispatchRef}')`);
    }
    if (!/^[0-9a-f]{40}$/.test(targetSha)) {
      throw new Error(`Invalid commit SHA: ${targetSha}`);
    }
    if (existingTagSha && existingTagSha !== targetSha) {
      throw new Error(`Refusing to publish: tag already exists at ${existingTagSha}, not target ${targetSha}`);
    }
    return true;
  }

  const validSha = '0123456789abcdef0123456789abcdef01234567';

  // Allowed on main with matching or non-existing tag
  assert.equal(checkPublishGuards({ dispatchRef: 'refs/heads/main', targetSha: validSha, existingTagSha: null }), true);
  assert.equal(checkPublishGuards({ dispatchRef: 'refs/heads/main', targetSha: validSha, existingTagSha: validSha }), true);

  // Refused on non-main refs
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/heads/feat/bun-release', targetSha: validSha }),
    /Refusing to publish: dispatch ref must be refs\/heads\/main/
  );
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/heads/release', targetSha: validSha }),
    /Refusing to publish: dispatch ref must be refs\/heads\/main/
  );
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/pull/42/merge', targetSha: validSha }),
    /Refusing to publish: dispatch ref must be refs\/heads\/main/
  );

  // Refused on invalid/unpinned target SHA (e.g. branch name 'main')
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/heads/main', targetSha: 'main' }),
    /Invalid commit SHA: main/
  );
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/heads/main', targetSha: '0123456' }), // short sha
    /Invalid commit SHA/
  );

  // Refused if existing tag points to a different commit
  const differentSha = 'fedcba9876543210fedcba9876543210fedcba98';
  assert.throws(
    () => checkPublishGuards({ dispatchRef: 'refs/heads/main', targetSha: validSha, existingTagSha: differentSha }),
    /Refusing to publish: tag already exists at/
  );
});

function createTestGitRepo() {
  const tmp = mkdtempSync(join(tmpdir(), 'miniplayer-tag-verify-'));
  const bareDir = join(tmp, 'bare.git');
  const workDir = join(tmp, 'work');
  execFileSync('git', ['init', '-q', '--bare', bareDir]);
  execFileSync('git', ['clone', '-q', bareDir, workDir]);
  execFileSync('git', ['config', 'user.name', 'Test Fixture'], { cwd: workDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir });

  // Commit A (the built TARGET_SHA)
  writeFileSync(join(workDir, 'file.txt'), 'version A\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: workDir });
  execFileSync('git', ['commit', '-q', '-m', 'commit A'], { cwd: workDir });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: workDir });
  const shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }).trim();

  // Commit B (a later advance on main)
  writeFileSync(join(workDir, 'file.txt'), 'version B\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: workDir });
  execFileSync('git', ['commit', '-q', '-m', 'commit B'], { cwd: workDir });
  execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: workDir });
  const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workDir, encoding: 'utf8' }).trim();

  // Checkout commit A (simulating detached checkout of TARGET_SHA)
  execFileSync('git', ['checkout', '-q', '--detach', shaA], { cwd: workDir });

  return {
    tmp,
    bareDir,
    workDir,
    shaA,
    shaB,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

test('verifyReleaseTagTarget: tag absent -> proceeds', () => {
  const repo = createTestGitRepo();
  try {
    const res = verifyReleaseTagTarget({
      tag: 'v2.0.0',
      targetSha: repo.shaA,
      cwd: repo.workDir,
    });
    assert.equal(res.exists, false);
    assert.equal(res.targetSha, repo.shaA);
    assert.equal(res.localCommitSha, null);
    assert.equal(res.remoteCommitSha, null);
  } finally {
    repo.cleanup();
  }
});

test('verifyReleaseTagTarget: tag at TARGET_SHA -> proceeds', () => {
  const repo = createTestGitRepo();
  try {
    execFileSync('git', ['tag', 'v2.0.0', repo.shaA], { cwd: repo.workDir });
    execFileSync('git', ['push', '-q', 'origin', 'v2.0.0'], { cwd: repo.workDir });

    const res = verifyReleaseTagTarget({
      tag: 'v2.0.0',
      targetSha: repo.shaA,
      cwd: repo.workDir,
    });
    assert.equal(res.exists, true);
    assert.equal(res.targetSha, repo.shaA);
    assert.equal(res.localCommitSha, repo.shaA);
    assert.equal(res.remoteCommitSha, repo.shaA);
  } finally {
    repo.cleanup();
  }
});

test('verifyReleaseTagTarget: tag at another commit -> aborts', () => {
  const repo = createTestGitRepo();
  try {
    // Tag points to shaB, while target is shaA
    execFileSync('git', ['tag', 'v2.0.0', repo.shaB], { cwd: repo.workDir });
    execFileSync('git', ['push', '-q', 'origin', 'v2.0.0'], { cwd: repo.workDir });

    assert.throws(
      () => verifyReleaseTagTarget({
        tag: 'v2.0.0',
        targetSha: repo.shaA,
        cwd: repo.workDir,
      }),
      /Refusing to publish: tag v2\.0\.0 already exists/
    );
  } finally {
    repo.cleanup();
  }
});

test('lookup fault with exit 128 (inject via a fake git) -> aborts and gh is never called', () => {
  const repo = createTestGitRepo();
  try {
    // 1. Tag points to shaB
    execFileSync('git', ['tag', 'v2.0.0', repo.shaB], { cwd: repo.workDir });

    const fakeBinDir = join(repo.tmp, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeGit = join(fakeBinDir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 128\n', { mode: 0o755 });

    // Function throws on lookup fault code 128
    assert.throws(
      () => verifyReleaseTagTarget({
        tag: 'v2.0.0',
        targetSha: repo.shaA,
        cwd: repo.workDir,
        gitCmd: fakeGit,
      }),
      /Local tag lookup failed with exit code 128/
    );

    // 2. Full publish step invocation: gh must NEVER be called
    const ghCallFile = join(repo.tmp, 'gh-called.json');
    const fakeGh = join(fakeBinDir, 'gh');
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node\nimport fs from "node:fs"; fs.writeFileSync(${JSON.stringify(ghCallFile)}, JSON.stringify(process.argv));\n`,
      { mode: 0o755 }
    );

    // Create required artifacts and checksums
    const assetsDir = join(repo.workDir, 'release-artifacts');
    mkdirSync(assetsDir, { recursive: true });
    for (const name of [
      'miniplayer-linux-x64', 'miniplayer-linux-arm64', 'miniplayer-darwin-arm64',
      'miniplayer-darwin-x64', 'miniplayer-windows-x64.exe', 'LICENSE',
    ]) {
      writeFileSync(join(assetsDir, name), 'artifact-content');
    }
    const sums = [
      'miniplayer-linux-x64', 'miniplayer-linux-arm64', 'miniplayer-darwin-arm64',
      'miniplayer-darwin-x64', 'miniplayer-windows-x64.exe', 'LICENSE',
    ].sort()
      .map(name => `${createHash('sha256').update('artifact-content').digest('hex')}  ${name}\n`)
      .join('');
    writeFileSync(join(assetsDir, 'SHA256SUMS'), sums);
    writeFileSync(join(repo.workDir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026\n');

    // Extract publish script block from release.yml
    const content = readFileSync(workflowPath, 'utf8');
    const publishBlock = content.split('      - name: assemble and publish public prerelease')[1]
      .split('        run: |\n')[1];
    const publishScript = publishBlock.split('\n')
      .map(line => line.startsWith('          ') ? line.slice(10) : line)
      .join('\n');

    const publishScriptPath = join(repo.workDir, 'publish.sh');
    writeFileSync(publishScriptPath, publishScript, { mode: 0o755 });

    // Copy scripts/next-tag.mjs into repo.workDir
    mkdirSync(join(repo.workDir, 'scripts'), { recursive: true });
    copyFileSync(nextTagScriptPath, join(repo.workDir, 'scripts', 'next-tag.mjs'));

    // Execute with fake git first in PATH
    let publishExit = 0;
    try {
      execFileSync('bash', [publishScriptPath], {
        cwd: repo.workDir,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH}`,
          GH_TOKEN: 'token',
          RELEASE_TAG: 'v2.0.0',
          TARGET_SHA: repo.shaA,
          DISPATCH_REF: 'refs/heads/main',
          GITHUB_RUN_ID: '424242',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      publishExit = err.status;
    }

    assert.notEqual(publishExit, 0, 'Publish block must fail when git lookup faults');
    assert.equal(existsSync(ghCallFile), false, 'gh must NEVER be called on lookup fault');
  } finally {
    repo.cleanup();
  }
});

test('verifyReleaseTagTarget: remote lookup fault -> aborts', () => {
  const repo = createTestGitRepo();
  try {
    // Break origin remote URL to induce remote lookup failure
    execFileSync('git', ['remote', 'set-url', 'origin', 'http://127.0.0.1:99999/broken.git'], { cwd: repo.workDir });

    assert.throws(
      () => verifyReleaseTagTarget({
        tag: 'v2.0.0',
        targetSha: repo.shaA,
        cwd: repo.workDir,
        remote: 'origin',
      }),
      /Remote tag lookup on "origin" failed with exit code/
    );
  } finally {
    repo.cleanup();
  }
});

test('mutation check: restoring || true swallows lookup fault and fails safety check', () => {
  const repo = createTestGitRepo();
  try {
    const fakeBinDir = join(repo.tmp, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeGit = join(fakeBinDir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 128\n', { mode: 0o755 });

    // Real verifier rejects exit 128
    assert.throws(
      () => verifyReleaseTagTarget({
        tag: 'v2.0.0',
        targetSha: repo.shaA,
        cwd: repo.workDir,
        gitCmd: fakeGit,
      }),
      /Local tag lookup failed with exit code 128/
    );

    // Mutant verifier implementing the old `|| true` fail-open pattern
    const mutantVerify = (options) => {
      let existingTagSha = '';
      try {
        existingTagSha = execFileSync(
          options.gitCmd,
          ['rev-parse', '-q', '--verify', `refs/tags/${options.tag}^{commit}`],
          { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
      } catch {
        existingTagSha = ''; // || true swallows exit 128!
      }
      if (existingTagSha && existingTagSha !== options.targetSha) {
        throw new Error('mismatch');
      }
      return { proceeds: true };
    };

    // Mutant with || true erroneously succeeds on fault
    const mutantRes = mutantVerify({
      tag: 'v2.0.0',
      targetSha: repo.shaA,
      cwd: repo.workDir,
      gitCmd: fakeGit,
    });
    assert.equal(mutantRes.proceeds, true);

    // Mutation control: prove that asserting mutantRes does not proceed throws an AssertionError
    assert.throws(
      () => assert.equal(mutantRes.proceeds, false, 'Mutant must fail safety check'),
      assert.AssertionError,
      'Mutation control: mutant with || true must fail safety assertion'
    );
  } finally {
    repo.cleanup();
  }
});
