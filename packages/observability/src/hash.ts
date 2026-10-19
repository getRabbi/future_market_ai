import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@futuregrow/contracts';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hmacSha256Base64(key: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('base64');
}

/** Constant-time comparison for signatures/tokens. Returns false for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Keyed hash for identifiers (emails, phones, IPs) so they can be matched/suppressed without
 * storing the raw value. Uses a tenant-independent pepper from configuration.
 */
export function identifierHash(pepper: string, kind: string, value: string): string {
  return hmacSha256Hex(pepper, `${kind}:${normalizeIdentifier(kind, value)}`);
}

export function normalizeIdentifier(kind: string, value: string): string {
  const v = value.trim();
  if (kind === 'email') return v.toLowerCase();
  if (kind === 'phone') return v.replace(/[^\d+]/g, '');
  return v;
}
