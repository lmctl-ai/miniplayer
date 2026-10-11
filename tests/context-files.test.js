import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildInitialSystemPrompt } from '../src/prompt-builder.js';
import { loadConfig } from '../src/config.js';
import { AcpAgent } from '../src/acp.js';
import { SessionStore } from '../src/session-store.js';

test('buildInitialSystemPrompt respects includeContextFiles option', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-prompt-ctx-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'Unique agents instructions');
    const ddir = join(dir, 'durable-memory');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ddir);
    writeFileSync(join(ddir, 'index.md'), 'Unique memory index');

    // Default: includeContextFiles is true
    const promptWith = await buildInitialSystemPrompt({ cwd: dir, toolsConfig: [] });
    assert.ok(promptWith.includes('Unique agents instructions'));
    assert.ok(promptWith.includes('Unique memory index'));

    // includeContextFiles: false
    const promptWithout = await buildInitialSystemPrompt({ cwd: dir, toolsConfig: [], includeContextFiles: false });
    assert.ok(promptWithout.includes('You are running in directory:'));
    assert.ok(!promptWithout.includes('Unique agents instructions'));
    assert.ok(!promptWithout.includes('Unique memory index'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config validates contextFiles must be boolean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-cfg-ctx-'));
  const cfg = join(dir, 'config.json');
  try {
    writeFileSync(cfg, JSON.stringify({ contextFiles: 'invalid' }));
    await assert.rejects(
      loadConfig(cfg, {}),
      /field "contextFiles" must be a boolean/
    );

    writeFileSync(cfg, JSON.stringify({ contextFiles: false }));
    const loaded = await loadConfig(cfg, {});
    assert.equal(loaded.contextFiles, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP agent respects system override and contextFiles: false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-acp-ctx-'));
  try {
    writeFileSync(join(dir, 'AGENTS.md'), 'ACP agents content');
    const store = new SessionStore(dir);
    const runtime = { env: { MINIPLAYER_HOME: dir }, loadConfig: async () => ({ contextFiles: false }), loadCatalog: async () => [] };

    // 1. contextFiles: false from config
    const agent1 = new AcpAgent({ store, runtime, model: 'ollama/test', send: () => {} });
    await agent1.handle('initialize', { protocolVersion: 1 });
    const s1 = await agent1.handle('session/new', { cwd: dir, mcpServers: [] });
    const live1 = agent1.loaded.get(s1.sessionId);
    assert.ok(!live1.systemPrompt.includes('ACP agents content'), 'contextFiles: false should omit AGENTS.md');
    assert.ok(live1.systemPrompt.includes('You are running in directory:'), 'preamble should still be present');

    // 2. system override: caller owns the entire system prompt
    const agent2 = new AcpAgent({ store, runtime, model: 'mock/Echo', send: () => {}, system: 'Caller owns ACP prompt' });
    await agent2.handle('initialize', { protocolVersion: 1 });
    const s2 = await agent2.handle('session/new', { cwd: dir, mcpServers: [] });
    const live2 = agent2.loaded.get(s2.sessionId);
    assert.equal(live2.systemPrompt, 'Caller owns ACP prompt');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('chat command respects --system and --no-context-files flags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-chat-ctx-'));
  const origCwd = process.cwd();
  try {
    process.chdir(dir);
    writeFileSync(join(dir, 'AGENTS.md'), 'Agents doc text');
    const { execute } = await import('../src/cli.js');
    const { PassThrough } = await import('node:stream');

    let capturedSystem1;
    const stdin1 = new PassThrough();
    const stdout1 = new PassThrough();
    const stderr1 = new PassThrough();
    const deps1 = {
      loadCatalog: async () => [{ record_id: 'test', provider: 'ollama', vendor_model_id: 'test', source: 'litellm' }],
      loadConfig: async () => ({}),
      generate: async (opts) => {
        capturedSystem1 = opts.system;
        return 'done';
      },
    };
    stdin1.end('hi\n/exit\n');
    await execute(['chat', '-m', 'ollama/test', '--system', 'Override chat system', '--no-wrapup'], { stdin: stdin1, stdout: stdout1, stderr: stderr1 }, deps1);
    assert.equal(capturedSystem1, 'Override chat system');

    let capturedSystem2;
    const stdin2 = new PassThrough();
    const stdout2 = new PassThrough();
    const stderr2 = new PassThrough();
    const deps2 = {
      loadCatalog: async () => [{ record_id: 'test', provider: 'ollama', vendor_model_id: 'test', source: 'litellm' }],
      loadConfig: async () => ({}),
      generate: async (opts) => {
        capturedSystem2 = opts.system;
        return 'done';
      },
    };
    stdin2.end('hi\n/exit\n');
    await execute(['chat', '-m', 'ollama/test', '--no-context-files', '--no-wrapup'], { stdin: stdin2, stdout: stdout2, stderr: stderr2 }, deps2);
    assert.ok(!capturedSystem2.includes('Agents doc text'), '--no-context-files must omit AGENTS.md');
    assert.ok(capturedSystem2.includes('You are running in directory:'), 'preamble remains');
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
