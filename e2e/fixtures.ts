import { createHmac } from 'node:crypto';

/** Shared by the E2E server (seeding) and the browser tests. Test-only credentials. */
export const E2E_PORT = Number(process.env.FG_E2E_PORT ?? 4400);
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
export const OWNER = { email: 'owner@e2e.futuregrow.test', password: 'e2e-initial-lantern-passphrase', name: 'E2E Owner' };
export const ORG = { name: 'E2E Growth Co', slug: 'e2e-growth' };

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits): what an authenticator app shows. */
export function totp(secretB32: string, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const off = mac[mac.length - 1]! & 0xf;
  return ((mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
