import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ProviderCredentials } from '@futuregrow/connectors';
import { type Tx, connectionSecrets } from '@futuregrow/db';
import { FgError } from '@futuregrow/observability';
import type { CoreConfig, SecretKey } from './deps.js';

/**
 * Connection credentials are encrypted with AES-256-GCM. The AAD binds each ciphertext to its
 * tenant and connection, so a ciphertext copied to another row (or tenant) fails to decrypt.
 * Plaintext credentials are only ever materialised at the execution boundary (M23) and are
 * never passed to models, logged, or returned by the API.
 */

export function parseSecretKeys(env: { FG_SECRETS_KEY?: string; FG_SECRETS_KEY_VERSION?: string; FG_SECRETS_KEY_PREVIOUS?: string }): {
  keys: SecretKey[];
  current: number;
} {
  if (!env.FG_SECRETS_KEY) throw new Error('FG_SECRETS_KEY is required (base64-encoded 32 bytes)');
  const current = Number(env.FG_SECRETS_KEY_VERSION ?? 1);
  const keys: SecretKey[] = [{ version: current, key: decodeKey(env.FG_SECRETS_KEY) }];
  if (env.FG_SECRETS_KEY_PREVIOUS) keys.push({ version: current - 1, key: decodeKey(env.FG_SECRETS_KEY_PREVIOUS) });
  return { keys, current };
}

function decodeKey(b64: string): Buffer {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('secrets key must decode to exactly 32 bytes');
  return k;
}

function keyFor(config: CoreConfig, version: number): Buffer {
  const k = config.secretKeys.find((s) => s.version === version);
  if (!k) throw new FgError('SECRET_KEY_UNAVAILABLE', `secrets key version ${version} is not loaded`, 500);
  return k.key;
}

const aad = (tenantId: string, connectionId: string) => Buffer.from(`fg:conn:${tenantId}:${connectionId}`);

export function encryptCredentials(config: CoreConfig, tenantId: string, connectionId: string, creds: ProviderCredentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(config, config.currentSecretVersion), iv);
  cipher.setAAD(aad(tenantId, connectionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: config.currentSecretVersion,
  };
}

export function decryptCredentials(
  config: CoreConfig,
  tenantId: string,
  connectionId: string,
  row: { ciphertext: string; iv: string; authTag: string; keyVersion: number },
): ProviderCredentials {
  const decipher = createDecipheriv('aes-256-gcm', keyFor(config, row.keyVersion), Buffer.from(row.iv, 'base64'));
  decipher.setAAD(aad(tenantId, connectionId));
  decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as ProviderCredentials;
  } catch {
    throw new FgError('SECRET_DECRYPT_FAILED', 'connection credentials failed integrity check', 500);
  }
}

export async function storeCredentials(
  tx: Tx,
  config: CoreConfig,
  tenantId: string,
  connectionId: string,
  creds: ProviderCredentials,
  expiresAt: Date | null,
): Promise<void> {
  const enc = encryptCredentials(config, tenantId, connectionId, creds);
  await tx
    .insert(connectionSecrets)
    .values({ connectionId, tenantId, ...enc, expiresAt })
    .onConflictDoUpdate({ target: connectionSecrets.connectionId, set: { ...enc, expiresAt, rotatedAt: new Date() } });
}

/** Execution-boundary only. */
export async function loadCredentials(tx: Tx, config: CoreConfig, tenantId: string, connectionId: string): Promise<{ creds: ProviderCredentials; expiresAt: Date | null } | null> {
  const [row] = await tx.select().from(connectionSecrets).where(eq(connectionSecrets.connectionId, connectionId));
  if (!row) return null;
  return { creds: decryptCredentials(config, tenantId, connectionId, row), expiresAt: row.expiresAt };
}
