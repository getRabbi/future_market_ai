import { type ProviderCredentials, READ_CONNECTORS } from '@futuregrow/connectors';
import { PROVIDERS } from '@futuregrow/contracts';
import { connections, type Tx, withTenant } from '@futuregrow/db';
import { conflict, invalid, notFound } from '@futuregrow/observability';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../deps.js';
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

/** `metadata` (e.g. a Meta ad account ID added with an ads token) is merged into the stored metadata. */
export async function rotateConnectionCredentials(deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: { credentials: Record<string, unknown>; credentialsExpireAt?: string | null; metadata?: Record<string, unknown> }) {
  requireRole(actor, ADMIN_ROLES, 'rotating connection credentials');
  requireMfa(actor, 'rotating connection credentials');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.id, id));
    if (!c) throw notFound('connection');
    await storeCredentials(tx, deps.config, tenantId, c.id, { ...raw.credentials, provider: c.provider } as ProviderCredentials, raw.credentialsExpireAt ? new Date(raw.credentialsExpireAt) : null);
    const metadata = raw.metadata ? { ...c.metadata, ...raw.metadata } : c.metadata;
    const [u] = await tx.update(connections).set({ status: 'active', metadata, updatedAt: new Date() }).where(eq(connections.id, id)).returning();
    await audit(tx, tenantId, actor, 'connector.connection.credentials_rotated', { type: 'connection', id }, raw.metadata ? { metadataKeys: Object.keys(raw.metadata) } : {});
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
 * Connector context for read paths (campaign sync, spend reports, Search Console, ASC reports).
 * Writes never use this: they go through the M23 gateway.
 */
export async function readContext(deps: CoreDeps, tenantId: string, connectionId: string, expectProvider?: string) {
  return withTenant(deps.db, { tenantId, actor: 'system:connector-read' }, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.id, connectionId));
    if (!c) throw notFound('connection');
    if (expectProvider && c.provider !== expectProvider) throw invalid(`connection is ${c.provider}, expected ${expectProvider}`);
    if (c.status === 'revoked' || c.status === 'disabled') throw invalid(`connection is ${c.status}`);
    const loaded = await loadCredentials(tx, deps.config, tenantId, c.id);
    if (!loaded) throw invalid('connection credentials missing');
    return { connection: c, ctx: connectorContext(deps, tenantId, loaded.creds, c) };
  });
}

export const ConnectionTestSchema = ConnectionInputSchema.pick({ provider: true, externalAccountId: true, metadata: true, credentials: true });

/** Providers whose credentials can be verified with a read-only call (READ_CONNECTORS). */
export const TESTABLE_PROVIDERS = Object.keys(READ_CONNECTORS) as (keyof typeof READ_CONNECTORS)[];

/**
 * Checks credentials against the provider with the same read-only call as the health check,
 * before anything is stored, so a typo never becomes a broken connection. Nothing is persisted
 * except an audit entry without secrets.
 */
export async function testConnectionCredentials(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ADMIN_ROLES, 'testing connection credentials');
  const input = ConnectionTestSchema.parse(raw);
  const reader = READ_CONNECTORS[input.provider as keyof typeof READ_CONNECTORS];
  if (!reader) throw invalid(`no connection test for ${input.provider}`);
  const creds = { ...input.credentials, provider: input.provider } as ProviderCredentials;
  const probe = { id: 'connection-test', provider: input.provider, externalAccountId: input.externalAccountId, metadata: input.metadata, appAudited: null } as typeof connections.$inferSelect;
  const result = await reader.healthCheck(connectorContext(deps, tenantId, creds, probe)).catch((err: unknown) => ({ healthy: false, status: 'failing' as const, grantedScopes: null, details: { error: err instanceof Error ? err.message : String(err) } }));
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => audit(tx, tenantId, actor, 'connector.connection.tested', { type: 'connection', id: `${input.provider}:${input.externalAccountId}` }, { provider: input.provider, externalAccountId: input.externalAccountId, status: result.status }));
  return result;
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
  const result = prep.loaded ? await reader.healthCheck(connectorContext(deps, tenantId, prep.loaded.creds, prep.c)) : { healthy: false, status: 'failing' as const, grantedScopes: null, details: { error: 'credentials missing' } };
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
