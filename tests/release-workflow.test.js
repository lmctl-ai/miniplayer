import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));

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
});

test('tag calculation correctly increments patch numbers', () => {
  function computeNextTag(pkgVersion, existingTags) {
    const m = pkgVersion.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
    const major = m[1];
    const minor = m[2];
    const targetPatch = parseInt(m[3] || '0', 10);

    const re = new RegExp(`^v${major}\\.${minor}\\.(\\d+)$`);
    const patches = [];
    for (const t of existingTags) {
      const tm = t.match(re);
      if (tm) {
        patches.push(parseInt(tm[1], 10));
      }
    }

    if (patches.length === 0) {
      return `v${major}.${minor}.${targetPatch}`;
    }
    return `v${major}.${minor}.${Math.max(...patches) + 1}`;
  }

  // Case 1: No existing tags (first release for 2.0.0)
  assert.equal(computeNextTag('2.0.0', []), 'v2.0.0');

  // Case 2: v2.0.0 already exists
  assert.equal(computeNextTag('2.0.0', ['v2.0.0']), 'v2.0.1');

  // Case 3: v2.0.0, v2.0.1, v2.0.5 exist
  assert.equal(computeNextTag('2.0.0', ['v2.0.0', 'v2.0.1', 'v2.0.5']), 'v2.0.6');

  // Case 4: Tags from other major/minor are ignored
  assert.equal(computeNextTag('2.0.0', ['v1.0.0', 'v1.9.9']), 'v2.0.0');
});
