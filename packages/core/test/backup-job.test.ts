import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyAuditChain, withSystem, withTenant } from '@futuregrow/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentActor, type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { createTestDatabase, type TestDatabase } from '../../../test/helpers/db.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { ingestEvents, recordConsent } from '../src/modules/m02-customers/index.js';
import { ingestDocument, searchKnowledge } from '../src/modules/m03-knowledge/index.js';
import { proposeAction } from '../src/modules/m23-execution/gateway.js';

const root = path.resolve(__dirname, '../../..');
const py = [path.join(root, 'jobs/analytics/.venv/Scripts/python.exe'), path.join(root, 'jobs/analytics/.venv/bin/python')].find((p) => fs.existsSync(p));

let h: CoreHarness;
let target: TestDatabase;
let dir: string;
const KEY = randomBytes(32).toString('base64');
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

function backup(args: string[], env: Record<string, string> = {}, module = 'futuregrow_analytics.backup') {
  const r = spawnSync(py!, ['-m', module, ...args], {
    cwd: path.join(root, 'jobs/analytics'),
    env: { ...process.env, DATABASE_URL: h.t.url, FG_BACKUP_FS_DIR: dir, FG_BACKUP_KEY: KEY, PYTHONPATH: path.join(root, 'jobs/analytics'), ...env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const last = r.stdout.trim().split('\n').pop() ?? '';
  return { status: r.status, out: last ? JSON.parse(last) : null, stderr: r.stderr };
}

describe.skipIf(!py)('encrypted logical backup, verification and restore drill', () => {
  let objectKey: string;

  beforeAll(async () => {
    h = await createCoreHarness();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-backup-'));
    const ev = await tx((t) =>
      admitEvidence(
        t,
        h.tenantId,
        h.users.owner,
        {
          sourceType: 'internal',
          sourceOwner: 'acme',
          sourceUriOrObjectId: `doc://${randomUUID()}`,
          retrievedAt: h.clock.now().toISOString(),
          licenseOrUsageRights: 'first-party',
          schemaVersion: '1',
          piiClassification: 'none',
          confidence: 1,
          freshnessSlaHours: 720,
          permittedUses: ['analytics', 'autonomous_execution'],
          kind: 'document',
          content: { text: 'quoted "value", with comma\nand newline' },
        },
        { now: h.clock.now() },
      ),
    );
    const r = await ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'signup', timestamp: h.clock.now().toISOString(), userId: 'u-1', email: 'dana@example.com', properties: { plan: 'team', tags: ['a', 'b'] } }]);
    await tx((t) => recordConsent(t, h.tenantId, h.users.owner, { profileId: r.profileIds[0]!, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'form', capturedAt: h.clock.now().toISOString() }));
    await tx((t) => ingestDocument(t, h.deps, h.tenantId, h.users.owner, { title: 'Importing contacts', text: 'Import contacts from a CSV file under Settings.', evidenceId: ev.evidenceId, visibility: 'public' }));
    await proposeAction(h.deps, h.tenantId, agentActor(), { actionType: 'experiment.start', connectionId: null, params: { experimentId: randomUUID() }, evidenceIds: [ev.evidenceId], idempotencyKey: `bk-${randomUUID()}` });
  }, 120_000);

  afterAll(async () => {
    await target?.drop();
    await h?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('takes a consistent, encrypted snapshot with a hash/count manifest', async () => {
    const r = backup(['create']);
    expect(r.status, r.stderr).toBe(0);
    objectKey = r.out.objectKey;
    expect(objectKey).toMatch(/^backups\/\d{4}\/\d{2}\/\d{2}\/.+\.fgb$/);
    const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${objectKey}.manifest.json`), 'utf8'));
    expect(sidecar.tables.audit_log.rows).toBeGreaterThan(3);
    expect(sidecar.tables.knowledge_chunks.columns).not.toContain('tsv'); // generated column
    // Personal data never appears in plaintext anywhere in the stored artifacts.
    const archive = fs.readFileSync(path.join(dir, objectKey));
    expect(archive.includes(Buffer.from('dana@example.com'))).toBe(false);
    expect(archive.includes(Buffer.from('Import contacts'))).toBe(false);
  });

  it('verifies hashes, decrypts every member and matches row counts', () => {
    const r = backup(['verify']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out).toMatchObject({ ok: true, decrypted: true, objectKey, problems: [] });
  });

  it('restores into an empty migrated database: counts match, audit chain intact, search works', async () => {
    target = await createTestDatabase();
    const r = backup(['verify', '--restore-into', target.url]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.out.restoreDrill).toMatchObject({ ok: true, mismatched: {} });
    const chain = await withTenant(target.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (t) => verifyAuditChain(t, h.tenantId));
    expect(chain).toMatchObject({ valid: true });
    expect(chain.checked).toBeGreaterThan(3);
    const hits = await withTenant(target.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, (t) => searchKnowledge(t, { query: 'import contacts csv', roles: ['owner'], audience: 'public' }));
    expect(hits.length).toBe(1);
    // Append-only guards are active again after the restore.
    await expect(withSystem(target.handle.db, 'test', (t) => t.execute(sql`update audit_log set action = 'x'`))).rejects.toThrow(/IMMUTABLE/);
    // Sequences were advanced past restored ids.
    const seqRow = (await target.handle.db.execute<{ next: string; max: string }>(sql`select nextval(pg_get_serial_sequence('audit_log','id'))::text as next, (select max(id) from audit_log)::text as max`)).rows[0]!;
    expect(BigInt(seqRow.next)).toBeGreaterThan(BigInt(seqRow.max));
  });

  it('refuses to restore over data and records every run', async () => {
    const r = backup(['restore', '--into', target.url]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not empty/);
    const runs = await withSystem(h.t.handle.db, 'test', (t) => t.execute<{ kind: string; status: string }>(sql`select kind, status from backup_runs order by finished_at`));
    expect(runs.rows.map((x) => `${x.kind}:${x.status}`)).toEqual(expect.arrayContaining(['backup:succeeded', 'verification:succeeded', 'restore_drill:succeeded']));
  });

  it('detects tampering and wrong keys', () => {
    expect(backup(['verify'], { FG_BACKUP_KEY: randomBytes(32).toString('base64') }).out).toMatchObject({ ok: false, problems: expect.arrayContaining([expect.stringMatching(/cannot decrypt/)]) });
    const file = path.join(dir, objectKey);
    const bytes = fs.readFileSync(file);
    const at = bytes.length - 2000;
    bytes[at] = bytes[at]! ^ 0xff;
    fs.writeFileSync(file, bytes);
    const r = backup(['verify']);
    expect(r.status).toBe(1);
    expect(r.out.problems.join(' ')).toMatch(/SHA-256/);
  });
  it('the analytics cron entry takes and verifies a backup only when one is due', () => {
    const due = backup([], { FG_BACKUP_INTERVAL_HOURS: '0' }, 'futuregrow_analytics.scheduled');
    expect(due.status, due.stderr).toBe(0);
    expect(due.out.backup.objectKey).toMatch(/\.fgb$/);
    expect(due.out.verification).toMatchObject({ ok: true, problems: [] });
    const idle = backup([], {}, 'futuregrow_analytics.scheduled');
    expect(idle.status, idle.stderr).toBe(0);
    expect(idle.out).toEqual({ backups: 'nothing due' });
  });
});
