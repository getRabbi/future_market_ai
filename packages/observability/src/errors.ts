/**
 * Typed domain error. `code` is stable and machine-readable; `httpStatus` is a hint for the API
 * layer. Messages must never include secrets or raw personal data.
 */
export class FgError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, httpStatus = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FgError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export const notFound = (what: string) => new FgError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (message: string, details?: Record<string, unknown>) => new FgError('FORBIDDEN', message, 403, details);
export const conflict = (message: string, details?: Record<string, unknown>) => new FgError('CONFLICT', message, 409, details);
export const invalid = (message: string, details?: Record<string, unknown>) => new FgError('INVALID', message, 422, details);
export const blocked = (message: string, details?: Record<string, unknown>) => new FgError('BLOCKED', message, 423, details);
