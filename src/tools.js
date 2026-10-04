import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, readdir, rename, lstat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tool, jsonSchema } from 'ai';

export const DEFAULT_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WEBGET_BYTES = MAX_READ_BYTES;
export const DEFAULT_DIRECTORY_ENTRIES = 200;
export const MAX_DIRECTORY_ENTRIES = 1000;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;

const schema = value => jsonSchema(value);
const fail = message => { throw new TypeError(message); };
const throwIfAborted = signal => {
  if (signal?.aborted) { const error = new Error('The tool operation was aborted'); error.name = 'AbortError'; throw error; }
};
function contextOf({ cwd = process.cwd(), env = process.env, signal, onToolEvent } = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('cwd must be an absolute directory path');
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('env must be an object');
  return { cwd: resolve(cwd), env, signal, onToolEvent };
}
function pathArg(value, field = 'path') {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}
function boundedInt(value, field, fallback, max, nonzero = false) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < (nonzero ? 1 : 0) || value > max) fail(`${field} must be an integer from ${nonzero ? 1 : 0} to ${max}`);
  return value;
}
function target(ctx, value) { return isAbsolute(value) ? resolve(value) : resolve(ctx.cwd, value); }
function emit(ctx, event) { try { ctx.onToolEvent?.(event); } catch { /* telemetry cannot alter tool behavior */ } }
function event(name, type, options, fields = {}) { return { type, toolName: name, ...(options?.toolCallId ? { toolCallId: options.toolCallId } : {}), ...fields }; }
async function invoke(ctx, name, args, options, operation) {
  throwIfAborted(ctx.signal);
  emit(ctx, event(name, 'tool_call', options, { input: args }));
  try { const result = await operation(); emit(ctx, event(name, 'tool_result', options, { result })); return result; }
  catch (error) { emit(ctx, event(name, 'tool_result', options, { status: 'failed', error: error?.message ?? String(error) })); throw error; }
}

async function listDirectory(ctx, args = {}, options) {
  return invoke(ctx, 'list_directory', args, options, async () => {
    const path = target(ctx, pathArg(args.path));
    const offset = boundedInt(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInt(args.limit, 'limit', DEFAULT_DIRECTORY_ENTRIES, MAX_DIRECTORY_ENTRIES, true);
    const entries = await readdir(path, { withFileTypes: true });
    const page = entries.slice(offset, offset + limit).map(entry => ({ name: entry.name,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' }));
    const nextOffset = offset + page.length;
    return { path, entries: page, offset, nextOffset, eof: nextOffset >= entries.length, truncated: nextOffset < entries.length };
  });
}

async function readFileTool(ctx, args = {}, options) {
  return invoke(ctx, 'read_file', args, options, async () => {
    const path = target(ctx, pathArg(args.path));
    const offset = boundedInt(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = boundedInt(args.maxBytes ?? args.limit, 'maxBytes', DEFAULT_READ_BYTES, MAX_READ_BYTES, true);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile()) fail(`read_file requires a regular file: ${path}`);
      throwIfAborted(ctx.signal);
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
      const eof = offset + bytesRead >= info.size;
      return { path, offset, bytesRead, content: buffer.subarray(0, bytesRead).toString('utf8'), nextOffset: offset + bytesRead,
        eof, truncated: !eof && bytesRead === maxBytes };
    } finally { await handle.close(); }
  });
}

async function writeFileTool(ctx, args = {}, options) {
  return invoke(ctx, 'write_file', args, options, async () => {
    throwIfAborted(ctx.signal);
    const path = target(ctx, pathArg(args.path));
    if (typeof args.content !== 'string') fail('content must be a string');
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > MAX_WRITE_BYTES) fail(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    let mode = 0o644;
    try {
      const existing = await lstat(path);
      if (existing.isSymbolicLink() || !existing.isFile()) fail(`write_file requires a regular non-symlink target: ${path}`);
      mode = existing.mode & 0o7777;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = join(dirname(path), `.${path.split(sep).pop()}.miniplayer-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, args.content, { encoding: 'utf8', flag: 'wx', mode, signal: ctx.signal });
      throwIfAborted(ctx.signal);
      await rename(temporary, path);
    } catch (error) { try { await unlink(temporary); } catch { /* best effort cleanup */ } throw error; }
    return { path, bytesWritten: bytes };
  });
}

function signalGroup(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* exited */ } }
}
async function shellTool(ctx, args = {}, options) {
  return invoke(ctx, 'shell', args, options, async () => {
    if (typeof args.command !== 'string' || !args.command.trim()) fail('command must be a non-empty string');
    const cwd = args.cwd === undefined ? ctx.cwd : target(ctx, pathArg(args.cwd, 'cwd'));
    throwIfAborted(ctx.signal);
    const child = spawn('/bin/sh', ['-c', args.command], { cwd, env: ctx.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = []; const stderrChunks = []; let outputSize = 0; let truncated = false; let aborted = false; let killTimer;
    const collect = (chunks, chunk) => { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); const remaining = MAX_SHELL_OUTPUT_BYTES - outputSize;
      if (remaining <= 0) { truncated = true; return; } const kept = bytes.subarray(0, remaining); chunks.push(kept); outputSize += kept.length; if (kept.length < bytes.length) truncated = true; };
    child.stdout.on('data', chunk => collect(stdoutChunks, chunk)); child.stderr.on('data', chunk => collect(stderrChunks, chunk));
    let abortListener;
    const abort = () => { if (aborted) return; aborted = true; signalGroup(child, 'SIGTERM'); killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 250); killTimer.unref?.(); };
    const result = await new Promise((resolveResult, reject) => {
      const cleanup = () => { ctx.signal?.removeEventListener('abort', abortListener); if (killTimer) clearTimeout(killTimer); };
      abortListener = abort; if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener('abort', abortListener, { once: true });
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', (exitCode, signal) => { cleanup(); resolveResult({ exitCode: aborted ? null : exitCode, signal: signal ?? (aborted ? 'SIGTERM' : null) }); });
    });
    return { ...result, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: Buffer.concat(stderrChunks).toString('utf8'), truncated };
  });
}

async function webgetTool(ctx, args = {}, options) {
  return invoke(ctx, 'webget', args, options, async () => {
    if (typeof args.url !== 'string') fail('url must be a string');
    let url; try { url = new URL(args.url); } catch { fail('url must be a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) fail('url must use http or https');
    const offset = boundedInt(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = boundedInt(args.maxBytes, 'maxBytes', DEFAULT_READ_BYTES, MAX_READ_BYTES, true);
    const response = await fetch(url, { signal: ctx.signal, redirect: 'follow' });
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, contentType: response.headers.get('content-type'), finalUrl: response.url, content: '', bytesRead: 0, nextOffset: offset, eof: true, truncated: false };
    const chunks = []; let skipped = 0; let captured = 0; let done = false;
    try {
      while (!done) {
        const item = await reader.read(); done = item.done;
        if (done) break;
        let bytes = Buffer.from(item.value);
        if (skipped < offset) { const drop = Math.min(offset - skipped, bytes.length); skipped += drop; bytes = bytes.subarray(drop); }
        if (!bytes.length) continue;
        const keep = bytes.subarray(0, maxBytes - captured); if (keep.length) { chunks.push(keep); captured += keep.length; }
        if (captured >= maxBytes) { await reader.cancel(); done = true; }
      }
    } finally { reader.releaseLock(); }
    const eof = done && captured < maxBytes;
    return { status: response.status, contentType: response.headers.get('content-type'), finalUrl: response.url,
      content: Buffer.concat(chunks).toString('utf8'), bytesRead: captured, nextOffset: offset + captured, eof, truncated: !eof && captured === maxBytes };
  });
}

const listSchema = { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_DIRECTORY_ENTRIES } }, required: ['path'], additionalProperties: false };
const readSchema = { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES }, limit: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } }, required: ['path'], additionalProperties: false };
const writeSchema = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false };
const shellSchema = { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'], additionalProperties: false };
const webgetSchema = { type: 'object', properties: { url: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES } }, required: ['url'], additionalProperties: false };

export function createTools(options = {}) {
  const ctx = contextOf(options);
  return {
    list_directory: tool({ description: 'List one directory page.', inputSchema: schema(listSchema), execute: (args, callOptions) => listDirectory(ctx, args, callOptions) }),
    read_file: tool({ description: 'Read a bounded UTF-8 byte slice from a regular file.', inputSchema: schema(readSchema), execute: (args, callOptions) => readFileTool(ctx, args, callOptions) }),
    write_file: tool({ description: 'Atomically replace a UTF-8 file.', inputSchema: schema(writeSchema), execute: (args, callOptions) => writeFileTool(ctx, args, callOptions) }),
    shell: tool({ description: 'Run a shell command in the working directory.', inputSchema: schema(shellSchema), execute: (args, callOptions) => shellTool(ctx, args, callOptions) }),
    webget: tool({ description: 'Fetch a bounded HTTP or HTTPS response.', inputSchema: schema(webgetSchema), execute: (args, callOptions) => webgetTool(ctx, args, callOptions) }),
  };
}
