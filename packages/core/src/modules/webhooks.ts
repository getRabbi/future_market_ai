import { connections, type Db, type Tx, webhookInbox, withSystem, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import { type CoreDeps, systemActor } from '../deps.js';
import { record } from '../util.js';

export type WebhookProvider = 'meta' | 'shopify' | 'resend' | 'tiktok';

export interface InboxInput {
  provider: WebhookProvider;
  providerEventId: string | null;
  topic: string | null;
  signatureValid: boolean;
  headers: Record<string, string>;
  rawBody: string;
  payload: unknown;
  /** Provider account id used to resolve the tenant (page id, shop domain, ...). */
  accountRef: string | null;
}

const KEEP_HEADERS = /^(x-shopify-topic|x-shopify-shop-domain|x-shopify-webhook-id|x-shopify-api-version|svix-id|svix-timestamp|content-type|user-agent)$/i;

/**
 * Store an inbound webhook exactly once (unique provider + event id). Signature-invalid deliveries
 * are recorded as `rejected_signature` for forensics but never processed.
 */
export async function ingestWebhook(db: Db, input: InboxInput): Promise<{ id: string; duplicate: boolean; tenantId: string | null }> {
  const eventId = input.providerEventId ?? `sha256:${sha256Hex(input.rawBody)}`;
  return withSystem(db, `connector:${input.provider}`, async (tx) => {
    let tenantId: string | null = null;
    let connectionId: string | null = null;
    if (input.accountRef && input.signatureValid) {
      // A disabled or revoked connection never claims a delivery, so an account moved to another
      // tenant resolves to the one connection still in use.
      const rows = await tx
        .select({ id: connections.id, tenantId: connections.tenantId })
        .from(connections)
        .where(and(eq(connections.provider, input.provider), eq(connections.externalAccountId, input.accountRef), notInArray(connections.status, ['disabled', 'revoked'])));
      if (rows.length === 1) {
        tenantId = rows[0]!.tenantId;
        connectionId = rows[0]!.id;
      }
    }
    const headers = Object.fromEntries(Object.entries(input.headers).filter(([k]) => KEEP_HEADERS.test(k)));
    const inserted = await tx
      .insert(webhookInbox)
      .values({
        provider: input.provider,
        providerEventId: eventId,
        resolvedTenantId: tenantId,
        connectionId,
        topic: input.topic,
        signatureValid: input.signatureValid,
        headers,
        payload: input.payload as never,
        payloadSha256: sha256Hex(input.rawBody),
        status: input.signatureValid ? 'received' : 'rejected_signature',
      })
      .onConflictDoNothing()
      .returning({ id: webhookInbox.id });
    if (!inserted.length) {
      const [existing] = await tx
        .select({ id: webhookInbox.id, tenantId: webhookInbox.resolvedTenantId })
        .from(webhookInbox)
        .where(and(eq(webhookInbox.provider, input.provider), eq(webhookInbox.providerEventId, eventId)));
      return { id: existing!.id, duplicate: true, tenantId: existing!.tenantId };
    }
    return { id: inserted[0]!.id, duplicate: false, tenantId };
  });
}

export interface WebhookContext {
  deps: CoreDeps;
  tenantId: string | null;
  connectionId: string | null;
  topic: string | null;
  payload: unknown;
  inboxId: string;
}

/** Module handlers. Return 'ignored' for events they do not handle. */
export type WebhookHandler = (ctx: WebhookContext) => Promise<'processed' | 'ignored'>;

const handlers = new Map<WebhookProvider, WebhookHandler[]>();

export function registerWebhookHandler(provider: WebhookProvider, h: WebhookHandler): void {
  handlers.set(provider, [...(handlers.get(provider) ?? []), h]);
}

export async function processWebhook(deps: CoreDeps, inboxId: string): Promise<string> {
  const [row] = await withSystem(deps.db, 'system:webhooks', (tx) => tx.select().from(webhookInbox).where(eq(webhookInbox.id, inboxId)).for('update'));
  if (!row || row.status !== 'received') return row?.status ?? 'missing';
  let outcome: 'processed' | 'ignored' = 'ignored';
  let error: string | null = null;
  try {
    for (const h of handlers.get(row.provider as WebhookProvider) ?? []) {
      const r = await h({ deps, tenantId: row.resolvedTenantId, connectionId: row.connectionId, topic: row.topic, payload: row.payload, inboxId: row.id });
      if (r === 'processed') outcome = 'processed';
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await withSystem(deps.db, 'system:webhooks', (tx) =>
    tx
      .update(webhookInbox)
      .set({ status: error ? 'failed' : outcome, processedAt: new Date(), error })
      .where(eq(webhookInbox.id, inboxId)),
  );
  if (row.resolvedTenantId && !error) {
    await withTenant(deps.db, { tenantId: row.resolvedTenantId, actor: 'connector:webhook' }, (tx: Tx) => record(tx, row.resolvedTenantId!, systemActor('webhooks'), 'connector.webhook.received', { type: 'webhook', id: row.id }, { provider: row.provider, topic: row.topic, outcome }));
  }
  if (error) throw new Error(`webhook ${inboxId} failed: ${error}`);
  return outcome;
}

/** Sweep for deliveries whose processing job was lost (e.g. enqueue failed after insert). */
export async function pendingWebhooks(db: Db, olderThanMs = 60_000): Promise<string[]> {
  const rows = await withSystem(db, 'system:webhooks', (tx) =>
    tx
      .select({ id: webhookInbox.id })
      .from(webhookInbox)
      .where(and(eq(webhookInbox.status, 'received'), lt(webhookInbox.receivedAt, new Date(Date.now() - olderThanMs))))
      .orderBy(webhookInbox.receivedAt)
      .limit(500),
  );
  return rows.map((r) => r.id);
}

export async function webhookRetentionSweep(db: Db, retainDays: number): Promise<number> {
  const res = await withSystem(db, 'system:webhooks', (tx) => tx.execute(sql`delete from webhook_inbox where received_at < now() - (${retainDays} || ' days')::interval and status in ('processed','ignored','rejected_signature') returning id`));
  return res.rows.length;
}
