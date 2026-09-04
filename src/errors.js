export class MiniplayerError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'MiniplayerError';
    this.exitCode = exitCode;
  }
}
