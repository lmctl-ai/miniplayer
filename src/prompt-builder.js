import { spawn } from 'node:child_process';
import { stat, readFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseToolConfigItem } from './external-tools.js';

export const MAX_PROMPT_FILE_BYTES = 32 * 1024; // 32 KiB

async function readFileWithCap(filePath, cap = MAX_PROMPT_FILE_BYTES) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;

    const handle = await open(filePath, 'r');
    try {
      const bytesToRead = Math.min(info.size, cap);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      let content = buffer.subarray(0, bytesRead).toString('utf8');
      if (info.size > cap) {
        content += `\n[${filePath.split('/').pop()} truncated at 32 KiB]`;
      }
      return content;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function getToolOutline(toolSpec, cwd, env) {
  const { command, name, brief } = toolSpec;

  const outline = await new Promise((resolveResult) => {
    let stdout = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult(result);
    };

    let timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(null);
    }, 3000);
    timer.unref?.();

    let child;
    try {
      child = spawn(command, ['--list'], {
        shell: false,
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return finish(null);
    }

    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 32 * 1024) {
        try { child.kill('SIGTERM'); } catch {}
      }
    });

    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (code === 0 && stdout.trim()) {
        const lines = stdout.trim().split('\n').filter(Boolean);
        const cappedLines = lines.slice(0, 25);
        finish(cappedLines.join('\n'));
      } else {
        finish(null);
      }
    });
  });

  if (outline) {
    return `### ${name}\n${outline}`;
  }
  if (brief) {
    return `### ${name}\n${brief}`;
  }
  return `### ${name}\nrun \`${command} --help\``;
}

export async function buildInitialSystemPrompt({
  cwd = process.cwd(),
  toolsConfig = [],
  env = process.env,
} = {}) {
  const effectiveCwd = resolve(cwd);
  const sections = [];

  // (a) Preamble (3-5 lines)
  sections.push(
    `You are running in directory: ${effectiveCwd}\n` +
    `Stateless one-shot tools are available for operations.\n` +
    `Large outputs are saved to files by the tools; read them with file tools as needed.`
  );

  // (b) Configured tools outline
  if (Array.isArray(toolsConfig) && toolsConfig.length > 0) {
    const specs = toolsConfig.map(parseToolConfigItem).filter(spec => Boolean(spec.command));
    if (specs.length > 0) {
      const outlines = await Promise.all(
        specs.map(spec => getToolOutline(spec, effectiveCwd, env))
      );

      const toolsText =
        `## Available Tools\n\n` +
        outlines.join('\n\n') +
        `\n\nRun "<tool> --help" or "<tool> <op> --help" for full details (call through the tool with args ["--help"]).`;

      sections.push(toolsText);
    }
  }

  // (c) AGENTS.md in cwd
  const agentsContent = await readFileWithCap(join(effectiveCwd, 'AGENTS.md'));
  if (agentsContent) {
    sections.push(`## Instructions (AGENTS.md)\n\n${agentsContent}`);
  }

  // (d) durable-memory/index.md in cwd
  const memoryContent = await readFileWithCap(join(effectiveCwd, 'durable-memory', 'index.md'));
  if (memoryContent) {
    sections.push(
      `## Durable Memory (durable-memory/index.md)\n\n${memoryContent}\n\n` +
      `durable-memory/ holds notes for future sessions; keep index.md as a table of contents of one-line pointers.`
    );
  }

  return sections.join('\n\n');
}
