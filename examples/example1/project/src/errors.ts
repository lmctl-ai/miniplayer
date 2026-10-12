export class AppError extends Error {
  public readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'AppError';
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export class UsageError extends AppError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
    Object.setPrototypeOf(this, UsageError.prototype);
  }
}

export class DomainError extends AppError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'DomainError';
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}
