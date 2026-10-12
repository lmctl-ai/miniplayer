/**
 * Error plumbing for the whole CLI.
 *
 * Every failure path funnels through `AppError`; only `cli.ts` translates it
 * into a stderr line plus `process.exitCode`.
 */

/** Wrong usage: bad arguments, unknown commands, an unusable NOTES_DIR. */
export const USAGE = 2;

/** Runtime failures: missing notes, filesystem errors, ... */
export const FAILURE = 1;

export class AppError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = FAILURE) {
    super(message);
    this.name = 'AppError';
    this.exitCode = exitCode;
  }
}

/** Normalises anything thrown into an `AppError` (defaulting to exit code 1). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError(error.message, FAILURE);
  }
  return new AppError(String(error), FAILURE);
}
