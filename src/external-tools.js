import { spawn } from 'node:child_process';
import { basename, isAbsolute, resolve } from 'node:path';
import { tool, jsonSchema } from 'ai';

export const MAX_STDOUT_BYTES = 256 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;

const toolInputSchema = jsonSchema({
  type: 'object',
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments to pass to the tool command (argv after the command, no shell)',
    },
    stdin: {
      type: 'string',
      description: 'Optional standard input to pass to the tool command',
    },
  },
  required: ['args'],
  additionalProperties: false,
});

export function sanitizeToolName(name) {
  if (typeof name !== 'string' || !name.trim()) return 'tool';
  const sanitized = name.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitized || 'tool';
}

export function parseToolConfigItem(item) {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    const base = basename(trimmed).replace(/\.[^/.]+$/, '');
    return {
      command: trimmed,
      name: sanitizeToolName(base),
      brief: undefined,
    };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const command = typeof item.command === 'string' ? item.command.trim() : '';
    const name = typeof item.name === 'string' && item.name.trim()
      ? sanitizeToolName(item.name.trim())
      : sanitizeToolName(basename(command).replace(/\.[^/.]+$/, ''));
    const brief = typeof item.brief === 'string' ? item.brief : undefined;
    return { command, name, brief };
  }
  throw new TypeError('Invalid tool config item');
}

function signalGroup(child, sig) {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    try { child.kill(sig); } catch { /* child exited */ }
  }
}

export function executeExternalTool({
  command,
  name,
  args = [],
  stdin,
  cwd = process.cwd(),
  env = process.env,
  signal,
  onToolEvent,
  toolCallId,
}) {
  const toolName = name || sanitizeToolName(command);
  const inputPayload = { args, ...(stdin !== undefined ? { stdin } : {}) };

  try {
    onToolEvent?.({
      type: 'tool_call',
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      input: inputPayload,
    });
  } catch { /* telemetry must not crash tool */ }

  if (signal?.aborted) {
    const error = new Error('The tool operation was aborted');
    error.name = 'AbortError';
    try {
      onToolEvent?.({
        type: 'tool_result',
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        status: 'failed',
        error: error.message,
      });
    } catch {}
    throw error;
  }

  const effectiveCwd = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);

  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    let aborted = false;
    let killTimer;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
    };

    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      signalGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), 250);
      killTimer.unref?.();
    };

    try {
      child = spawn(command, args, {
        shell: false,
        cwd: effectiveCwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      // Synchronous spawn error (e.g. invalid arguments or immediate ENOENT)
      cleanup();
      const result = {
        exit_code: null,
        stdout: '',
        stderr: spawnError.message,
        truncated: false,
      };
      try {
        onToolEvent?.({
          type: 'tool_result',
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          status: 'failed',
          result,
          error: spawnError.message,
        });
      } catch {}
      return resolvePromise(result);
    }

    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    child.stdin.on('error', () => {});
    if (stdin !== undefined && typeof stdin === 'string') {
      child.stdin.end(stdin, 'utf8');
    } else {
      child.stdin.end();
    }

    child.stdout.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = MAX_STDOUT_BYTES - stdoutBytes;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      const kept = bytes.subarray(0, remaining);
      stdoutChunks.push(kept);
      stdoutBytes += kept.length;
      if (kept.length < bytes.length) stdoutTruncated = true;
    });

    child.stderr.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      const kept = bytes.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
      if (kept.length < bytes.length) stderrTruncated = true;
    });

    child.once('error', error => {
      cleanup();
      // Spawn failure (ENOENT) is a normal tool error result, not a crash.
      const result = {
        exit_code: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: error.message,
        truncated: false,
      };
      try {
        onToolEvent?.({
          type: 'tool_result',
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          status: 'failed',
          result,
          error: error.message,
        });
      } catch {}
      resolvePromise(result);
    });

    child.once('close', (exitCode, exitSignal) => {
      cleanup();
      if (signal?.aborted || aborted) {
        const err = new Error('The tool operation was aborted');
        err.name = 'AbortError';
        try {
          onToolEvent?.({
            type: 'tool_result',
            toolName,
            ...(toolCallId ? { toolCallId } : {}),
            status: 'failed',
            error: err.message,
          });
        } catch {}
        return rejectPromise(err);
      }

      const result = {
        exit_code: exitCode !== null ? exitCode : (exitSignal ? null : 0),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated: stdoutTruncated || stderrTruncated,
      };

      try {
        onToolEvent?.({
          type: 'tool_result',
          toolName,
          ...(toolCallId ? { toolCallId } : {}),
          status: result.exit_code === 0 ? 'completed' : 'failed',
          result,
        });
      } catch {}

      resolvePromise(result);
    });
  });
}

export function createExternalTools({
  toolsConfig,
  cwd = process.cwd(),
  env = process.env,
  signal,
  onToolEvent,
} = {}) {
  if (!Array.isArray(toolsConfig) || toolsConfig.length === 0) {
    return {};
  }

  const tools = {};
  for (const item of toolsConfig) {
    const spec = parseToolConfigItem(item);
    if (!spec.command) continue;

    tools[spec.name] = tool({
      description: spec.brief || `External tool: ${spec.command}`,
      inputSchema: toolInputSchema,
      execute: async (input = {}, callOptions = {}) => {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        const stdin = typeof input.stdin === 'string' ? input.stdin : undefined;
        return executeExternalTool({
          command: spec.command,
          name: spec.name,
          args,
          stdin,
          cwd,
          env,
          signal,
          onToolEvent,
          toolCallId: callOptions.toolCallId,
        });
      },
    });
  }

  return tools;
}
