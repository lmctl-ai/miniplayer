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
const helper = fileURLToPath(new URL('./fixtures/tty-repl.py', import.meta.url));

async function checkPythonPty() {
  const child = spawn('python3', ['-c', 'import pty']);
  try {
    const [code] = await once(child, 'exit');
    return code === 0;
  } catch {
    return false;
  }
}

function runPty(t, mode, config, port = '', command = { node: process.execPath, cli: bin }) {
  const child = spawn('python3', [helper, mode, command.node, command.cli, config, catalog, String(port)], {
    // fd 3 is a readiness notification from the HTTP server, not a timer or file poll.
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = once(child, 'close').then(([code]) => ({ code, stdout, stderr }));
  return { child, result };
}

test('real TTY Ctrl-C exits 0 when idle and cancels turn when running', { timeout: 120000 }, async t => {
  if (!await checkPythonPty()) {
    t.skip('python3 pty helper is unavailable; skipping TTY Ctrl-C test');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'miniplayer-tty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.json');
  writeFileSync(config, '{}');

  const idle = await runPty(t, 'idle', config).result;
  assert.equal(idle.code, 0, `Idle Ctrl-C in TTY mode must exit with code 0: ${idle.stderr}`);

  let turn;
  let serverRequestReceived = false;
  let serverCancelled = false;
  const server = createServer((req, res) => {
    serverRequestReceived = true;
    res.on('close', () => { serverCancelled = true; });
    turn.child.stdio[3].end('R');
    // Keep the request pending until the REPL aborts it. A delayed success response
    // would race cancellation on a busy runner and could hide a cancellation bug.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });

  turn = runPty(t, 'turn', config, server.address().port);
  const result = await turn.result;
  assert.equal(result.code, 0, `REPL must exit 0 after turn cancellation and /exit: ${result.stderr}`);
  assert.ok(result.stdout.includes('turn cancelled'), 'Output should contain "turn cancelled"');
  assert.ok(serverRequestReceived, 'Ctrl-C must cancel an actual in-flight request');
  assert.ok(serverCancelled, 'Ctrl-C must close the in-flight HTTP connection');
});

// Deterministic reproducer: this child prints a prompt before its raw-mode
// control-character handler is ready. Sending Ctrl-C on that prompt would kill it.
test('PTY fixture waits for input acknowledgement, not just an initial prompt', { timeout: 60000 }, async t => {
  if (!await checkPythonPty()) {
    t.skip('python3 pty helper is unavailable');
    return;
  }
  const cli = fileURLToPath(new URL('./fixtures/tty-not-ready.py', import.meta.url));
  const result = await runPty(t, 'idle', '', '', { node: 'python3', cli }).result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes('Show this help'), 'Must observe the input acknowledgement');
});
