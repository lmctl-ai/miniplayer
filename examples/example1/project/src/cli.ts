import { parseArgs } from './args';
import { runCommand } from './commands';
import { getNotesDir } from './config';
import { AppError } from './errors';
import { readStdin } from './io';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const command = parseArgs(argv);
    const notesDir = getNotesDir();

    await runCommand(command, {
      notesDir,
      stdout: process.stdout,
      readStdin,
    });

    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }

    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
