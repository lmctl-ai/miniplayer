/**
 * Command implementations.
 *
 * One function per command: it maps positional arguments (and optionally
 * stdin) onto the filesystem layer in `notes.ts`, decides what reaches stdout
 * and turns missing-input cases into `AppError`s.
 */
import { AppError, USAGE } from './errors.js';
import {
  createNote,
  deleteNote,
  listNotes,
  overwriteNote,
  readNote,
  validateName,
} from './notes.js';

/** Everything a command needs from its environment. */
export interface CommandIO {
  /** Directory holding the notes (absolute or relative to the process cwd). */
  notesDir: string;
  /** Resolves with everything read from stdin, decoded as UTF-8. */
  readStdin: () => Promise<string>;
  /** Writes to stdout, verbatim. */
  write: (data: string | Uint8Array) => void;
}

export type Command = (io: CommandIO, args: string[]) => Promise<void>;

function checkArity(usage: string, args: string[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    throw new AppError(`usage: ${usage}`, USAGE);
  }
}

/** The `[text]` argument, or stdin when it was left out. */
async function noteText(io: CommandIO, args: string[], index: number): Promise<string> {
  if (args.length > index) {
    return args[index];
  }
  return io.readStdin();
}

export const create: Command = async (io, args) => {
  checkArity('create <name> [text]', args, 1, 2);
  const name = args[0];
  validateName(name);
  const text = await noteText(io, args, 1);
  await createNote(io.notesDir, name, text);
};

export const list: Command = async (io, args) => {
  checkArity('list', args, 0, 0);
  const names = await listNotes(io.notesDir);
  if (names.length > 0) {
    io.write(`${names.join('\n')}\n`);
  }
};

export const show: Command = async (io, args) => {
  checkArity('show <name>', args, 1, 1);
  const name = args[0];
  validateName(name);
  io.write(await readNote(io.notesDir, name));
};

export const overwrite: Command = async (io, args) => {
  checkArity('overwrite <name> [text]', args, 1, 2);
  const name = args[0];
  validateName(name);
  const text = await noteText(io, args, 1);
  await overwriteNote(io.notesDir, name, text);
};

export const deleteCommand: Command = async (io, args) => {
  checkArity('delete <name>', args, 1, 1);
  const name = args[0];
  validateName(name);
  await deleteNote(io.notesDir, name);
};

/** Command word -> implementation. */
export const commands = new Map<string, Command>([
  ['create', create],
  ['list', list],
  ['show', show],
  ['overwrite', overwrite],
  ['delete', deleteCommand],
]);
