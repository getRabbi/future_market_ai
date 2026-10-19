import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { customerEvents, customerProfiles, withTenant } from '@futuregrow/db';
import { identifierHash } from '@futuregrow/observability';
import * as audiences from '../src/modules/m11-audiences/index.js';
import * as customers from '../src/modules/m02-customers/index.js';

let h: CoreHarness;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('M11 segments', () => {
  it('blocks sensitive or proxy attributes', async () => {
    const seg = await tx((t) =>
      audiences.defineSegment(t, h.tenantId, h.users.operator, { name: 'by age', purpose: 'marketing_email', definition: { all: [{ trait: 'age_band', op: 'eq', value: '25-34' }] } }),
    );
    expect(seg.status).toBe('blocked');
    expect(seg.usesSensitiveAttributes).toBe(true);
    await expect(tx((t) => audiences.computeSnapshot(t, h.tenantId, seg.id, (e) => e))).rejects.toThrow(/blocked/);
  });

  it('materialises only consented, unsuppressed, adult, live profiles', async () => {
    const mk = async (email: string, opts: { consent?: boolean; child?: boolean; purchases?: number }) =>
      tx(async (t) => {
        const [p] = await t.insert(customerProfiles).values({ tenantId: h.tenantId, email, country: 'US', isChild: opts.child ?? false }).returning();
        for (let i = 0; i < (opts.purchases ?? 0); i++) {
          await t.insert(customerEvents).values({ tenantId: h.tenantId, messageId: `m-${randomUUID()}`, profileId: p!.id, eventName: 'purchase', occurredAt: new Date(), source: 'test' });
        }
        if (opts.consent) {
          await customers.recordConsent(t, h.tenantId, h.users.owner, { profileId: p!.id, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'form', capturedAt: new Date().toISOString() });
        }
        return p!.id;
      });
    const ok = await mk('ok@example.com', { consent: true, purchases: 2 });
    await mk('noconsent@example.com', { consent: false, purchases: 2 });
    await mk('child@example.com', { consent: true, child: true, purchases: 2 });
    const suppressed = await mk('sup@example.com', { consent: true, purchases: 2 });
    await mk('inactive@example.com', { consent: true, purchases: 0 });
    await tx((t) => customers.addSuppression(t, h.deps, h.tenantId, h.users.owner, { channel: 'email', identifier: { kind: 'email', value: 'sup@example.com' }, reason: 'complaint', source: 'resend' }));

    const seg = await tx((t) =>
      audiences.defineSegment(t, h.tenantId, h.users.operator, {
        name: 'repeat buyers US',
        purpose: 'marketing_email',
        definition: { all: [{ field: 'country', op: 'eq', value: 'US' }, { event: 'purchase', windowDays: 30, op: 'gte', count: 2 }] },
      }),
    );
    const snap = await tx((t) => audiences.computeSnapshot(t, h.tenantId, seg.id, (e) => identifierHash(h.deps.config.identifierPepper, 'email', e)));
    const members = await tx((t) => audiences.snapshotMembers(t, snap.id));
    expect(members.map((m) => m.profileId)).toEqual([ok]);
    expect(snap).toMatchObject({ size: 1, excludedByConsent: 1, excludedBySuppression: 1 });
    expect(members.map((m) => m.profileId)).not.toContain(suppressed);
  });

  it('rejects malformed definitions (no SQL is built from raw strings)', async () => {
    await expect(
      tx((t) => audiences.defineSegment(t, h.tenantId, h.users.operator, { name: 'x', purpose: 'analytics', definition: { all: [{ trait: "a'; drop table x;--", op: 'eq', value: 1 }] } })),
    ).rejects.toThrow();
  });
});
