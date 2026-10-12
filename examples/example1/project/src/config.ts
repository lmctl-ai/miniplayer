import * as path from 'node:path';

export function getNotesDir(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string {
  const configured = env.NOTES_DIR ?? './notes';
  return path.resolve(cwd, configured);
}
