import { UsageError } from './errors';

export type ParsedCommand =
  | { command: 'create'; name: string; text?: string }
  | { command: 'overwrite'; name: string; text?: string }
  | { command: 'show'; name: string }
  | { command: 'delete'; name: string }
  | { command: 'list' };

export function parseArgs(argv: string[]): ParsedCommand {
  const [command, name, text, ...rest] = argv;

  if (command === undefined) {
    throw new UsageError('Missing command');
  }

  switch (command) {
    case 'create':
      if (name === undefined) {
        throw new UsageError('Missing name for create');
      }
      if (rest.length > 0) {
        throw new UsageError('Too many arguments for create');
      }
      return { command: 'create', name, text };

    case 'overwrite':
      if (name === undefined) {
        throw new UsageError('Missing name for overwrite');
      }
      if (rest.length > 0) {
        throw new UsageError('Too many arguments for overwrite');
      }
      return { command: 'overwrite', name, text };

    case 'show':
      if (name === undefined) {
        throw new UsageError('Missing name for show');
      }
      if (text !== undefined || rest.length > 0) {
        throw new UsageError('Too many arguments for show');
      }
      return { command: 'show', name };

    case 'delete':
      if (name === undefined) {
        throw new UsageError('Missing name for delete');
      }
      if (text !== undefined || rest.length > 0) {
        throw new UsageError('Too many arguments for delete');
      }
      return { command: 'delete', name };

    case 'list':
      if (name !== undefined || text !== undefined || rest.length > 0) {
        throw new UsageError('Too many arguments for list');
      }
      return { command: 'list' };

    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
}
