import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/manual-ollama-check.sh', import.meta.url));

test('manual-ollama-check.sh exists, is executable, and passes syntax check', () => {
  const stat = statSync(script);
  assert.ok(stat.isFile(), 'manual-ollama-check.sh must be a file');
  if (process.platform !== 'win32') assert.ok(Boolean(stat.mode & 0o111), 'manual-ollama-check.sh must be executable');

  const bash = process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  const check = spawnSync(bash, ['-n', script]);
  assert.equal(check.status, 0, `Syntax check failed: ${check.stderr.toString('utf8')}`);
});
