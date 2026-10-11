import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildInitialSystemPrompt, MAX_PROMPT_FILE_BYTES } from '../src/prompt-builder.js';

const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

test('buildInitialSystemPrompt creates preamble and respects empty tools', async () => {
  const prompt = await buildInitialSystemPrompt({ cwd: '/test/workspace', toolsConfig: [] });
  assert.ok(prompt.includes('You are running in directory: /test/workspace'));
  assert.ok(prompt.includes('Stateless one-shot tools are available for operations.'));
  assert.ok(prompt.includes('Large outputs are saved to files by the tools'));
  assert.ok(!prompt.includes('Available Tools'));
});

test('buildInitialSystemPrompt gathers tool outline via --list from configured tools', async () => {
  const prompt = await buildInitialSystemPrompt({
    cwd: process.cwd(),
    toolsConfig: [{ name: 'faketool', command: faketool }],
  });
  assert.ok(prompt.includes('## Available Tools'));
  assert.ok(prompt.includes('### faketool'));
  assert.ok(prompt.includes('faketool echo [args...]'));
  assert.ok(prompt.includes('faketool fail [args...]'));
  assert.ok(prompt.includes('call through the tool with args ["--help"]'));
});

test('buildInitialSystemPrompt falls back to brief or --help when --list fails', async () => {
  const prompt = await buildInitialSystemPrompt({
    cwd: process.cwd(),
    toolsConfig: [
      { name: 'with_brief', command: 'nonexistent-cmd-1', brief: 'A tool with custom brief' },
      { name: 'no_brief', command: 'nonexistent-cmd-2' },
    ],
  });
  assert.ok(prompt.includes('### with_brief\nA tool with custom brief'));
  assert.ok(prompt.includes('### no_brief\nrun `nonexistent-cmd-2 --help`'));
});

test('buildInitialSystemPrompt includes AGENTS.md and caps at 32 KiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miniplayer-prompt-test-'));
  try {
    // Normal size AGENTS.md
    await writeFile(join(dir, 'AGENTS.md'), '# Agent Instructions\nAlways be concise.');
    const prompt1 = await buildInitialSystemPrompt({ cwd: dir });
    assert.ok(prompt1.includes('## Instructions (AGENTS.md)'));
    assert.ok(prompt1.includes('# Agent Instructions\nAlways be concise.'));

    // Large AGENTS.md > 32 KiB
    const largeContent = 'A'.repeat(MAX_PROMPT_FILE_BYTES + 500);
    await writeFile(join(dir, 'AGENTS.md'), largeContent);
    const prompt2 = await buildInitialSystemPrompt({ cwd: dir });
    assert.ok(prompt2.includes('[AGENTS.md truncated at 32 KiB]'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildInitialSystemPrompt includes durable-memory/index.md and caps at 32 KiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miniplayer-memory-test-'));
  try {
    await mkdir(join(dir, 'durable-memory'), { recursive: true });
    await writeFile(join(dir, 'durable-memory', 'index.md'), '- [note-1.md](./note-1.md): First note');

    const prompt1 = await buildInitialSystemPrompt({ cwd: dir });
    assert.ok(prompt1.includes('## Durable Memory (durable-memory/index.md)'));
    assert.ok(prompt1.includes('- [note-1.md](./note-1.md): First note'));
    assert.ok(prompt1.includes('durable-memory/ holds notes for future sessions; keep index.md as a table of contents of one-line pointers.'));

    // Large durable-memory/index.md > 32 KiB
    const largeContent = 'M'.repeat(MAX_PROMPT_FILE_BYTES + 200);
    await writeFile(join(dir, 'durable-memory', 'index.md'), largeContent);
    const prompt2 = await buildInitialSystemPrompt({ cwd: dir });
    assert.ok(prompt2.includes('[index.md truncated at 32 KiB]'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unreadable AGENTS.md warns on stderr and skips only that section', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miniplayer-prompt-unreadable-'));
  try {
    const agentsPath = join(dir, 'AGENTS.md');
    await writeFile(agentsPath, 'secret content');
    await chmod(agentsPath, 0o000);

    const warnings = [];
    const prompt = await buildInitialSystemPrompt({
      cwd: dir,
      warn: (msg) => warnings.push(msg),
    });

    assert.ok(prompt.includes('You are running in directory:'));
    assert.ok(!prompt.includes('## Instructions (AGENTS.md)'));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('AGENTS.md'));
  } finally {
    try { await chmod(join(dir, 'AGENTS.md'), 0o644); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('--list reader terminates runaway SIGTERM-ignoring tool at 32 KiB cap with SIGKILL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miniplayer-spew-test-'));
  try {
    const scriptPath = join(dir, 'spew.js');
    await writeFile(scriptPath, `#!/usr/bin/env node
process.on('SIGTERM', () => {});
const buf = Buffer.alloc(64 * 1024, 'X');
setInterval(() => {
  try { process.stdout.write(buf); } catch { process.exit(0); }
}, 10);
`, { mode: 0o755 });

    const initialRss = process.memoryUsage().rss;
    const start = Date.now();
    const prompt = await buildInitialSystemPrompt({
      cwd: dir,
      toolsConfig: [{ name: 'spew', command: scriptPath }],
    });
    const elapsed = Date.now() - start;
    const finalRss = process.memoryUsage().rss;

    assert.ok(prompt.includes('### spew'));
    assert.ok(prompt.includes('run `'));
    assert.ok(finalRss - initialRss < 50 * 1024 * 1024, `RSS grew too much: ${finalRss - initialRss}`);
    assert.ok(elapsed < 4000, `Took too long: ${elapsed}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

