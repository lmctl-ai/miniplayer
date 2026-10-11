import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const bin = fileURLToPath(new URL('../bin/miniplayer.js', import.meta.url));
const catalog = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
const faketool = fileURLToPath(new URL('./fixtures/faketool.js', import.meta.url));

function runCli(args, { env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

test('run and classify are pure: no tools sent, no preamble or context files in system prompt', { timeout: 15000 }, async t => {
  const workDir = mkdtempSync(join(tmpdir(), 'miniplayer-pure-'));
  const config = join(workDir, 'config.json');
  // Configure tools and wrapUp in config.json to ensure run and classify ignore them!
  writeFileSync(config, JSON.stringify({
    wrapUp: true,
    tools: [{ name: 'faketool', command: faketool }],
  }));

  // Create dummy AGENTS.md and durable-memory/index.md in workDir
  writeFileSync(join(workDir, 'AGENTS.md'), '# Agents instructions that must NOT appear in pure run');

  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = JSON.parse(body);
    requests.push(json);

    let reply = 'Pure reply';
    // If it's a classification prompt
    if (json.messages?.some(m => typeof m.content === 'string' && m.content.includes('"label"'))) {
      reply = JSON.stringify({ label: 'task-done', reason: 'finished', confidence: 0.95 });
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `resp-${requests.length}`,
      object: 'chat.completion',
      created: Date.now(),
      model: 'qwen2.5:14b',
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const env = {
    MINIPLAYER_CONFIG: config,
    MINIPLAYER_CATALOG: catalog,
    OLLAMA_HOST: `http://127.0.0.1:${server.address().port}`,
  };

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  // 1. Bare "miniplayer run"
  requests.length = 0;
  const res1 = await runCli(['run', '-m', 'ollama/qwen2.5:14b', 'Hello raw prompt'], { env, cwd: workDir });
  assert.equal(res1.code, 0, res1.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined, 'run must never send tools');
  // In OpenAI-compatible provider: if no system prompt is provided, messages should only contain user turn
  const sysMsg1 = requests[0].messages.find(m => m.role === 'system');
  assert.equal(sysMsg1, undefined, 'pure run must have no system prompt when none specified');
  const userMsg1 = requests[0].messages.find(m => m.role === 'user');
  assert.equal(userMsg1?.content, 'Hello raw prompt');

  // 2. "miniplayer run --system <text>"
  requests.length = 0;
  const res2 = await runCli(['run', '-m', 'ollama/qwen2.5:14b', '--system', 'Custom sys text', 'Hello with system'], { env, cwd: workDir });
  assert.equal(res2.code, 0, res2.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined, 'run must never send tools');
  const sysMsg2 = requests[0].messages.find(m => m.role === 'system');
  assert.equal(sysMsg2?.content, 'Custom sys text', 'system prompt must match exactly without extra preamble/context');

  // 3. "miniplayer run --system-file <path> --file <path>"
  const sysFilePath = join(workDir, 'my-sys.txt');
  const inputFilePath = join(workDir, 'my-input.txt');
  writeFileSync(sysFilePath, 'Prompt from sys file');
  writeFileSync(inputFilePath, 'Prompt from input file');
  requests.length = 0;
  const res3 = await runCli(['run', '-m', 'ollama/qwen2.5:14b', '--system-file', sysFilePath, '--file', inputFilePath], { env, cwd: workDir });
  assert.equal(res3.code, 0, res3.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined, 'run must never send tools');
  const sysMsg3 = requests[0].messages.find(m => m.role === 'system');
  assert.equal(sysMsg3?.content, 'Prompt from sys file');
  const userMsg3 = requests[0].messages.find(m => m.role === 'user');
  assert.equal(userMsg3?.content, 'Prompt from input file');

  // 4. "miniplayer classify"
  requests.length = 0;
  const res4 = await runCli(['classify', '-m', 'ollama/qwen2.5:14b'], { env, cwd: workDir, input: 'The patch is done.' });
  assert.equal(res4.code, 0, res4.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined, 'classify must never send tools');
  const sysMsg4 = requests[0].messages.find(m => m.role === 'system');
  assert.equal(sysMsg4, undefined, 'classify has no extra system prompt by default');

  // 5. "miniplayer classify --system <text>"
  requests.length = 0;
  const res5 = await runCli(['classify', '-m', 'ollama/qwen2.5:14b', '--system', 'Custom classify sys'], { env, cwd: workDir, input: 'The patch is done.' });
  assert.equal(res5.code, 0, res5.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools, undefined, 'classify must never send tools');
  const sysMsg5 = requests[0].messages.find(m => m.role === 'system');
  assert.equal(sysMsg5?.content, 'Custom classify sys');
});
