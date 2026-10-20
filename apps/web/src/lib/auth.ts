import { createAuthClient } from 'better-auth/client';
import { organizationClient, twoFactorClient } from 'better-auth/client/plugins';
import { API_BASE } from './api.js';

/**
 * Better Auth client (invite-only sign-up; TOTP second factor). When a user has 2FA enabled the
 * sign-in response asks for the second factor instead of issuing a session.
 */
export const authClient = createAuthClient({
  baseURL: API_BASE || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4321'),
  basePath: '/api/auth',
  fetchOptions: { credentials: 'include' },
  plugins: [organizationClient(), twoFactorClient()],
});

export type AuthClient = typeof authClient;
