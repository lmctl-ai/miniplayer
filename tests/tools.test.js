import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTools, DEFAULT_READ_BYTES, MAX_READ_BYTES, MAX_SHELL_OUTPUT_BYTES, MAX_WRITE_BYTES } from '../src/tools.js';

async function fixture(t) { const cwd = await mkdtemp(join(tmpdir(), 'miniplayer-tools-')); t.after(() => rm(cwd, { recursive: true, force: true })); return cwd; }
async function server(t, handler) {
  const value = createServer(handler); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => value.close(resolve))); return `http://127.0.0.1:${value.address().port}`;
}

test('read_file uses byte offsets and bounded paging', async t => {
  const cwd = await fixture(t); await writeFile(join(cwd, 'text.txt'), 'αβγδε'); const read = createTools({ cwd }).read_file.execute;
  const first = await read({ path: 'text.txt', maxBytes: 3 });
  assert.equal(first.content, 'α�'); assert.equal(first.bytesRead, 3); assert.equal(first.nextOffset, 3); assert.equal(first.truncated, true);
  const second = await read({ path: 'text.txt', offset: 3, maxBytes: 3 }); assert.equal(second.content, '�γ'); assert.equal(second.eof, false);
  const last = await read({ path: 'text.txt', offset: 8, maxBytes: 2 }); assert.equal(last.eof, true); assert.equal(last.bytesRead, 2);
});

test('read_file rejects unsafe limits and non-regular files', async t => {
  const cwd = await fixture(t); await writeFile(join(cwd, 'x'), 'x'); const read = createTools({ cwd }).read_file.execute;
  await assert.rejects(read({ path: 'x', maxBytes: MAX_READ_BYTES + 1 }), /maxBytes/); await assert.rejects(read({ path: 'x', maxBytes: 0 }), /maxBytes/);
  await assert.rejects(read({ path: 'missing' }), /ENOENT/); await assert.rejects(read({ path: '.' }), /regular file/);
});

test('read_file defaults to 64KiB and handles large files', async t => {
  const cwd = await fixture(t); await writeFile(join(cwd, 'large'), 'x'.repeat(DEFAULT_READ_BYTES + 5));
  const result = await createTools({ cwd }).read_file.execute({ path: 'large' }); assert.equal(result.bytesRead, DEFAULT_READ_BYTES); assert.equal(result.truncated, true);
});

test('list_directory pages entries and rejects nonprogressing limits', async t => {
  const cwd = await fixture(t); await mkdir(join(cwd, 'dir')); await writeFile(join(cwd, 'a'), 'a'); await writeFile(join(cwd, 'b'), 'b');
  const list = createTools({ cwd }).list_directory.execute; const first = await list({ path: '.', limit: 2 }); assert.equal(first.eof, false);
  const second = await list({ path: '.', offset: first.nextOffset, limit: 2 }); assert.equal(second.eof, true); assert.equal(second.entries.length, 1);
  await assert.rejects(list({ path: '.', limit: 0 }), /limit/); await assert.rejects(list({ path: '.', limit: 1001 }), /limit/);
});

test('write_file atomically writes UTF-8, preserves mode, and bounds content', async t => {
  const cwd = await fixture(t); const target = join(cwd, 'out.txt'); await writeFile(target, 'old', { mode: 0o600 }); const write = createTools({ cwd }).write_file.execute;
  const result = await write({ path: 'out.txt', content: 'héllo' }); assert.equal(result.bytesWritten, 6); assert.equal(await readFile(target, 'utf8'), 'héllo');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await assert.rejects(write({ path: 'too-big', content: 'x'.repeat(MAX_WRITE_BYTES + 1) }), /exceeds/);
});

test('pre-aborted writes do not create files', async t => {
  const cwd = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(createTools({ cwd, signal: controller.signal }).write_file.execute({ path: 'new', content: 'x' }), /aborted/);
  await assert.rejects(readFile(join(cwd, 'new')), /ENOENT/);
});

test('write_file rejects symlink targets', async t => {
  const cwd = await fixture(t); await writeFile(join(cwd, 'real'), 'x'); const { symlink } = await import('node:fs/promises'); await symlink('real', join(cwd, 'link'));
  await assert.rejects(createTools({ cwd }).write_file.execute({ path: 'link', content: 'y' }), /non-symlink/);
});

test('shell returns stderr, nonzero status, and exact supplied environment', async t => {
  const cwd = await fixture(t); const result = await createTools({ cwd, env: { PATH: process.env.PATH, ONLY_THIS: 'yes' } }).shell.execute({ command: 'printf "$ONLY_THIS:$HOME"; printf err >&2; exit 7' });
  assert.equal(result.stdout, 'yes:'); assert.equal(result.stderr, 'err'); assert.equal(result.exitCode, 7); assert.equal(result.signal, null);
});

test('shell drains while capping combined output', async t => {
  const cwd = await fixture(t); const result = await createTools({ cwd, env: { PATH: process.env.PATH } }).shell.execute({ command: `head -c ${MAX_SHELL_OUTPUT_BYTES + 100} /dev/zero` });
  assert.ok(Buffer.byteLength(result.stdout) <= MAX_SHELL_OUTPUT_BYTES); assert.equal(result.truncated, true);
});

test('abort kills TERM-resistant shell process group and pre-abort does not spawn', async t => {
  const cwd = await fixture(t); const controller = new AbortController(); const tools = createTools({ cwd, env: { PATH: process.env.PATH }, signal: controller.signal });
  const promise = tools.shell.execute({ command: 'trap "" TERM; sleep 30' }); setTimeout(() => controller.abort(), 50).unref(); const result = await promise;
  assert.equal(result.exitCode, null); assert.equal(result.signal, 'SIGKILL');
  const pre = new AbortController(); pre.abort(); await assert.rejects(createTools({ cwd, signal: pre.signal }).shell.execute({ command: 'touch spawned' }), /aborted/);
});

test('all five tools are always available and events retain call ids', async t => {
  const cwd = await fixture(t); const events = []; const tools = createTools({ cwd, onToolEvent: value => events.push(value) });
  assert.deepEqual(Object.keys(tools).sort(), ['list_directory', 'read_file', 'shell', 'webget', 'write_file']); await tools.list_directory.execute({ path: '.' }, { toolCallId: 'x' });
  assert.equal(events[0].toolCallId, 'x'); assert.equal(events.at(-1).type, 'tool_result');
});

test('webget streams bounded HTTP(S), supports offsets and rejects other schemes', async t => {
  const cwd = await fixture(t); const base = await server(t, (req, res) => { if (req.url === '/redirect') { res.writeHead(302, { location: '/data' }); res.end(); return; } res.writeHead(req.url === '/bad' ? 500 : 200, { 'content-type': 'text/plain' }); res.end('0123456789'); });
  const get = createTools({ cwd }).webget.execute; await assert.rejects(get({ url: 'file:///etc/passwd' }), /http or https/);
  const result = await get({ url: `${base}/redirect`, offset: 3, maxBytes: 4 }); assert.equal(result.status, 200); assert.equal(result.content, '3456'); assert.equal(result.bytesRead, 4); assert.equal(result.truncated, true); assert.match(result.finalUrl, /\/data$/);
  const bad = await get({ url: `${base}/bad` }); assert.equal(bad.status, 500); assert.equal(bad.content, '0123456789');
});

test('webget cancellation aborts a chunked response', async t => {
  const cwd = await fixture(t); const base = await server(t, (_req, res) => { res.writeHead(200); const timer = setInterval(() => res.write('chunk'), 10); res.on('close', () => clearInterval(timer)); });
  const controller = new AbortController(); const promise = createTools({ cwd, signal: controller.signal }).webget.execute({ url: base }); setTimeout(() => controller.abort(), 30).unref(); await assert.rejects(promise, /aborted|AbortError|cancelled/i);
});
