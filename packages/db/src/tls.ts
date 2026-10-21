import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';

/**
 * PostgreSQL TLS policy (DEPLOYMENT §3.5). node-postgres lets `sslmode`/`sslrootcert` in the
 * connection string override the `ssl` option (silently dropping a configured CA), treats
 * `sslmode=no-verify` as "skip verification", and will adopt libpq semantics in its next major
 * version, where `sslmode=require` no longer checks the certificate. FUTUREGROW therefore strips
 * every TLS parameter from the URL and builds the TLS options itself:
 *
 * - TLS is always `verify-full` (chain + host name); there is no unverified mode.
 * - `sslmode=require|verify-ca|verify-full|prefer` or `DATABASE_SSL=true` enable TLS.
 * - `sslmode=no-verify|allow` are refused; `sslmode=disable` / `DATABASE_SSL=false` are refused in
 *   production unless the server is on loopback or a Unix socket.
 * - Unset in production means TLS (secure default).
 * - CA: `DATABASE_SSL_CA` (PEM text or a file path), else `sslrootcert` from the URL, else the
 *   Node.js public CA store.
 */
export type DbTlsCaSource = 'public' | 'DATABASE_SSL_CA' | 'sslrootcert';

export interface DbTlsSettings {
  /** URL without TLS parameters (pg cannot override the options below). */
  connectionString: string;
  ssl: false | ConnectionOptions;
  mode: 'disable' | 'verify-full';
  caSource: DbTlsCaSource | null;
  host: string;
}

export interface ResolveDbTlsInput {
  connectionString: string;
  /** DATABASE_SSL; undefined when not set. */
  ssl?: boolean | undefined;
  /** DATABASE_SSL_CA: PEM bundle or path to one. */
  ca?: string | undefined;
  production: boolean;
}

const TLS_PARAMS = ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'sslcrl', 'sslcrldir', 'sslsni', 'ssl', 'uselibpqcompat', 'sslnegotiation', 'sslcompression', 'ssl_min_protocol_version', 'ssl_max_protocol_version'];
const TLS_ON = new Set(['require', 'verify-ca', 'verify-full', 'prefer']);

export class DbTlsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbTlsConfigError';
  }
}

function isLocal(host: string): boolean {
  return host === '' || host.startsWith('/') || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

function readCa(value: string, origin: string): string {
  const pem = value.includes('-----BEGIN')
    ? value.replace(/\\n/g, '\n')
    : (() => {
        try {
          return fs.readFileSync(value, 'utf8');
        } catch (err) {
          throw new DbTlsConfigError(`${origin}: cannot read CA file ${value} (${(err as Error).message})`);
        }
      })();
  if (!/-----BEGIN CERTIFICATE-----/.test(pem)) throw new DbTlsConfigError(`${origin}: no PEM certificate found`);
  try {
    // Fail fast on a malformed bundle rather than on the first connection.
    new X509Certificate(pem.slice(pem.indexOf('-----BEGIN CERTIFICATE-----')));
  } catch (err) {
    throw new DbTlsConfigError(`${origin}: invalid certificate (${(err as Error).message})`);
  }
  return pem;
}

export function resolveDbTls(input: ResolveDbTlsInput): DbTlsSettings {
  let url: URL;
  try {
    url = new URL(input.connectionString);
  } catch {
    throw new DbTlsConfigError('DATABASE_URL is not a valid URL');
  }
  const params = url.searchParams;
  const sslmode = params.get('sslmode')?.toLowerCase() ?? null;
  const rootcert = params.get('sslrootcert');
  for (const p of TLS_PARAMS) params.delete(p);
  // Host may also come from ?host= (Unix sockets).
  const host = decodeURIComponent(url.hostname || params.get('host') || '');

  if (sslmode === 'no-verify' || sslmode === 'allow') throw new DbTlsConfigError(`sslmode=${sslmode} disables certificate verification, which FUTUREGROW does not allow; use sslmode=verify-full (with DATABASE_SSL_CA for a private CA)`);
  if (sslmode && sslmode !== 'disable' && !TLS_ON.has(sslmode)) throw new DbTlsConfigError(`unknown sslmode=${sslmode}`);
  if (sslmode === 'disable' && input.ssl === true) throw new DbTlsConfigError('DATABASE_SSL=true conflicts with sslmode=disable in DATABASE_URL');

  const wantTls = input.ssl === true || (sslmode !== null && TLS_ON.has(sslmode)) || (input.ssl === undefined && sslmode === null && input.production);
  const connectionString = url.toString();
  if (!wantTls) {
    if (input.production && !isLocal(host)) throw new DbTlsConfigError(`refusing an unencrypted database connection to ${host} in production; remove sslmode=disable / DATABASE_SSL=false`);
    return { connectionString, ssl: false, mode: 'disable', caSource: null, host };
  }
  if (host.startsWith('/')) throw new DbTlsConfigError('TLS was requested for a Unix-socket connection');

  let ca: string | undefined;
  let caSource: DbTlsCaSource = 'public';
  if (input.ca?.trim()) {
    ca = readCa(input.ca.trim(), 'DATABASE_SSL_CA');
    caSource = 'DATABASE_SSL_CA';
  } else if (rootcert && rootcert !== 'system') {
    ca = readCa(rootcert, 'sslrootcert');
    caSource = 'sslrootcert';
  }
  const ssl: ConnectionOptions = {
    rejectUnauthorized: true,
    ...(ca ? { ca } : {}),
    // SNI only for DNS names; host-name verification itself is Node's default checkServerIdentity.
    ...(isIP(host.replace(/^\[|\]$/g, '')) ? {} : { servername: host }),
  };
  return { connectionString, ssl, mode: 'verify-full', caSource, host };
}

/** TLS inputs from the process environment (CLIs that do not load the full runtime env). */
export function dbTlsFromEnv(env: NodeJS.ProcessEnv = process.env): { ssl: boolean | undefined; sslCa: string | undefined; production: boolean } {
  const raw = env.DATABASE_SSL?.trim().toLowerCase();
  let ssl: boolean | undefined;
  if (raw === 'true' || raw === '1') ssl = true;
  else if (raw === 'false' || raw === '0') ssl = false;
  else if (raw) throw new DbTlsConfigError('DATABASE_SSL must be true or false');
  return { ssl, sslCa: env.DATABASE_SSL_CA?.trim() || undefined, production: env.NODE_ENV === 'production' };
}
