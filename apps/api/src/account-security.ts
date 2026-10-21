import { appendAudit, type Db, member, withSystem, withTenant } from '@futuregrow/db';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';

/**
 * Password changes (Better Auth `/change-password`) with FUTUREGROW's extra controls:
 * the current password is always required (Better Auth), every other session is revoked,
 * attempts are limited per user (an IP limit alone is bypassable with a stolen session),
 * trivially weak or unchanged passwords are refused, and each change is written to the
 * hash-chained audit log of every organization the user belongs to.
 */
export const PASSWORD_CHANGE_MAX_ATTEMPTS = 5;
export const PASSWORD_CHANGE_WINDOW_MS = 15 * 60_000;

/** Sliding-window attempt counter (in-process; the beta runs one api instance). */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt. Returns 0 when allowed, otherwise the seconds until the next slot. */
  hit(key: string): number {
    const t = this.now();
    const recent = (this.attempts.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.attempts.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
    }
    recent.push(t);
    this.attempts.set(key, recent);
    if (this.attempts.size > 10_000) {
      for (const [k, v] of this.attempts) if (v.every((x) => t - x >= this.windowMs)) this.attempts.delete(k);
    }
    return 0;
  }
}

/** Policy beyond Better Auth's length limits. Returns a user-facing reason, or null. */
export function passwordPolicyIssue(input: { newPassword: unknown; currentPassword?: unknown; email?: string | null }): string | null {
  const { newPassword, currentPassword, email } = input;
  // Non-strings are rejected by the endpoint's own body validation.
  if (typeof newPassword !== 'string') return null;
  if (typeof currentPassword === 'string' && newPassword === currentPassword) return 'The new password must be different from the current password';
  if (new Set(newPassword).size < 5) return 'The password must contain at least 5 different characters';
  const local = (email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && newPassword.toLowerCase().includes(local)) return 'The password must not contain your email address';
  return null;
}

async function auditPasswordChange(db: Db, userId: string, meta: { ipAddress: string | null; userAgent: string | null }): Promise<number> {
  const orgs = await withSystem(db, `user:${userId}`, (tx) => tx.select({ organizationId: member.organizationId }).from(member).where(eq(member.userId, userId)));
  for (const { organizationId } of orgs) {
    await withTenant(db, { tenantId: organizationId, actor: `user:${userId}` }, (tx) =>
      appendAudit(tx, {
        tenantId: organizationId,
        actorType: 'user',
        actorId: userId,
        action: 'auth.password_changed',
        subjectType: 'user',
        subjectId: userId,
        payload: { otherSessionsRevoked: true, ipAddress: meta.ipAddress, userAgent: meta.userAgent },
      }),
    );
  }
  return orgs.length;
}

export function accountSecurityHooks(db: Db, limiter = new AttemptLimiter(PASSWORD_CHANGE_MAX_ATTEMPTS, PASSWORD_CHANGE_WINDOW_MS)) {
  return {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/sign-up/email') {
        const body = (ctx.body ?? {}) as { password?: unknown; email?: unknown };
        const issue = passwordPolicyIssue({ newPassword: body.password, email: typeof body.email === 'string' ? body.email : null });
        if (issue) throw new APIError('BAD_REQUEST', { message: issue, code: 'PASSWORD_POLICY' });
        return;
      }
      if (ctx.path !== '/change-password') return;
      const session = await getSessionFromCtx(ctx);
      // No session: the endpoint itself answers 401.
      if (!session) return;
      const wait = limiter.hit(session.user.id);
      if (wait > 0) throw new APIError('TOO_MANY_REQUESTS', { message: `Too many password change attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`, code: 'PASSWORD_CHANGE_RATE_LIMITED' });
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const issue = passwordPolicyIssue({ newPassword: body.newPassword, currentPassword: body.currentPassword, email: session.user.email });
      if (issue) throw new APIError('BAD_REQUEST', { message: issue, code: 'PASSWORD_POLICY' });
      // A password change always ends every other session (stolen-session containment).
      return { context: { body: { ...body, revokeOtherSessions: true } } };
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/change-password') return;
      const created = ctx.context.newSession;
      if (!created || isAPIError(ctx.context.returned)) return;
      try {
        await auditPasswordChange(db, created.user.id, { ipAddress: created.session.ipAddress ?? null, userAgent: created.session.userAgent ?? null });
      } catch (err) {
        // The password is already changed; a failed audit write must be visible to operators.
        ctx.context.logger.error('password change audit failed', err);
      }
    }),
  };
}
