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

function checkPythonPty() {
  try {
    const res = spawn('python3', ['-c', 'import pty']);
    return new Promise(resolve => {
      res.on('error', () => resolve(false));
      res.on('exit', code => resolve(code === 0));
    });
  } catch {
    return Promise.resolve(false);
  }
}

test('real TTY Ctrl-C exits 0 when idle and cancels turn when running', { timeout: 15000 }, async t => {
  const ptyAvailable = await checkPythonPty();
  if (!ptyAvailable) {
    t.skip('python3 pty helper is unavailable; skipping TTY Ctrl-C test');
    return;
  }

  // 1. Idle Ctrl-C exits 0
  const idleCode = await new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', `
import pty, os, sys, time, subprocess
node_bin, cli_bin = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
env = dict(os.environ)
env['MINIPLAYER_CONFIG'] = '/dev/null'
proc = subprocess.Popen([node_bin, cli_bin, 'chat', '-m', 'mock/Echo', '--no-wrapup'],
                        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)
os.close(slave)
time.sleep(0.5)
os.write(master, b'\\x03')
proc.wait(timeout=5)
sys.exit(proc.returncode)
`, process.execPath, bin]);

    py.on('error', reject);
    py.on('exit', resolve);
  });
  assert.equal(idleCode, 0, 'Idle Ctrl-C in TTY mode must exit with code 0');

  // 2. In-flight Ctrl-C cancels turn, stays in REPL, then /exit exits 0
  const workDir = mkdtempSync(join(tmpdir(), 'miniplayer-tty-ctrlc-'));
  const config = join(workDir, 'config.json');
  writeFileSync(config, '{}');

  let serverRequestReceived = false;
  let serverCancelled = false;
  const server = createServer(async (req, res) => {
    serverRequestReceived = true;
    req.on('close', () => {
      serverCancelled = true;
    });
    // Delay response long enough for test to send Ctrl-C
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'delayed-resp',
          object: 'chat.completion',
          created: Date.now(),
          model: 'qwen2.5:14b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Slow reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }));
      }
    }, 4000);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(workDir, { recursive: true, force: true });
  });

  const port = server.address().port;
  const turnResult = await new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', `
import pty, os, sys, time, subprocess, select

node_bin, cli_bin, port, cfg, cat = sys.argv[1:6]
master, slave = pty.openpty()
env = dict(os.environ)
env['MINIPLAYER_CONFIG'] = cfg
env['MINIPLAYER_CATALOG'] = cat
env['OLLAMA_HOST'] = f'http://127.0.0.1:{port}'

proc = subprocess.Popen([node_bin, cli_bin, 'chat', '-m', 'ollama/qwen2.5:14b', '--no-wrapup'],
                        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env)
os.close(slave)

output = b''
time.sleep(0.5)

# Send turn prompt
os.write(master, b'hello slow turn\\n')

# Wait for turn to start, then send Ctrl-C (\\x03)
time.sleep(0.8)
os.write(master, b'\\x03')

# Read output until prompt returns
start_time = time.time()
while time.time() - start_time < 3:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
        chunk = os.read(master, 1024)
        output += chunk
        if b'turn cancelled' in output or b'> ' in output[2:]:
            break

# Send /exit to quit cleanly
os.write(master, b'/exit\\n')
proc.wait(timeout=5)
sys.stdout.buffer.write(output)
sys.exit(proc.returncode)
`, process.execPath, bin, String(port), config, catalog]);

    let pyOut = '';
    py.stdout.on('data', d => { pyOut += d.toString('utf8'); });
    py.on('error', reject);
    py.on('exit', code => resolve({ code, pyOut }));
  });

  assert.equal(turnResult.code, 0, 'REPL must exit 0 after turn cancellation and /exit');
  assert.ok(turnResult.pyOut.includes('turn cancelled'), 'Output should contain "turn cancelled"');
});
