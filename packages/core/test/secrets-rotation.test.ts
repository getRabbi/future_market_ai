import { randomBytes } from 'node:crypto';
import { connectionSecrets, withSystem, withTenant } from '@futuregrow/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createConnection } from '../src/modules/connections.js';
import { loadCredentials, reencryptCredentials } from '../src/secrets.js';

let h: CoreHarness;

beforeAll(async () => {
  h = await createCoreHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('credential key rotation', () => {
  it('re-encrypts secrets from the previous key and leaves them readable with the new key alone', async () => {
    const v1 = h.deps.config.secretKeys[0]!;
    const conn = await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'resend', externalAccountId: 'acme.test', displayName: 'Resend', grantedScopes: [], credentials: { apiKey: 're_rotation_test' } });
    const v2 = { version: 2, key: randomBytes(32) };
    const rotated = { ...h.deps.config, secretKeys: [v2, v1], currentSecretVersion: 2 };

    expect(await reencryptCredentials(h.t.handle.db, rotated)).toEqual({ reencrypted: 1, remainingOnOldKeys: 0 });
    const [row] = await withSystem(h.t.handle.db, 'test', (tx) => tx.select().from(connectionSecrets).where(eq(connectionSecrets.connectionId, conn.id)));
    expect(row!.keyVersion).toBe(2);

    const newOnly = { ...rotated, secretKeys: [v2] };
    const loaded = await withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (tx) => loadCredentials(tx, newOnly, h.tenantId, conn.id));
    expect(loaded!.creds).toEqual({ provider: 'resend', apiKey: 're_rotation_test' });
    // Idempotent: nothing left to do.
    expect(await reencryptCredentials(h.t.handle.db, rotated)).toEqual({ reencrypted: 0, remainingOnOldKeys: 0 });
  });
});
