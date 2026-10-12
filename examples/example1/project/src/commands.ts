import type { ParsedCommand } from './args';
import { readStdin } from './io';
import {
  createNote,
  deleteNote,
  listNotes,
  overwriteNote,
  showNote,
} from './notes';

export interface CommandDependencies {
  notesDir: string;
  stdout: { write(chunk: string): unknown };
  readStdin?: () => Promise<string>;
}

export async function runCommand(
  command: ParsedCommand,
  dependencies: CommandDependencies
): Promise<void> {
  const { notesDir, stdout } = dependencies;
  const read = dependencies.readStdin ?? readStdin;

  switch (command.command) {
    case 'create': {
      const text = command.text ?? (await read());
      createNote(notesDir, command.name, text);
      return;
    }

    case 'overwrite': {
      const text = command.text ?? (await read());
      overwriteNote(notesDir, command.name, text);
      return;
    }

    case 'show': {
      const content = showNote(notesDir, command.name);
      stdout.write(content);
      return;
    }

    case 'delete': {
      deleteNote(notesDir, command.name);
      return;
    }

    case 'list': {
      const names = listNotes(notesDir);
      if (names.length > 0) {
        stdout.write(`${names.join('\n')}\n`);
      }
      return;
    }
  }
}
