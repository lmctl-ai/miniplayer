import { execute } from './cli.js';

export async function main(args, io = process, dependencies = {}) {
  try {
    return await execute(args, io, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`error: ${message}\n`);
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}
