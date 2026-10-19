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
  const idleDir = mkdtempSync(join(tmpdir(), 'miniplayer-tty-idle-'));
  t.after(() => rmSync(idleDir, { recursive: true, force: true }));
  const idleConfig = join(idleDir, 'config.json');
  writeFileSync(idleConfig, '{}');

  let idleDiagnostic = '';
  const idleCode = await new Promise((resolve, reject) => {
    const py = spawn('python3', ['-c', `
import pty, os, sys, time, subprocess, select, fcntl, termios
node_bin, cli_bin, cfg = sys.argv[1:4]
master, slave = pty.openpty()
# Give the child the same controlling-terminal/foreground-group contract as a real shell.
# Merely wiring an openpty slave to stdio leaves macOS terminal signals undelivered.
def own_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
env = dict(os.environ)
env['MINIPLAYER_CONFIG'] = cfg
proc = subprocess.Popen([node_bin, cli_bin, 'chat', '-m', 'mock/Echo', '--no-wrapup'],
                        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env, preexec_fn=own_terminal)
os.close(slave)

# Wait for REPL prompt '> '
out = b''
start = time.time()
while time.time() - start < 5:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        out += os.read(master, 1024)
        if b'> ' in out:
            break

# Send Ctrl-C while idle
os.write(master, b'\\x03')
try:
    proc.wait(timeout=5)
    sys.exit(proc.returncode)
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()
    sys.stderr.write('idle PTY timeout; output=' + repr(out))
    sys.exit(124)
`, process.execPath, bin, idleConfig]);

    py.stderr.on('data', data => { idleDiagnostic += data.toString('utf8'); });
    py.on('error', reject);
    py.on('exit', resolve);
  });
  assert.equal(idleCode, 0, `Idle Ctrl-C in TTY mode must exit with code 0: ${idleDiagnostic}`);

  // 2. In-flight Ctrl-C cancels turn, stays in REPL, then /exit exits 0
  const workDir = mkdtempSync(join(tmpdir(), 'miniplayer-tty-ctrlc-'));
  const config = join(workDir, 'config.json');
  const turnStartedFile = join(workDir, 'turn-started');
  writeFileSync(config, '{}');

  let serverRequestReceived = false;
  let serverCancelled = false;
  const server = createServer(async (req, res) => {
    serverRequestReceived = true;
    try { writeFileSync(turnStartedFile, 'started'); } catch {}
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
import pty, os, sys, time, subprocess, select, fcntl, termios

node_bin, cli_bin, port, cfg, cat, start_file = sys.argv[1:7]
master, slave = pty.openpty()
# Give the child the same controlling-terminal/foreground-group contract as a real shell.
# Merely wiring an openpty slave to stdio leaves macOS terminal signals undelivered.
def own_terminal():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
env = dict(os.environ)
env['MINIPLAYER_CONFIG'] = cfg
env['MINIPLAYER_CATALOG'] = cat
env['OLLAMA_HOST'] = f'http://127.0.0.1:{port}'

proc = subprocess.Popen([node_bin, cli_bin, 'chat', '-m', 'ollama/qwen2.5:14b', '--no-wrapup'],
                        stdin=slave, stdout=slave, stderr=slave, close_fds=True, env=env, preexec_fn=own_terminal)
os.close(slave)

output = b''
# Wait for initial prompt '> '
start = time.time()
while time.time() - start < 5:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        output += os.read(master, 1024)
        if b'> ' in output:
            break

# Send turn prompt
os.write(master, b'hello slow turn\\n')

# Wait for server to receive request
wait_start = time.time()
while time.time() - wait_start < 5:
    if os.path.exists(start_file):
        break
    time.sleep(0.05)

# Send Ctrl-C to cancel active turn
os.write(master, b'\\x03')

# Read output until prompt returns
start_time = time.time()
while time.time() - start_time < 5:
    r, _, _ = select.select([master], [], [], 0.05)
    if r:
        chunk = os.read(master, 1024)
        output += chunk
        if b'turn cancelled' in output and output.count(b'> ') >= 2:
            break

# Send /exit to quit cleanly
os.write(master, b'/exit\\n')
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
sys.stdout.buffer.write(output)
sys.exit(proc.returncode)
`, process.execPath, bin, String(port), config, catalog, turnStartedFile]);

    let pyOut = '';
    py.stdout.on('data', d => { pyOut += d.toString('utf8'); });
    py.on('error', reject);
    py.on('exit', code => resolve({ code, pyOut }));
  });

  assert.equal(turnResult.code, 0, 'REPL must exit 0 after turn cancellation and /exit');
  assert.ok(turnResult.pyOut.includes('turn cancelled'), 'Output should contain "turn cancelled"');
});
