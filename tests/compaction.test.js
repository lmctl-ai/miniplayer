import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  compactSessionContext,
  estimateContextTokens,
  resolveCompactionThreshold,
  shouldCompact,
  findUserTurnIndices,
} from '../src/compaction.js';
import { generateMock, mockRecord } from '../src/mock.js';

test('estimateContextTokens uses usage.inputTokens if available, otherwise chars/4', () => {
  assert.equal(estimateContextTokens([], { inputTokens: 500 }), 500);
  const msgs = [{ role: 'user', content: 'hello' }];
  const est = Math.ceil(JSON.stringify(msgs).length / 4);
  assert.equal(estimateContextTokens(msgs, {}), est);
  assert.equal(estimateContextTokens(msgs, null), est);
});

test('resolveCompactionThreshold honors config thresholdTokens, thresholdRatio, and fallback', () => {
  // Explicit thresholdTokens
  assert.equal(
    resolveCompactionThreshold({ config: { compact: { thresholdTokens: 5000 } } }),
    5000
  );

  // Model context window with default ratio 0.7
  const record = { context_window: { total_tokens: 100_000 } };
  assert.equal(resolveCompactionThreshold({ record }), 70_000);

  // Custom ratio 0.5
  assert.equal(
    resolveCompactionThreshold({ record, config: { compact: { thresholdRatio: 0.5 } } }),
    50_000
  );

  // Fallback 100_000
  assert.equal(resolveCompactionThreshold({}), 100_000);
});

test('shouldCompact requires more than 2 user turns and exceeding threshold', () => {
  const config = { compact: { thresholdTokens: 10 } };
  // Only 2 user turns -> false even if tokens exceed threshold
  const twoTurns = [
    { role: 'user', content: 'turn 1' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'turn 2' },
    { role: 'assistant', content: 'reply 2' },
  ];
  assert.equal(shouldCompact({ messages: twoTurns, config, lastUsage: { inputTokens: 500 } }), false);

  // 3 user turns and exceeds threshold -> true
  const threeTurns = [
    ...twoTurns,
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'reply 3' },
  ];
  assert.equal(shouldCompact({ messages: threeTurns, config, lastUsage: { inputTokens: 500 } }), true);

  // 3 user turns but below threshold -> false
  assert.equal(shouldCompact({ messages: threeTurns, config, lastUsage: { inputTokens: 5 } }), false);
});

test('compactSessionContext replaces older turns, preserves last 2 turns, writes notes and updates index.md', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'miniplayer-compact-'));
  try {
    const stderrLines = [];
    const stderr = {
      write: (text) => stderrLines.push(text),
    };

    const messages = [
      { role: 'user', content: 'User turn 1: setup db' },
      { role: 'assistant', content: 'Created table users' },
      { role: 'user', content: 'User turn 2: add columns' },
      { role: 'assistant', content: 'Added email column' },
      // Last 2 user turns (with tool call and tool result)
      { role: 'user', content: 'User turn 3: run migration' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'db', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc-1', content: 'migration applied' },
      { role: 'assistant', content: 'Migration success' },
      { role: 'user', content: 'User turn 4: verify db' },
      { role: 'assistant', content: 'Verification complete' },
    ];

    const record = mockRecord('mock/Compactor');
    const result = await compactSessionContext({
      messages,
      record,
      config: { compact: { thresholdTokens: 50 } }, // force threshold trigger
      cwd,
      generate: generateMock,
      stderr,
    });

    assert.equal(result.compacted, true);
    // Messages must start with context summary, then turns 3 and 4 verbatim
    assert.equal(result.messages[0].role, 'user');
    assert.ok(result.messages[0].content.startsWith('Context summary: Mock compacted summary'));

    // Check last 2 turns are kept verbatim
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, 'User turn 3: run migration');
    assert.equal(result.messages[2].role, 'assistant');
    assert.equal(result.messages[3].role, 'tool');
    assert.equal(result.messages[3].tool_call_id, 'tc-1');
    assert.equal(result.messages[4].role, 'assistant');
    assert.equal(result.messages[5].role, 'user');
    assert.equal(result.messages[5].content, 'User turn 4: verify db');
    assert.equal(result.messages[6].role, 'assistant');

    // Stderr output verified
    assert.ok(stderrLines.some(line => line.includes('[compacted:')));

    // Check durable-memory file was created
    const notesContent = await readFile(join(cwd, result.notesFile), 'utf8');
    assert.equal(notesContent.trim(), 'Mock durable notes');

    // Check durable-memory/index.md pointer was appended
    const indexContent = await readFile(join(cwd, 'durable-memory', 'index.md'), 'utf8');
    assert.ok(indexContent.includes(result.notesFile.split('/').pop()));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('compactSessionContext fallback on failure preserves original messages and warns', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'miniplayer-compact-fail-'));
  try {
    const warnings = [];
    const messages = [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
    ];

    const result = await compactSessionContext({
      messages,
      config: { compact: { thresholdTokens: 5 } },
      cwd,
      generate: async () => {
        throw new Error('Network error during compaction');
      },
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(result.compacted, false);
    assert.deepEqual(result.messages, messages);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('Network error during compaction'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
