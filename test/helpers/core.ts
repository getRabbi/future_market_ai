import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_API_VERSIONS, DEFAULT_ENDPOINTS, HttpClient } from '../../packages/connectors/src/index.js';
import type { CoreConfig, CoreDeps, JobOptions, JobQueue } from '../../packages/core/src/deps.js';
import { authUser, member, organization } from '../../packages/db/src/index.js';
import { syncCapabilityRegistry } from '../../packages/core/src/modules/m24-governance/index.js';
import { createLogger } from '../../packages/observability/src/index.js';
import { FilesystemStore } from '../../packages/storage/src/index.js';
import { type TestDatabase, createTestDatabase } from './db.js';
import type { Actor } from '../../packages/core/src/deps.js';

export class RecordingQueue implements JobQueue {
  readonly jobs: { task: string; payload: Record<string, unknown>; opts: JobOptions | undefined }[] = [];
  async add(task: string, payload: Record<string, unknown>, opts?: JobOptions): Promise<void> {
    this.jobs.push({ task, payload, opts });
  }
  take(task: string) {
    return this.jobs.filter((j) => j.task === task);
  }
}

export class TestClock {
  constructor(public current = new Date('2026-10-19T15:00:00Z')) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface CoreHarness {
  t: TestDatabase;
  deps: CoreDeps;
  jobs: RecordingQueue;
  clock: TestClock;
  storeDir: string;
  tenantId: string;
  users: Record<'owner' | 'approver' | 'finance' | 'legal' | 'operator' | 'admin', Actor>;
  close(): Promise<void>;
}

export function testConfig(endpointBase?: string): CoreConfig {
  const endpoints = endpointBase
    ? {
        ...DEFAULT_ENDPOINTS,
        metaGraph: endpointBase,
        googleAds: endpointBase,
        googleOAuth: `${endpointBase}/oauth/token`,
        tiktok: endpointBase,
        youtubeData: `${endpointBase}/youtube/v3`,
        youtubeUpload: `${endpointBase}/upload/youtube/v3`,
        appStoreConnect: endpointBase,
        resend: endpointBase,
        searchConsole: `${endpointBase}/webmasters/v3`,
        shopifyOverride: endpointBase,
      }
    : DEFAULT_ENDPOINTS;
  return {
    identifierPepper: 'test-pepper-not-secret',
    secretKeys: [{ version: 1, key: randomBytes(32) }],
    currentSecretVersion: 1,
    apiBaseUrl: 'https://api.futuregrow.test',
    appBaseUrl: 'https://app.futuregrow.test',
    endpoints,
    versions: DEFAULT_API_VERSIONS,
    verification: { maxAttempts: 4, baseDelaySeconds: 1 },
    environment: 'test',
  };
}

const ROLE_SETS = {
  owner: ['owner'],
  approver: ['approver'],
  finance: ['finance_approver'],
  legal: ['legal_approver'],
  operator: ['growth_operator'],
  admin: ['admin'],
} as const;

export async function createCoreHarness(opts: { endpointBase?: string; tenantSlug?: string } = {}): Promise<CoreHarness> {
  const t = await createTestDatabase();
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-store-'));
  const jobs = new RecordingQueue();
  const clock = new TestClock();
  const deps: CoreDeps = {
    db: t.handle.db,
    store: new FilesystemStore(storeDir),
    jobs,
    http: new HttpClient({ maxRetries: 1, baseBackoffMs: 1 }),
    logger: createLogger('test', 'silent'),
    config: testConfig(opts.endpointBase),
    clock,
    sleep: async () => {},
  };
  const tenantId = `org_${randomUUID().slice(0, 8)}`;
  await t.handle.db.insert(organization).values({ id: tenantId, name: 'Acme', slug: opts.tenantSlug ?? tenantId });
  const users = {} as CoreHarness['users'];
  for (const [k, roles] of Object.entries(ROLE_SETS)) {
    const id = `user_${k}_${randomUUID().slice(0, 6)}`;
    await t.handle.db.insert(authUser).values({ id, name: k, email: `${id}@acme.test`, emailVerified: true, twoFactorEnabled: true, isPlatformAdmin: k === 'owner' });
    await t.handle.db.insert(member).values({ id: `mem_${id}`, organizationId: tenantId, userId: id, role: roles.join(',') });
    users[k as keyof typeof ROLE_SETS] = { type: 'user', id, roles: [...roles], mfaVerified: true };
  }
  await syncCapabilityRegistry(t.handle.db);
  return {
    t,
    deps,
    jobs,
    clock,
    storeDir,
    tenantId,
    users,
    async close() {
      await t.drop();
      fs.rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

export const agentActor = (id = 'growth-brain'): Actor => ({ type: 'agent', id, roles: [], mfaVerified: false, modelId: 'claude-sonnet-5-5', promptVersion: 'brain-v1' });
