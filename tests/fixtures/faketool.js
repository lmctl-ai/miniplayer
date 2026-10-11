#!/usr/bin/env node

import { readFileSync, writeSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--list')) {
  process.stdout.write('faketool echo [args...]  Echo input arguments and optional stdin\n');
  process.stdout.write('faketool fail [args...]  Exit with code 1 and error message on stderr\n');
  process.stdout.write('faketool big             Produce large output to test truncation\n');
  process.exit(0);
}

if (args.includes('--help') || args.length === 0) {
  process.stdout.write('Usage: faketool <op> [args...]\n\nOps:\n  echo   Echo arguments and stdin\n  fail   Exit with code 1\n  big    Generate large output\n');
  process.exit(0);
}

const op = args[0];
const opArgs = args.slice(1);

if (op === 'echo') {
  let stdin = '';
  try {
    stdin = readFileSync(0, 'utf8');
  } catch {
    // stdin not available or empty
  }
  const parts = [];
  if (opArgs.length > 0) parts.push(opArgs.join(' '));
  if (stdin.length > 0) parts.push(`stdin:${stdin}`);
  process.stdout.write(parts.join('\n') + '\n');
  process.exit(0);
}

if (op === 'fail') {
  process.stderr.write(`error: ${opArgs.join(' ') || 'simulated tool failure'}\n`);
  process.exit(1);
}

if (op === 'big') {
  const fd = opArgs[0] === 'stderr' ? 2 : 1;
  const count = Number(opArgs[1]) || (300 * 1024);
  const buf = Buffer.alloc(16 * 1024, 'X');
  let written = 0;
  while (written < count) {
    const toWrite = Math.min(buf.length, count - written);
    writeSync(fd, buf.subarray(0, toWrite));
    written += toWrite;
  }
  process.exit(0);
}

if (op === 'sleep') {
  const ms = Number(opArgs[0]) || 5000;
  setTimeout(() => process.exit(0), ms);
} else {
  process.stderr.write(`unknown op: ${op}\n`);
  process.exit(1);
}
