// Errors with a stable, language-independent code. The message stays the user-facing
// text; code lets callers and tests branch on the failure without matching wording.
// Codes are `<domain>.<reason>` in snake_case, e.g. `bot.not_found`.
export class AppError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
// Keep the plain `Error` name: Electron serializes IPC errors as "Error: <message>" and the
// renderer strips exactly that prefix.
Object.defineProperty(AppError.prototype, 'name', { value: 'Error', writable: true, configurable: true });

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}
