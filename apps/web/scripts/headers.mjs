/**
 * Post-build: write dist/_headers (Cloudflare Pages) with a strict CSP. Inline <script>/<style>
 * blocks emitted by Astro's island runtime are allowed by SHA-256 hash, never 'unsafe-inline'.
 * PUBLIC_API_BASE (if set) is added to connect-src.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.html')) files.push(p);
  }
})(dist);

const scripts = new Set();
const styles = new Set();
const hash = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
for (const f of files) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].length) scripts.add(hash(m[1]));
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) if (m[1].length) styles.add(hash(m[1]));
}

let api = '';
if (process.env.PUBLIC_API_BASE) {
  const u = new URL(process.env.PUBLIC_API_BASE);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') throw new Error('PUBLIC_API_BASE must be https');
  api = ` ${u.origin}`;
}

const csp = [
  "default-src 'self'",
  `script-src 'self' ${[...scripts].join(' ')}`.trim(),
  `style-src 'self' ${[...styles].join(' ')}`.trim(),
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${api}`,
  `form-action 'self'${api}`,
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin

/_astro/*
  Cache-Control: public, max-age=31536000, immutable

/app/*
  Cache-Control: no-store

/login/*
  Cache-Control: no-store
`;
writeFileSync(join(dist, '_headers'), headers);
console.log(`_headers written: ${files.length} pages, ${scripts.size} inline script hash(es), ${styles.size} inline style hash(es)`);
