#!/usr/bin/env node
/**
 * Entry point.
 *
 * Parses `process.argv`, resolves the notes directory from `NOTES_DIR`
 * (default `./notes`), supplies the stdin reader, dispatches to a command and
 * turns any `AppError` into a single stderr line plus a non-zero exit code.
 */
import process from 'node:process';

import { commands, type CommandIO } from './commands.js';
import { AppError, USAGE, toAppError } from './errors.js';
import { assertUsableDir } from './notes.js';

/** Used when `NOTES_DIR` is not set. */
export const DEFAULT_NOTES_DIR = './notes';

/** Reads `NOTES_DIR`, falling back to `./notes`. */
export function resolveNotesDir(env: NodeJS.ProcessEnv): string {
  const configured = env.NOTES_DIR;
  if (configured === undefined) {
    return DEFAULT_NOTES_DIR;
  }
  if (configured.trim() === '') {
    throw new AppError('NOTES_DIR is empty', USAGE);
  }
  return configured;
}

/** Reads stdin to EOF; an interactive TTY counts as "no input". */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined) {
    throw new AppError('missing command', USAGE);
  }
  const handler = commands.get(command);
  if (handler === undefined) {
    throw new AppError(`unknown command: ${command}`, USAGE);
  }

  const notesDir = resolveNotesDir(process.env);
  await assertUsableDir(notesDir);

  const io: CommandIO = {
    notesDir,
    readStdin,
    write: (data: string | Uint8Array): void => {
      process.stdout.write(data);
    },
  };

  await handler(io, args);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const appError = toAppError(error);
  const message = appError.message.replace(/[\r\n]+/g, ' ');
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = appError.exitCode;
});
