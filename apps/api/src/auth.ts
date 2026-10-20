import { betterAuthSchema, type Db, invitation } from '@futuregrow/db';
import { type Env, origins } from '@futuregrow/runtime';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { haveIBeenPwned, organization, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import { and, eq, gt, sql } from 'drizzle-orm';

/**
 * Better Auth: email/password + TOTP two-factor + organizations (= tenants, D-008).
 * FUTUREGROW business permissions are enforced by the core (role checks + policy engine);
 * the access-control statements below only govern organization administration.
 */
const ac = createAccessControl({ ...defaultStatements });

const orgAdmin = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});
const orgOwner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});
const plain = ac.newRole({ organization: [], member: [], invitation: [] });

export const ORG_ROLES = {
  owner: orgOwner,
  admin: orgAdmin,
  growth_operator: plain,
  approver: plain,
  finance_approver: plain,
  legal_approver: plain,
  privacy_officer: plain,
  analyst: plain,
  viewer: plain,
};

export function createAuth(db: Db, env: Env) {
  const production = env.NODE_ENV === 'production';
  return betterAuth({
    appName: 'FUTUREGROW',
    baseURL: env.API_BASE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET!,
    trustedOrigins: origins(env),
    database: drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema }),
    emailAndPassword: {
      enabled: true,
      // Controlled beta: accounts are created only for invited addresses (see databaseHooks)
      // unless sign-up is explicitly opened with FG_ALLOW_SIGNUP.
      minPasswordLength: 12,
      maxPasswordLength: 256,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (env.FG_ALLOW_SIGNUP) return;
            const pending = await db
              .select({ id: invitation.id })
              .from(invitation)
              .where(and(sql`lower(${invitation.email}) = lower(${user.email})`, eq(invitation.status, 'pending'), gt(invitation.expiresAt, new Date())))
              .limit(1);
            if (pending.length === 0) throw new APIError('FORBIDDEN', { message: 'Sign-up is by invitation only' });
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 15,
    },
    advanced: {
      cookiePrefix: 'fg',
      useSecureCookies: production,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure: production },
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    plugins: [
      organization({
        ac,
        roles: ORG_ROLES,
        creatorRole: 'owner',
        allowUserToCreateOrganization: true,
        invitationExpiresIn: 60 * 60 * 72,
      }),
      twoFactor({ issuer: 'FUTUREGROW' }),
      ...(env.FG_CHECK_BREACHED_PASSWORDS && production ? [haveIBeenPwned()] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
