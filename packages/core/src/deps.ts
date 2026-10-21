import type { ModelGateway } from '@futuregrow/agent-kernel';
import type { ApiVersions, HttpClient, ProviderEndpoints } from '@futuregrow/connectors';
import type { Db } from '@futuregrow/db';
import type { Logger } from '@futuregrow/observability';
import type { ObjectStore } from '@futuregrow/storage';
import type { Notifier } from './ops.js';

export interface JobOptions {
  runAt?: Date;
  jobKey?: string;
  maxAttempts?: number;
  queueName?: string;
}

/** Durable job queue (Graphile Worker in production). Core never imports the worker directly. */
export interface JobQueue {
  add(task: string, payload: Record<string, unknown>, opts?: JobOptions): Promise<void>;
}

export interface SecretKey {
  version: number;
  key: Buffer;
}

export interface CoreConfig {
  /** Pepper for identifier hashing (emails, phones, IPs). Rotating it invalidates suppression matching. */
  identifierPepper: string;
  secretKeys: SecretKey[];
  currentSecretVersion: number;
  /** Public base URL of the API (unsubscribe links, referral redirects, webhooks). */
  apiBaseUrl: string;
  appBaseUrl: string;
  endpoints: ProviderEndpoints;
  versions: ApiVersions;
  verification: { maxAttempts: number; baseDelaySeconds: number };
  environment: 'development' | 'test' | 'staging' | 'production';
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface CoreDeps {
  db: Db;
  store: ObjectStore;
  jobs: JobQueue;
  http: HttpClient;
  logger: Logger;
  config: CoreConfig;
  clock: Clock;
  /** Override sleeping in connectors (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Registry-gated model gateway; absent when no provider is configured (B-003). */
  models?: ModelGateway;
  /** Operator alerts (ALERT_WEBHOOK_URL); absent = log only. */
  notifier?: Notifier;
}

export interface Actor {
  type: 'user' | 'agent' | 'system';
  id: string;
  /** Tenant roles for users; empty for agents/system. */
  roles: string[];
  /** True when the session was established with a second factor (Better Auth twoFactor). */
  mfaVerified: boolean;
  modelId?: string | null;
  promptVersion?: string | null;
}

export const actorRef = (a: Actor) => `${a.type}:${a.id}`;

export const systemActor = (id: string): Actor => ({ type: 'system', id, roles: [], mfaVerified: false });
