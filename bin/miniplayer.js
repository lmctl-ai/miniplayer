#!/usr/bin/env node

import { once } from 'node:events';

import { main } from '../src/index.js';

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') {
    if (process.argv[2] === 'acp') process.emit('SIGTERM');
    else process.exit(0);
    return;
  }
  throw error;
});

const exitCode = await main(process.argv.slice(2));
await Promise.all([process.stdout, process.stderr].map(async (stream) => {
  if (stream.writableNeedDrain) await once(stream, 'drain');
}));
process.exit(exitCode);
