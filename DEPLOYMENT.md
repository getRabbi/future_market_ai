# Deployment — controlled beta on Northflank Sandbox + Cloudflare

This guide deploys FUTUREGROW exactly as built: 2 Northflank services (`api`, `worker`), 2 cron jobs (`analytics-job`, `media-job`), 1 PostgreSQL 17 addon, Cloudflare Pages for the control plane and Cloudflare R2 for objects and backups. Steps marked **(owner)** need an account holder. The controlled beta was deployed with these steps on 2026-10-20 (BLOCKERS B-001, B-002, B-004, B-018 resolved); the template fixes found on the live accounts are in `infra/northflank/template.json`.

> The Northflank Developer Sandbox is for development and a controlled beta. Do not market a Sandbox deployment as production; upgrade plans for a public launch (tech stack, "Final verdict").

## 0. Prerequisites

* GitHub repository containing this code, CI green (`.github/workflows/ci.yml`).
* **(owner)** Northflank account with a payment method on file (required even for Sandbox resources).
* **(owner)** Cloudflare account; ideally one registrable domain for `app.<domain>` (Pages) and `api.<domain>` (Northflank) so cookies are same-site (D-013).
* Node 24.22 and npm locally for the build/CLI steps.

## 1. Generate secrets

```sh
node -e "const c=require('crypto');for (const k of ['BETTER_AUTH_SECRET','FG_SECRETS_KEY','FG_IDENTIFIER_PEPPER','FG_BACKUP_KEY','META_WEBHOOK_VERIFY_TOKEN']) console.log(k+'='+c.randomBytes(32).toString('base64'))"
```

Store them in a password manager. `FG_BACKUP_KEY` must be kept outside Northflank as well — without it backups cannot be read. `FG_IDENTIFIER_PEPPER` must never change casually (RUNBOOK §8).

## 2. Cloudflare R2 (owner)

```sh
npx wrangler r2 bucket create futuregrow-objects
npx wrangler r2 bucket create futuregrow-backups
npx wrangler r2 bucket cors set futuregrow-objects --file infra/cloudflare/r2-cors.json   # edit the origin first
npx wrangler r2 bucket lifecycle add futuregrow-backups expire-backups backups/ --expire-days 35
```

Create an R2 API token with *Object Read & Write* limited to these two buckets. Note the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 3. Northflank (owner)

1. Templates → **Import** `infra/northflank/template.json`. Fill the arguments: repository URL/branch, region, public URLs (`API_BASE_URL`, `APP_BASE_URL`, `APP_ORIGINS` = the Pages origin), the secrets from step 1, R2 values (`R2_BUCKET=futuregrow-objects`, `R2_BACKUP_BUCKET=futuregrow-backups`), and provider secrets you have (leave others empty). The template was written against Northflank's template format but has not been validated against a live account — review each resource in the editor before running.
2. Run the template. It creates the project, the PostgreSQL addon, two secret groups (runtime; backups restricted to the analytics job), the services and the jobs, building all images from `infra/docker/*.Dockerfile`.
3. The `api` service applies migrations on start (`node migrate.mjs`), then serves on port 8080 with readiness `/readyz` and liveness `/healthz`. Keep `instances: 1` while migrations run on start.
4. **Database privileges and tenant isolation (B-004):** the addon's app user (`USERNAME`, used by `POSTGRES_URI`) cannot create schemas or roles, so the first migration fails with `permission denied for database`. The addon's admin user (`POSTGRES_URI_ADMIN`) owns the database and has `CREATEROLE` but is not a superuser. Run once as admin, before the api's first start:
   ```sql
   GRANT CREATE ON DATABASE "<DATABASE>" TO "<USERNAME>";
   GRANT USAGE, CREATE ON SCHEMA public TO "<USERNAME>";
   CREATE ROLE fg_tenant NOLOGIN NOBYPASSRLS;
   GRANT fg_tenant TO "<USERNAME>";
   ```
   The addon has no external access, so run it inside the project, e.g. one `analytics-job` run with a per-run command and env override (the image has `psycopg`). The app keeps running as the non-admin user. `canSetTenantRole` must then be `true` (`node probe.mjs` on the api); in production the runtime refuses to start without it. `pgvectorAvailable: false` is fine (exact-cosine fallback, D-007).
5. If the addon's TLS certificate is signed by a private CA, set `DATABASE_SSL_CA` (PEM) for the Node services and `PGSSLROOTCERT` (file path) for the analytics job. Verification is never disabled.
6. Optional: set `NORTHFLANK_API_TOKEN`, `NORTHFLANK_PROJECT_ID`, `NORTHFLANK_ANALYTICS_JOB_ID`, `NORTHFLANK_MEDIA_JOB_ID` on the worker so queued work triggers the jobs immediately instead of waiting for the next cron run.

## 4. Cloudflare Pages (owner)

Same-site domain (recommended): build with `PUBLIC_API_BASE=https://api.<domain>` and serve the app from `app.<domain>`.
No custom domain: leave `PUBLIC_API_BASE` empty; the Pages Functions in `apps/web/functions` proxy `/v1/*` and `/api/auth/*` to `API_ORIGIN`.

```sh
npm ci --ignore-scripts
PUBLIC_API_BASE= npm run build -w @futuregrow/web      # writes apps/web/dist and dist/_headers (hashed CSP)
cd apps/web
npx wrangler pages project create futuregrow-web
npx wrangler pages deploy dist --project-name futuregrow-web
npx wrangler pages secret put API_ORIGIN --project-name futuregrow-web   # https://api.<domain> or the Northflank URL
```

Add the Pages origin to the api's `APP_ORIGINS` (CORS and Better Auth trusted origins) and redeploy the api.

## 5. First owner and platform admin

1. Temporarily set `FG_ALLOW_SIGNUP=true` on the api and create the first account (the control plane has no public sign-up form):
   ```sh
   curl -fsS -X POST https://api.<domain>/api/auth/sign-up/email -H 'content-type: application/json' -H 'origin: https://app.<domain>' \
     -d '{"email":"owner@your-company.com","password":"<long unique passphrase>","name":"Owner"}'
   ```
   Then set `FG_ALLOW_SIGNUP=false` and redeploy. Afterwards people join by invitation only: an owner/admin creates the invitation in **Account & security → Members** and shares the `/invite?id=…` link (D-031); only the invited address can create an account.
2. Create the organization in **Account & security**, then enrol TOTP and sign in again (approvals, kill switches, policy and connections require a two-factor session).
3. Grant platform admin (needed to approve models, publish jurisdiction rules and system halt) with one audited SQL statement in the addon console:
   `update auth_user set is_platform_admin = true where email = 'owner@your-company.com';`

## 6. Governance setup before any automation

1. **Models (B-003):** set at least one provider key — `ANTHROPIC_API_KEY`, or the hosted OpenAI-compatible providers `OPENROUTER_API_KEY` (Claude Opus 5.5 via OpenRouter, restricted to upstreams that do not collect data), `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`. The api seeds their models unapproved; a platform admin approves each with `POST /v1/platform/models/approve` once the vendor terms are reviewed (models that may train on customer data cannot be approved, so Gemini only on a paid project). The gateway prefers Opus (direct, then OpenRouter) and fails over in the order OpenAI, Gemini, Groq. Without an approved model every agent stage abstains.
2. **Jurisdictions (B-013):** legal publishes rule packs (`POST /v1/platform/jurisdiction-rules`) and the tenant lists them in `approvedJurisdictions`; otherwise every public/messaging/spend action needs legal approval.
3. **Autonomy policy:** Governance → Autonomy policy. Leave categories unconfigured (always approval) until you deliberately pre-authorize limits.
4. **Sender identity** (CAN-SPAM postal address) before any commercial email (B-008).
5. **Remotion licence attestation** before renders (B-014).
6. **Connections:** Control → **Connections**: pick the provider, fill its form (each field says where to find the value), **Test credentials** (a read-only call; nothing is stored), then **Save connection** (owner/admin with a two-factor session). Saved accounts have **Test connection**, **Update credentials** and **Disable**. Use least-privilege scopes. The same screen lists the webhook URLs below and whether each signing secret is set. Register webhooks:
   * Meta: `https://api.<domain>/webhooks/meta` (verify token = `META_WEBHOOK_VERIFY_TOKEN`, app secret = `META_APP_SECRET`)
   * Shopify: `https://api.<domain>/webhooks/shopify` (topics `orders/create`, `orders/paid`, `refunds/create`)
   * Resend: `https://api.<domain>/webhooks/resend` (svix secret = `RESEND_WEBHOOK_SECRET`)
   * TikTok: `https://api.<domain>/webhooks/tiktok`

## 7. Smoke test

```sh
curl -fsS https://api.<domain>/healthz && curl -fsS https://api.<domain>/readyz && curl -fsS https://api.<domain>/statusz
curl -fsS https://api.<domain>/v1/openapi.json | head -c 200
```

Then in the control plane: Audit trail → **Verify chain now** (valid), Evidence → admit a record, Experiments → create and *Propose start* (should require approval), approve with a second person, check the action reaches `VERIFIED`. After the first analytics-job run, `backup_runs` holds `backup` and `verification` rows (RUNBOOK §1).

## 8. Moving beyond the beta

* Upgrade Northflank plans (the MMM sampler and Remotion renders are CPU-bound on Sandbox; correctness is unchanged, throughput improves).
* Run migrations as a dedicated pre-deploy job once more than one api instance is needed.
* Close the external blockers listed in `BLOCKERS.md` for each channel before enabling it.

## 9. Monitoring, alerts and spend limits

1. **Operator alerts:** set `ALERT_WEBHOOK_URL` (https; a Slack or Discord incoming webhook, or any endpoint accepting JSON) in the runtime secret group so both `api` and `worker` get it; optional `ALERT_ENVIRONMENT` labels the messages. Unset, alerts are only logged. The worker's `ops_monitor` cron (every 5 min) reports component problems, critical tenant alerts, sev1/sev2 incidents and Graphile jobs that exhausted their retries; the api reports 5xx responses and crashes.
2. **Component status:** `GET /statusz` (public, coarse, cached 30 s) returns 503 when the database, worker, backups or job queues are stale or failing.
3. **External uptime probe (owner, Cloudflare Workers free plan):** `infra/cloudflare/uptime-worker` runs on a 5-minute cron outside Northflank, probes the web app, the Pages→API proxy, `/healthz` and `/statusz`, and alerts after 2 consecutive failures. It has no route and no workers.dev URL, and writes its one KV key only when a check changes state.
   ```sh
   cd infra/cloudflare/uptime-worker
   npx wrangler@4.147.0 kv namespace create futuregrow-uptime-state   # paste the id into wrangler.toml
   npx wrangler@4.147.0 secret put ALERT_WEBHOOK_URL
   npx wrangler@4.147.0 deploy
   ```
4. **AI spend limits:** `FG_TENANT_AI_MONTHLY_LIMIT_USD` sets a platform default per tenant per calendar month (UTC, USD at model-registry prices). A tenant overrides it in the autonomy policy with `"aiSpend": { "monthlyLimitUsd": 25, "warnAtFraction": 0.8 }`. Every model attempt is checked first; over the limit the agent abstains (`BUDGET_EXCEEDED`) and a critical alert is raised. While a limit applies, models without a registry price are refused (`BUDGET_UNMEASURABLE`). Governance → *AI spending this month* shows the position.
5. **Provider API lifecycle:** the worker's `api_lifecycle` cron (hourly) alerts at 90, 30 and 7 days before a configured API version's or approved model's sunset, and the policy rule `API_VERSION_SUNSET` blocks actions on a version past its sunset. Shopify dates are derived from its 12-month support policy and Google Ads dates from its published sunset timetable (`GOOGLE_ADS_SUNSET_MONTHS` in `packages/connectors/src/deprecations.ts`, first day of the published month; update it when Google adds versions). Meta Graph publishes per-version dates in its changelog (v26.0: "TBD" as of 2026-10-21), so a platform admin records them once published:
   ```sh
   curl -fsS -X PUT https://api.<domain>/v1/platform/api-lifecycle -H 'content-type: application/json' -H 'idempotency-key: sunset-meta-v26.0' -H 'cookie: <admin session>' \
     -d '{"provider":"meta","apiVersion":"v26.0","sunsetAt":"<published date, ISO 8601>","sourceUrl":"<provider changelog URL>"}'
   ```
   Deprecation and sunset headers seen on live provider responses are recorded and shown in Governance → *Provider API lifecycle*.
