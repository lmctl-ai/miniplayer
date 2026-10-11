import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/miniplayer.js', import.meta.url));
const catalog = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

function connectAcp(env, cwd) {
  const child = spawn(process.execPath, [bin, 'acp', '-m', 'ollama/qwen2.5:14b'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const requests = new Map();
  const updates = [];
  let nextId = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method) updates.push(message);
    else {
      const pending = requests.get(message.id);
      requests.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message));
      else pending?.resolve(message.result);
    }
  });
  const exited = once(child, 'exit');
  child.on('exit', code => {
    for (const pending of requests.values()) {
      pending.reject(new Error(`ACP exited ${code}: ${stderr}`));
    }
    requests.clear();
  });
  return {
    child,
    updates,
    exited,
    request(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        requests.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

test('compaction with real model in ACP carries no tools and succeeds', { timeout: 15000 }, async t => {
  const workDir = mkdtempSync(join(tmpdir(), 'miniplayer-compact-acp-'));
  const config = join(workDir, 'config.json');
  writeFileSync(config, JSON.stringify({
    compact: { thresholdTokens: 1 },
    tools: [{ name: 'faketool', command: faketool }],
  }));

  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request);

    // If it's a compaction request (asking for JSON summary & notes)
    const isCompaction = request.messages?.some(m => typeof m.content === 'string' && m.content.includes('JSON object'));
    let replyContent = 'Turn reply';
    if (isCompaction) {
      replyContent = JSON.stringify({
        summary: 'Compacted context summary',
        notes: 'Durable session notes',
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `resp-${calls.length}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'qwen2.5:14b',
      choices: [{ index: 0, message: { role: 'assistant', content: replyContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const env = {
    ...process.env,
    MINIPLAYER_CONFIG: config,
    MINIPLAYER_CATALOG: catalog,
    OLLAMA_HOST: `http://127.0.0.1:${server.address().port}`,
  };

  const client = connectAcp(env, workDir);
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  await client.request('initialize', { protocolVersion: 1 });
  const { sessionId } = await client.request('session/new', { cwd: workDir, mcpServers: [] });

  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'turn 1' }] });
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'turn 2' }] });
  await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'turn 3' }] });

  // Finding 2 verification: compaction request must have run, carried NO tools, and succeeded
  const compactionCalls = calls.filter(c => c.messages?.some(m => typeof m.content === 'string' && m.content.includes('JSON object')));
  assert.ok(compactionCalls.length >= 1, 'Expected at least one compaction call to the server');
  assert.equal(compactionCalls[0].tools, undefined, 'Compaction request must carry NO tools');

  // Verify notes file was written in durable-memory/
  const durableDir = join(workDir, 'durable-memory');
  const files = readdirSync(durableDir);
  const notesFiles = files.filter(f => f.endsWith('-session-notes.md'));
  assert.ok(notesFiles.length >= 1, 'Expected a session notes file in durable-memory');
  const notesContent = readFileSync(join(durableDir, notesFiles[0]), 'utf8');
  assert.ok(notesContent.includes('Durable session notes'));
});

test('compaction with real model in REPL carries no tools and succeeds', { timeout: 15000 }, async t => {
  const workDir = mkdtempSync(join(tmpdir(), 'miniplayer-compact-repl-'));
  const config = join(workDir, 'config.json');
  writeFileSync(config, JSON.stringify({
    compact: { thresholdTokens: 1 },
    tools: [{ name: 'faketool', command: faketool }],
  }));

  const calls = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request);

    const isCompaction = request.messages?.some(m => typeof m.content === 'string' && m.content.includes('JSON object'));
    let replyContent = 'Turn reply';
    if (isCompaction) {
      replyContent = JSON.stringify({
        summary: 'Compacted context summary in REPL',
        notes: 'Durable session notes in REPL',
      });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `resp-${calls.length}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'qwen2.5:14b',
      choices: [{ index: 0, message: { role: 'assistant', content: replyContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const env = {
    ...process.env,
    MINIPLAYER_CONFIG: config,
    MINIPLAYER_CATALOG: catalog,
    OLLAMA_HOST: `http://127.0.0.1:${server.address().port}`,
  };

  const child = spawn(process.execPath, [bin, 'chat', '-m', 'ollama/qwen2.5:14b', '--no-wrapup'], {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  child.stdin.write('one\n');
  await new Promise(r => setTimeout(r, 200));
  child.stdin.write('two\n');
  await new Promise(r => setTimeout(r, 200));
  child.stdin.write('three\n');
  await new Promise(r => setTimeout(r, 500));
  child.stdin.write('/exit\n');
  await once(child, 'exit');

  const compactionCalls = calls.filter(c => c.messages?.some(m => typeof m.content === 'string' && m.content.includes('JSON object')));
  assert.ok(compactionCalls.length >= 1, 'Expected at least one compaction call in REPL');
  assert.equal(compactionCalls[0].tools, undefined, 'REPL compaction request must carry NO tools');

  const durableDir = join(workDir, 'durable-memory');
  const files = readdirSync(durableDir);
  const notesFiles = files.filter(f => f.endsWith('-session-notes.md'));
  assert.ok(notesFiles.length >= 1, 'Expected a session notes file in durable-memory for REPL');
  const notesContent = readFileSync(join(durableDir, notesFiles[0]), 'utf8');
  assert.ok(notesContent.includes('Durable session notes in REPL'));
});

