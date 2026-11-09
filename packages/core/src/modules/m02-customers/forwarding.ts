import { posthogCaptureBatch } from '@futuregrow/connectors';
import { connections, consentState, customerEvents, type DbOrTx, eventForwarding, type Tx, withTenant } from '@futuregrow/db';
import { hmacSha256Hex, invalid, notFound } from '@futuregrow/observability';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { stableUuid } from '../m20-lifecycle/index.js';

/**
 * Optional PostHog forwarding (P2-11). FUTUREGROW's own PostgreSQL event store stays the source of
 * truth; forwarding is off until an admin turns it on. Only events of profiles with current
 * `analytics` consent are sent (anonymous events have no consent record and stay local), the
 * distinct id is a keyed hash of the profile (no email, phone or name leaves FUTUREGROW), PII-like
 * properties are dropped, and every event carries a deterministic uuid so a resent batch cannot
 * create duplicates. The cursor advances only after PostHog accepted the batch.
 */

const BATCH = 100;
const PII_KEY = /(e-?mail|phone|mobile|name|address|street|zip|postcode|ip(_?addr)?|ssn|passport|token|password|secret|card|iban|birth|dob|lat(itude)?|lon(gitude)?)/i;

/** Event properties safe to forward: scalars only, no PII-like keys, strings clipped. */
export function forwardableProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (PII_KEY.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = clipText(v, 200);
  }
  return out;
}

export const distinctIdFor = (pepper: string, tenantId: string, profileId: string) => `fg_${hmacSha256Hex(pepper, `posthog:${tenantId}:${profileId}`).slice(0, 32)}`;

export async function setForwarding(t: Tx, tenantId: string, actor: Actor, connectionId: string, enabled: boolean) {
  requireRole(actor, ['owner', 'admin'], 'changing event forwarding');
  const [c] = await t.select().from(connections).where(eq(connections.id, connectionId));
  if (!c || c.provider !== 'posthog') throw invalid('choose a connected PostHog project');
  const [row] = await t
    .insert(eventForwarding)
    .values({ tenantId, destination: 'posthog', connectionId, enabled, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: [eventForwarding.tenantId, eventForwarding.destination, eventForwarding.connectionId], set: { enabled, updatedBy: actorRef(actor), updatedAt: new Date() } })
    .returning();
  await audit(t, tenantId, actor, enabled ? 'customers.forwarding.enabled' : 'customers.forwarding.disabled', { type: 'connection', id: connectionId }, { destination: 'posthog' });
  return row!;
}

export async function forwardingStatus(t: DbOrTx) {
  return t.select().from(eventForwarding);
}

export interface ForwardResult {
  connectionId: string;
  status: 'disabled' | 'idle' | 'forwarded' | 'failed';
  forwarded: number;
  skippedNoConsent: number;
  error: string | null;
}

/** Forwards up to `batches` × 100 new events for one enabled PostHog connection. */
export async function forwardEvents(deps: CoreDeps, tenantId: string, connectionId: string, opts: { batches?: number } = {}): Promise<ForwardResult> {
  const tctx = { tenantId, actor: 'system:event-forwarding' };
  let forwarded = 0;
  let skipped = 0;
  for (let b = 0; b < (opts.batches ?? 5); b++) {
    const prep = await withTenant(deps.db, tctx, async (t) => {
      const [state] = await t
        .select()
        .from(eventForwarding)
        .where(and(eq(eventForwarding.destination, 'posthog'), eq(eventForwarding.connectionId, connectionId)));
      if (!state) throw notFound('forwarding settings');
      if (!state.enabled) return { state, events: [] as (typeof customerEvents.$inferSelect)[], consented: new Set<string>() };
      // Compare against the cursor event's own stored timestamp (microseconds in PostgreSQL, milliseconds in JS);
      // if that event was deleted (retention, DSAR), fall back to the stored time (a resend is deduplicated by uuid).
      const after = state.cursorEventId ? sql`(${customerEvents.receivedAt}, ${customerEvents.id}) > (coalesce((select received_at from customer_events where id = ${state.cursorEventId}), ${state.cursorReceivedAt}::timestamptz), ${state.cursorEventId}::uuid)` : undefined;
      const events = await t.select().from(customerEvents).where(after).orderBy(asc(customerEvents.receivedAt), asc(customerEvents.id)).limit(BATCH);
      const profiles = [...new Set(events.map((e) => e.profileId).filter((x): x is string => Boolean(x)))];
      const now = deps.clock.now();
      const granted = profiles.length
        ? await t
            .select({ profileId: consentState.profileId, expiresAt: consentState.expiresAt })
            .from(consentState)
            .where(and(inArray(consentState.profileId, profiles), eq(consentState.purpose, 'analytics'), eq(consentState.status, 'granted')))
        : [];
      return { state, events, consented: new Set(granted.filter((g) => !g.expiresAt || g.expiresAt > now).map((g) => g.profileId)) };
    });
    if (!prep.state.enabled) return { connectionId, status: 'disabled', forwarded, skippedNoConsent: skipped, error: null };
    if (!prep.events.length) break;
    const sendable = prep.events.filter((e) => e.profileId && prep.consented.has(e.profileId));
    const last = prep.events.at(-1)!;
    try {
      if (sendable.length) {
        const { ctx } = await readContext(deps, tenantId, connectionId, 'posthog');
        await posthogCaptureBatch(
          ctx,
          sendable.map((e) => ({
            event: e.eventName,
            distinctId: distinctIdFor(deps.config.identifierPepper, tenantId, e.profileId!),
            timestamp: e.occurredAt.toISOString(),
            uuid: stableUuid(`posthog:${tenantId}:${e.messageId}`),
            properties: { ...forwardableProperties(e.properties), $lib: 'futuregrow-server', source: e.source, ...(e.revenueMicros !== null ? { revenue: e.revenueMicros / 1e6, currency: e.currency } : {}) },
          })),
        );
      }
    } catch (err) {
      const error = clipText(err instanceof Error ? err.message : String(err), 500);
      await withTenant(deps.db, tctx, (t) => t.update(eventForwarding).set({ lastRunAt: deps.clock.now(), lastStatus: 'failed', lastError: error }).where(eq(eventForwarding.id, prep.state.id)));
      return { connectionId, status: 'failed', forwarded, skippedNoConsent: skipped, error };
    }
    forwarded += sendable.length;
    skipped += prep.events.length - sendable.length;
    await withTenant(deps.db, tctx, (t) =>
      t
        .update(eventForwarding)
        .set({ cursorReceivedAt: last.receivedAt, cursorEventId: last.id, forwarded: prep.state.forwarded + sendable.length, skippedNoConsent: prep.state.skippedNoConsent + (prep.events.length - sendable.length), lastRunAt: deps.clock.now(), lastStatus: 'ok', lastError: null })
        .where(eq(eventForwarding.id, prep.state.id)),
    );
    if (prep.events.length < BATCH) break;
  }
  return { connectionId, status: forwarded || skipped ? 'forwarded' : 'idle', forwarded, skippedNoConsent: skipped, error: null };
}
