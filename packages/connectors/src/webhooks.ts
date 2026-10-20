import { hmacSha256Base64, hmacSha256Hex, safeEqual } from '@futuregrow/observability';

/**
 * Inbound webhook signature verification. All verifiers operate on the exact raw request body;
 * re-serialised JSON would not match the provider's signature.
 */

/** Meta: X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)> */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacSha256Hex(appSecret, rawBody));
}

/** Shopify: X-Shopify-Hmac-Sha256: base64(HMAC-SHA256(appSecret, rawBody)) */
export function verifyShopifyHmac(rawBody: string | Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  return safeEqual(header, hmacSha256Base64(appSecret, rawBody));
}

/**
 * Svix (used by Resend): signature over `${id}.${timestamp}.${body}` with the base64 key after
 * the `whsec_` prefix; header may carry several space-separated `v1,<sig>` entries.
 */
export function verifySvixSignature(rawBody: string | Buffer, headers: { id?: string; timestamp?: string; signature?: string }, secret: string, now = new Date(), toleranceSeconds = 300): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = hmacSha256Base64(key, `${id}.${timestamp}.${rawBody.toString()}`);
  return signature
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .some((s) => safeEqual(s.slice(3), expected));
}

/** TikTok: TikTok-Signature: t=<ts>,s=<hex HMAC-SHA256(clientSecret, `${t}.${body}`)> */
export function verifyTikTokSignature(rawBody: string | Buffer, header: string | undefined, clientSecret: string, now = new Date(), toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((x) => x.trim()) as [string, string]));
  const t = Number(parts.t);
  if (!parts.s || !Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  return safeEqual(parts.s, hmacSha256Hex(clientSecret, `${parts.t}.${rawBody.toString()}`));
}
