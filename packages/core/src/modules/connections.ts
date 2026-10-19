import { desc, eq } from 'drizzle-orm';
import { PROVIDERS } from '@futuregrow/contracts';
import { type ProviderCredentials, READ_CONNECTORS } from '@futuregrow/connectors';
import { type Tx, connections, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../deps.js';
import { loadCredentials, storeCredentials } from '../secrets.js';
import { ADMIN_ROLES, audit, record, requireMfa, requireRole } from '../util.js';
import { connectorContext } from './m23-execution/gateway.js';

export const ConnectionInputSchema = z.object({
  provider: z.enum(PROVIDERS).exclude(['internal']),
  externalAccountId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  grantedScopes: z.array(z.string()).default([]),
  accessLevel: z.string().nullable().default(null),
  appAudited: z.boolean().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), z.unknown()),
  credentialsExpireAt: z.string().datetime({ offset: true }).nullable().default(null),
});

/** Public view of a connection. Credentials are never returned. */
export function connectionView(c: typeof connections.$inferSelect) {
  return {
    id: c.id,
    provider: c.provider,
    externalAccountId: c.externalAccountId,
    displayName: c.displayName,
    status: c.status,
    grantedScopes: c.grantedScopes,
    accessLevel: c.accessLevel,
    appAudited: c.appAudited,
    healthStatus: c.healthStatus,
    lastHealthCheckAt: c.lastHealthCheckAt?.toISOString() ?? null,
    metadata: c.metadata,
    createdAt: c.createdAt.toISOString(),
  };
}

export async function createConnection(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'connecting an external account');
  requireMfa(actor, 'connecting an external account');
  const input = ConnectionInputSchema.parse(raw);
  const creds = { ...input.credentials, provider: input.provider } as ProviderCredentials;
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [row] = await tx
      .insert(connections)
      .values({
        tenantId,
        provider: input.provider,
        externalAccountId: input.externalAccountId,
        displayName: input.displayName,
        grantedScopes: input.grantedScopes,
        accessLevel: input.accessLevel,
        appAudited: input.appAudited,
        apiVersion: null,
        metadata: input.metadata,
        createdBy: actorRef(actor),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('this external account is already connected');
    await storeCredentials(tx, deps.config, tenantId, row.id, creds, input.credentialsExpireAt ? new Date(input.credentialsExpireAt) : null);
    await audit(tx, tenantId, actor, 'connector.connection.created', { type: 'connection', id: row.id }, { provider: input.provider, externalAccountId: input.externalAccountId, scopes: input.grantedScopes });
    return connectionView(row);
  });
}

export async function rotateConnectionCredentials(deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: { credentials: Record<string, unknown>; credentialsExpireAt?: string | null }) {
  requireRole(actor, ADMIN_ROLES, 'rotating connection credentials');
  requireMfa(actor, 'rotating connection credentials');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.id, id));
    if (!c) throw notFound('connection');
    await storeCredentials(tx, deps.config, tenantId, c.id, { ...raw.credentials, provider: c.provider } as ProviderCredentials, raw.credentialsExpireAt ? new Date(raw.credentialsExpireAt) : null);
    const [u] = await tx.update(connections).set({ status: 'active', updatedAt: new Date() }).where(eq(connections.id, id)).returning();
    await audit(tx, tenantId, actor, 'connector.connection.credentials_rotated', { type: 'connection', id }, {});
    return connectionView(u!);
  });
}

export async function setConnectionStatus(tx: Tx, tenantId: string, actor: Actor, id: string, status: 'active' | 'disabled' | 'read_only' | 'revoked') {
  requireRole(actor, ADMIN_ROLES, 'changing connection status');
  const [u] = await tx.update(connections).set({ status, updatedAt: new Date() }).where(eq(connections.id, id)).returning();
  if (!u) throw notFound('connection');
  await audit(tx, tenantId, actor, 'connector.connection.status_changed', { type: 'connection', id }, { status });
  return connectionView(u);
}

export async function listConnections(tx: Tx) {
  const rows = await tx.select().from(connections).orderBy(desc(connections.createdAt));
  return rows.map(connectionView);
}

/**
 * Health check (M24 connector monitoring). A failing connection degrades to reauth_required so
 * that queued actions are preserved rather than attempted (product plan failure modes).
 */
export async function checkConnectionHealth(deps: CoreDeps, tenantId: string, id: string) {
  const actor = systemActor('connector-health');
  const prep = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.id, id));
    if (!c) throw notFound('connection');
    const loaded = await loadCredentials(tx, deps.config, tenantId, c.id);
    return { c, loaded };
  });
  const reader = READ_CONNECTORS[prep.c.provider as keyof typeof READ_CONNECTORS];
  if (!reader) throw invalid(`no health check for ${prep.c.provider}`);
  const result = prep.loaded
    ? await reader.healthCheck(connectorContext(deps, tenantId, prep.loaded.creds, prep.c))
    : { healthy: false, status: 'failing' as const, grantedScopes: null, details: { error: 'credentials missing' } };
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const nextStatus = result.status === 'failing' && prep.c.status === 'active' ? 'reauth_required' : prep.c.status;
    const [u] = await tx
      .update(connections)
      .set({
        healthStatus: result.status,
        lastHealthCheckAt: deps.clock.now(),
        status: nextStatus,
        ...(result.grantedScopes ? { grantedScopes: result.grantedScopes } : {}),
        updatedAt: deps.clock.now(),
      })
      .where(eq(connections.id, id))
      .returning();
    if (u!.healthStatus !== prep.c.healthStatus || nextStatus !== prep.c.status) {
      await record(tx, tenantId, actor, 'connector.health.changed', { type: 'connection', id }, { from: prep.c.healthStatus, to: result.status, status: nextStatus, details: result.details });
    }
    return { connection: connectionView(u!), result };
  });
}
