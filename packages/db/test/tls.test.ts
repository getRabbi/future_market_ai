import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, probeDatabase } from '../src/client.js';
import { runAllMigrations } from '../src/migrate.js';
import { DbTlsConfigError, dbTlsFromEnv, resolveDbTls } from '../src/tls.js';

const root = path.resolve(__dirname, '../../..');
const py = [path.join(root, 'jobs/analytics/.venv/Scripts/python.exe'), path.join(root, 'jobs/analytics/.venv/bin/python')].find((p) => fs.existsSync(p));

describe('TLS policy (resolveDbTls)', () => {
  const remote = 'postgres://u:p@db.internal.example:5432/app';

  it('strips TLS parameters so node-postgres cannot override the verified options', () => {
    const r = resolveDbTls({ connectionString: `${remote}?sslmode=require&sslrootcert=system&application_name=x`, production: true });
    expect(r.mode).toBe('verify-full');
    expect(r.connectionString).toBe(`${remote}?application_name=x`);
    expect(r.ssl).toMatchObject({ rejectUnauthorized: true, servername: 'db.internal.example' });
    expect(r.caSource).toBe('public');
  });

  it('maps every libpq TLS mode to verify-full and refuses modes that skip verification', () => {
    for (const m of ['require', 'verify-ca', 'verify-full', 'prefer']) expect(resolveDbTls({ connectionString: `${remote}?sslmode=${m}`, production: false }).mode).toBe('verify-full');
    for (const m of ['no-verify', 'allow']) expect(() => resolveDbTls({ connectionString: `${remote}?sslmode=${m}`, production: false })).toThrow(DbTlsConfigError);
    expect(() => resolveDbTls({ connectionString: `${remote}?sslmode=bogus`, production: false })).toThrow(/unknown sslmode/);
    expect(() => resolveDbTls({ connectionString: `${remote}?sslmode=disable`, ssl: true, production: false })).toThrow(/conflicts/);
  });

  it('defaults to TLS in production and refuses plaintext to a remote host', () => {
    expect(resolveDbTls({ connectionString: remote, production: true }).mode).toBe('verify-full');
    expect(resolveDbTls({ connectionString: remote, production: false }).mode).toBe('disable');
    expect(() => resolveDbTls({ connectionString: remote, ssl: false, production: true })).toThrow(/unencrypted/);
    expect(() => resolveDbTls({ connectionString: `${remote}?sslmode=disable`, production: true })).toThrow(/unencrypted/);
    // Loopback is acceptable without TLS even in production.
    expect(resolveDbTls({ connectionString: 'postgres://u:p@127.0.0.1:5432/app', ssl: false, production: true }).mode).toBe('disable');
  });

  it('rejects unreadable or malformed CA bundles before connecting', () => {
    expect(() => resolveDbTls({ connectionString: remote, ssl: true, ca: '/nonexistent/ca.pem', production: true })).toThrow(/cannot read CA file/);
    expect(() => resolveDbTls({ connectionString: remote, ssl: true, ca: '-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----', production: true })).toThrow(/invalid certificate/);
  });

  it('reads DATABASE_SSL strictly', () => {
    expect(dbTlsFromEnv({ DATABASE_SSL: 'true', NODE_ENV: 'production' })).toEqual({ ssl: true, sslCa: undefined, production: true });
    expect(dbTlsFromEnv({}).ssl).toBeUndefined();
    expect(() => dbTlsFromEnv({ DATABASE_SSL: 'yes' })).toThrow(/true or false/);
  });
});

describe.skipIf(!py)('TLS against a real PostgreSQL server', () => {
  const PORT = 54000 + (process.pid % 900);
  const PASSWORD = 'fg-tls-test';
  const dir = path.resolve(root, '.data', `pg-tls-${process.pid}`);
  const certs = path.join(dir, 'certs');
  let server: EmbeddedPostgres;
  let ca: string;
  let rogue: string;
  const url = (host = 'localhost', db = 'postgres', query = '') => `postgres://postgres:${PASSWORD}@${host}:${PORT}/${db}${query}`;

  beforeAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const gen = spawnSync(py!, [path.join(root, 'test/helpers/make_test_certs.py'), certs], { encoding: 'utf8' });
    expect(gen.status, gen.stderr).toBe(0);
    ca = fs.readFileSync(path.join(certs, 'ca.pem'), 'utf8');
    rogue = fs.readFileSync(path.join(certs, 'rogue-ca.pem'), 'utf8');
    const posix = (p: string) => p.replaceAll('\\', '/');
    server = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'data'),
      user: 'postgres',
      password: PASSWORD,
      port: PORT,
      persistent: false,
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${posix(path.join(certs, 'server.pem'))}`, '-c', `ssl_key_file=${posix(path.join(certs, 'server.key'))}`],
      onLog: () => {},
      onError: () => {},
    });
    await server.initialise();
    await server.start();
  }, 120_000);

  afterAll(async () => {
    await server?.stop();
    // Windows may hold file handles briefly after postmaster exit.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  const connect = async (opts: Parameters<typeof createDb>[0]) => {
    const h = createDb({ max: 1, ...opts });
    try {
      return await probeDatabase(h.db);
    } finally {
      await h.close();
    }
  };
  /** Drizzle wraps driver errors ("Failed query ..."); the TLS reason is in the cause chain. */
  const failure = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (err) {
      const parts: string[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
      return parts.join(' <- ');
    }
    throw new Error('expected the connection to be refused');
  };

  it('connects with verify-full against the configured CA (PEM text or file path)', async () => {
    const caps = await connect({ connectionString: url(), ssl: true, sslCa: ca, production: true });
    expect(caps.ssl).toBe(true);
    expect(caps.sslVersion).toMatch(/^TLSv1\.[23]$/);
    expect((await connect({ connectionString: url(), ssl: true, sslCa: path.join(certs, 'ca.pem'), production: true })).ssl).toBe(true);
  });

  it('honours DATABASE_SSL_CA even when the URL carries sslmode (node-postgres would drop it)', async () => {
    expect((await connect({ connectionString: url('localhost', 'postgres', '?sslmode=require'), sslCa: ca, production: true })).ssl).toBe(true);
    // Plain node-postgres with the same inputs ignores the CA and fails: the regression being prevented.
    const raw = new pg.Client({ connectionString: url('localhost', 'postgres', '?sslmode=require'), ssl: { rejectUnauthorized: true, ca } });
    await expect(raw.connect()).rejects.toThrow(/certificate|self.signed/i);
    await raw.end().catch(() => {});
  });

  it('refuses an untrusted CA, the public store, and a host-name mismatch', async () => {
    expect(await failure(connect({ connectionString: url(), ssl: true, sslCa: rogue, production: true }))).toMatch(/self.signed certificate in certificate chain|unable to verify|unable to get local issuer/i);
    expect(await failure(connect({ connectionString: url(), ssl: true, production: true }))).toMatch(/self.signed certificate in certificate chain|unable to verify|unable to get local issuer/i);
    // The certificate names only "localhost".
    expect(await failure(connect({ connectionString: url('127.0.0.1'), ssl: true, sslCa: ca, production: true }))).toMatch(/IP: 127\.0\.0\.1 is not in the cert/i);
  });

  it('runs migrations (Graphile + Drizzle) over the same verified connection', async () => {
    const admin = createDb({ connectionString: url(), ssl: true, sslCa: ca, max: 1 });
    await admin.pool.query('create database fg_tls_migrate');
    await admin.close();
    await expect(runAllMigrations(url('localhost', 'fg_tls_migrate'), { ssl: true, sslCa: rogue, production: true })).rejects.toThrow(/certificate|self.signed|unable to verify/i);
    const r = await runAllMigrations(url('localhost', 'fg_tls_migrate'), { ssl: true, sslCa: ca, production: true });
    expect(r.transitions).toBeGreaterThan(10);
  }, 120_000);

  it('makes the Python jobs verify too: libpq sslmode=require alone would accept any certificate', () => {
    const script = 'import json,psycopg\nfrom futuregrow_analytics.pgtls import dsn_from_env\nwith psycopg.connect(dsn_from_env()) as c:\n  print(json.dumps(c.execute("select ssl from pg_stat_ssl where pid = pg_backend_pid()").fetchone()[0]))';
    const run = (env: Record<string, string>) => spawnSync(py!, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: path.join(root, 'jobs/analytics'), NODE_ENV: 'production', DATABASE_SSL: '', DATABASE_SSL_CA: '', PGSSLROOTCERT: '', ...env } });
    const ok = run({ DATABASE_URL: url('localhost', 'postgres', '?sslmode=require'), DATABASE_SSL_CA: path.join(certs, 'ca.pem') });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe('true');
    const pem = run({ DATABASE_URL: url(), DATABASE_SSL: 'true', DATABASE_SSL_CA: ca });
    expect(pem.status, pem.stderr).toBe(0);
    const bad = run({ DATABASE_URL: url('localhost', 'postgres', '?sslmode=require'), DATABASE_SSL_CA: path.join(certs, 'rogue-ca.pem') });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/certificate verify failed/i);
    // No CA configured: the system bundle does not trust the test CA, so the connection is refused.
    const system = run({ DATABASE_URL: url('localhost', 'postgres', '?sslmode=require') });
    expect(system.status).not.toBe(0);
    expect(system.stderr).toMatch(/certificate verify failed|root certificate/i);
    const mismatch = run({ DATABASE_URL: url('127.0.0.1', 'postgres', '?sslmode=require'), DATABASE_SSL_CA: path.join(certs, 'ca.pem') });
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/does not match host name|server certificate for/i);
  });
});
