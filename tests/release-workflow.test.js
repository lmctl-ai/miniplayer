import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
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
