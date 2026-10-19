/**
 * PostgreSQL error normalisation. Drizzle wraps driver errors ("Failed query: ...") and keeps the
 * DatabaseError in `cause`; callers need the SQLSTATE, constraint and server message.
 */
export class DbError extends Error {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly detail: string | undefined;

  constructor(message: string, code: string, constraint?: string, detail?: string, cause?: unknown) {
    super(constraint ? `${message} [constraint ${constraint}]` : message, { cause });
    this.name = 'DbError';
    this.code = code;
    this.constraint = constraint;
    this.detail = detail;
  }

  get isUniqueViolation() {
    return this.code === '23505';
  }
  get isCheckViolation() {
    return this.code === '23514';
  }
  get isRlsViolation() {
    return this.code === '42501' && /row-level security/.test(this.message);
  }
  get isPermissionDenied() {
    return this.code === '42501';
  }
}

interface PgLike {
  code: string;
  message: string;
  constraint?: string;
  detail?: string;
  severity?: string;
}

function isPgLike(e: unknown): e is PgLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as PgLike).code === 'string' &&
    /^[0-9A-Z]{5}$/.test((e as PgLike).code) &&
    typeof (e as PgLike).message === 'string'
  );
}

export function findPgError(err: unknown): PgLike | null {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    if (isPgLike(cur)) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function normalizeDbError(err: unknown): unknown {
  if (err instanceof DbError) return err;
  const pgErr = findPgError(err);
  if (!pgErr) return err;
  return new DbError(pgErr.message, pgErr.code, pgErr.constraint, pgErr.detail, err);
}
