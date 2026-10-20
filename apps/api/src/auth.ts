import { betterAuthSchema, type Db } from '@futuregrow/db';
import { type Env, origins } from '@futuregrow/runtime';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { haveIBeenPwned, organization, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

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
      // Controlled beta: invite-only unless explicitly opened.
      disableSignUp: !env.FG_ALLOW_SIGNUP,
      minPasswordLength: 12,
      maxPasswordLength: 256,
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
