import { betterAuthSchema, type Db, invitation } from '@futuregrow/db';
import { type Env, origins } from '@futuregrow/runtime';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { haveIBeenPwned, organization, twoFactor } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import { and, eq, gt, sql } from 'drizzle-orm';
import { accountSecurityHooks } from './account-security.js';

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

/**
 * Proxies Better Auth skips, from the right of x-forwarded-for, to find the client address for
 * its rate limits and session records: the Northflank ingress (private ranges) and Cloudflare,
 * where the Pages proxy runs (https://www.cloudflare.com/ips/, checked 2026-10-27). The ingress
 * appends the real peer, so a caller hitting the API origin directly cannot pick its address.
 * Without this, Better Auth sees two addresses per request and puts every client in one bucket.
 */
export const TRUSTED_PROXIES = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '::1/128',
  'fc00::/7',
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

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
    // Password policy, per-user change limits, forced session revocation and audit (account-security.ts).
    hooks: accountSecurityHooks(db),
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
      ipAddress: { trustedProxies: TRUSTED_PROXIES },
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
