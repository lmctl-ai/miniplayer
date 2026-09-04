import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClassificationPrompt, parseClassificationOutput } from '../src/classifier.js';

test('parses a clean classification object', () => {
  assert.deepEqual(
    parseClassificationOutput('{"label":"task-done","reason":"Current task shipped","confidence":0.94}'),
    { label: 'task-done', reason: 'Current task shipped', confidence: 0.94 },
  );
});

test('strips JSON code fences and handles braces inside strings', () => {
  assert.deepEqual(
    parseClassificationOutput('```json\n{"label":"all-done","reason":"No {pending} work","confidence":1}\n```'),
    { label: 'all-done', reason: 'No {pending} work', confidence: 1 },
  );
});

test('extracts the first JSON object from surrounding text', () => {
  assert.equal(
    parseClassificationOutput('Result: {"label":"error","reason":"Build failed","confidence":0.7} trailing').label,
    'error',
  );
});

test('garbage output fails with classifier-specific exit code 2', () => {
  assert.throws(
    () => parseClassificationOutput('not JSON'),
    (error) => error.exitCode === 2 && /invalid classification/.test(error.message),
  );
});

test('rejects unknown labels and invalid confidence', () => {
  assert.throws(() => parseClassificationOutput('{"label":"done","reason":"Done","confidence":2}'));
});

test('classification prompt preserves the key task-done versus all-done distinction', () => {
  const prompt = buildClassificationPrompt('Finished this task.');
  assert.match(prompt, /task-done: the current assigned task is finished/);
  assert.match(prompt, /all-done:.*no pending work/);
});
