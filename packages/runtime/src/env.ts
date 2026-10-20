import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8080),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().min(1),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(5),
    DATABASE_SSL: bool.default(false),
    /** Public URL of this API (Better Auth baseURL, unsubscribe and referral links). */
    API_BASE_URL: z.string().url().default('http://localhost:8080'),
    /** Public URL of the web control plane. */
    APP_BASE_URL: z.string().url().default('http://localhost:4321'),
    /** Comma-separated allowed browser origins (CORS + Better Auth trustedOrigins). */
    APP_ORIGINS: z.string().default('http://localhost:4321'),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    FG_ALLOW_SIGNUP: bool.default(false),
    FG_SECRETS_KEY: z.string().optional(),
    FG_SECRETS_KEY_VERSION: z.string().optional(),
    FG_SECRETS_KEY_PREVIOUS: z.string().optional(),
    FG_IDENTIFIER_PEPPER: z.string().min(16).optional(),
    FG_CHECK_BREACHED_PASSWORDS: bool.default(true),
    // Object storage (D-022)
    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_ENDPOINT: z.string().url().optional(),
    FG_LOCAL_STORAGE_DIR: z.string().optional(),
    // Provider API versions (capability registry must hold a matching record)
    META_GRAPH_API_VERSION: z.string().default('v26.0'),
    GOOGLE_ADS_API_VERSION: z.string().default('v26'),
    SHOPIFY_API_VERSION: z.string().default('2026-10'),
    // Webhook secrets (B-005..B-009)
    META_APP_SECRET: z.string().optional(),
    META_WEBHOOK_VERIFY_TOKEN: z.string().min(16).optional(),
    SHOPIFY_WEBHOOK_SECRET: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    TIKTOK_CLIENT_SECRET: z.string().optional(),
    // Model gateway (B-003)
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional(),
    OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
    // Optional embeddings endpoint (D-007); full-text retrieval works without it.
    EMBEDDINGS_BASE_URL: z.string().url().optional(),
    EMBEDDINGS_MODEL: z.string().optional(),
    EMBEDDINGS_API_KEY: z.string().optional(),
    // Optional immediate trigger of Northflank jobs (D-016); cron schedules work without it.
    NORTHFLANK_API_TOKEN: z.string().optional(),
    NORTHFLANK_PROJECT_ID: z.string().optional(),
    NORTHFLANK_ANALYTICS_JOB_ID: z.string().optional(),
    NORTHFLANK_MEDIA_JOB_ID: z.string().optional(),
    VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
    VERIFICATION_BASE_DELAY_SECONDS: z.coerce.number().int().min(1).max(3600).default(15),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production') {
      for (const k of ['BETTER_AUTH_SECRET', 'FG_SECRETS_KEY', 'FG_IDENTIFIER_PEPPER'] as const) {
        if (!e[k]) ctx.addIssue({ code: 'custom', path: [k], message: `${k} is required in production` });
      }
      if (!e.API_BASE_URL.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['API_BASE_URL'], message: 'must be https in production' });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/** Development-only fallbacks so a local stack starts without manual secret generation. */
export const DEV_FALLBACKS = {
  BETTER_AUTH_SECRET: 'dev-only-better-auth-secret-change-me-0123456789',
  FG_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  FG_IDENTIFIER_PEPPER: 'dev-only-identifier-pepper',
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid environment: ${msg}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV !== 'production') {
    env.BETTER_AUTH_SECRET ??= DEV_FALLBACKS.BETTER_AUTH_SECRET;
    env.FG_SECRETS_KEY ??= DEV_FALLBACKS.FG_SECRETS_KEY;
    env.FG_IDENTIFIER_PEPPER ??= DEV_FALLBACKS.FG_IDENTIFIER_PEPPER;
  }
  return env;
}

export const origins = (env: Env) =>
  env.APP_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
