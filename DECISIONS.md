# FUTUREGROW AI — Architecture Decision Log

Source documents:

- `01_PRODUCT_MASTER_PLAN.md.md` (Product Master Blueprint v2.0) — **authoritative for features, module scope, compliance, safety and acceptance criteria.**
- `02_FINAL_TECH_STACK.md.md` (Final Validated Tech Stack) — **authoritative for implementation architecture, runtimes, topology and infrastructure limits.**

Precedence rule (D-000): when the two documents disagree, feature/compliance requirements come from the product plan and implementation mechanics come from the tech stack. When they disagree on a *verifiable external fact*, the current primary source wins and the check is recorded here.

Each decision lists: context → decision → consequences. `[U]` marks values the documents leave unspecified; FUTUREGROW never invents them.

---

## D-001 — Orchestration runtime: deterministic Agent Kernel, not LangGraph/Swarm

- **Conflict:** Product plan prefers LangGraph (`OS-LG`) for M07/M23. Tech stack states LangGraph/LangChain/Mastra/CrewAI are *not* part of the v1 critical path and mandates a custom typed Agent Kernel.
- **Decision:** Implement the Agent Kernel in TypeScript (`packages/agent-kernel`) with durable state in PostgreSQL and durable execution via Graphile Worker. Logical roles (Observer → Researcher → Strategist → Creator → Experimenter → Publisher → Optimizer → Verifier) are pipeline stages in one runtime. OpenAI Swarm is excluded (both documents agree).
- **Why this satisfies the product plan:** the plan chose LangGraph for *stateful, durable, human-in-the-loop* execution. Those properties are provided by the persisted execution state machine (D-011), Graphile Worker retries/crash recovery, and the approval workflow. The kernel exposes an `AgentRuntime` interface so LangGraph can be added later without touching the security model.

## D-002 — Model gateway: provider-neutral, in-process, license-gated

- **Conflict:** Product plan lists Qwen3 + vLLM (self-hosted) or a managed frontier model behind a provider-neutral gateway. Tech stack forbids a separate LiteLLM gateway service and has no GPU capacity.
- **Decision:** The gateway lives inside `packages/agent-kernel`. Adapters: Anthropic Messages API (default managed provider) and an OpenAI-compatible adapter (covers self-hosted vLLM/Qwen3 later). Every model must exist in the `model_registry` with `approved_for_production=true` before it can be called; there is **no silent fallback** to an unapproved model. Default registered models are Claude 5 family IDs (`claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`) seeded as **not approved** — a tenant admin must approve after vendor contract review (product plan `COMMERCIAL` row).
- **Consequence:** With no API key or no approved model, LLM-dependent steps abstain with an explicit `MODEL_UNAVAILABLE` reason. Deterministic engines (policy, maths, verification) keep working.

## D-003 — Google Ads authentication (verified fact conflict)

- **Conflict:** Tech stack says Google Ads requires "OAuth 2.0 plus a developer token". Product plan says developer tokens were sunset on 2026-09-09 and access levels moved to Google Cloud projects.
- **Verification (2026-10-19):** Current reporting of Google's documentation confirms the sunset on 2026-09-09; sending the token is optional and ignored, and access level follows the Cloud project used for OAuth credentials. Latest major API version is v26 (2026-10-15).
- **Decision:** Connector authenticates with OAuth 2.0 only; `developer-token` header is sent only if explicitly configured (legacy compatibility). API version is configuration (`GOOGLE_ADS_API_VERSION`, default `v26`) and is recorded in the capability registry; unsupported/unknown versions are denied.

## D-004 — Media-mix modelling: native Bayesian MMM in the Python analytics job

- **Conflict:** Product plan names Google Meridian (`OS-MER`, TensorFlow Probability/JAX, GPU recommended). Tech stack budgets a light Python job on 0.2–0.5 shared vCPU and 512 MB–1 GB.
- **Decision:** Implement the same model class natively (NumPy/SciPy): geometric adstock + Hill saturation, Bayesian regression sampled by MCMC with ≥4 chains, split-R̂ and ESS diagnostics, priors with provenance, experiment-calibrated ROI priors, posterior contribution/response curves and posterior budget scenarios. Causal language is suppressed when diagnostics fail. A Meridian adapter is an upgrade path documented as compute-blocked (BLOCKERS B-010).
- **Consequence:** Slower MCMC on sandbox CPU (throughput degradation, which the tech stack explicitly permits); statistical rigor is not reduced.

## D-005 — Generative media: Remotion + FFmpeg composition; ComfyUI/generative weights excluded from beta

- **Conflict:** Product plan names ComfyUI (`OS-CUI`, GPL-3.0, GPU) for M14/M15. Tech stack specifies a Remotion + FFmpeg media job and no GPU.
- **Decision:** `jobs/media` renders template compositions (product showcase, UGC-style captioned format, synthetic-persona format with mandatory disclosure overlay) from **owned/licensed uploaded assets** using Remotion and FFmpeg, then records hash, workflow config and rights manifest. Generative image/video/voice models are `[U]` (no vendor or approved weights) → blocked (B-011). Remotion is source-available, not OSI open source; rendering refuses to start until the tenant records its Remotion license eligibility (free-license eligibility or company license), enforced in code.

## D-006 — PostHog and Chatwoot are integrations, not hosted services

- **Conflict:** Product plan lists PostHog (`OS-PH`) and Chatwoot (`OS-CW`) as candidates. Hosting either would exceed the Northflank Sandbox allowance of 2 services / 2 jobs / 1 addon fixed by the tech stack.
- **Decision:** Product events, customer events and conversations are stored natively in PostgreSQL. Optional outbound connectors forward events to PostHog Cloud (capture API) and sync conversations with an external Chatwoot instance when credentials exist (B-007).

## D-007 — Retrieval: full-text search always, vectors when proven

- **Decision (tech stack wins):** Probe `pg_available_extensions` for `vector`. If present, enable pgvector; otherwise store embeddings as `real[]` and compute exact cosine in the application. Because Anthropic offers no embeddings endpoint and no embedding vendor is specified `[U]`, the always-available ranking is PostgreSQL full-text search (`tsvector`/`ts_rank_cd`); vector similarity is blended in only when an approved OpenAI-compatible embeddings endpoint is configured.

## D-008 — Tenant isolation: PostgreSQL RLS + application scoping

- **Decision:** Better Auth `organization` = tenant. Every tenant table carries `tenant_id` and has `ENABLE ROW LEVEL SECURITY` with policy `fg_tenant_isolation … TO fg_tenant USING/WITH CHECK (tenant_id = current_setting('app.tenant_id', true))`. Tenant work runs in a transaction that sets `app.tenant_id` and `SET LOCAL ROLE fg_tenant` (a `NOLOGIN` role without `BYPASSRLS`), so isolation does not depend on remembering a `WHERE` clause. `FORCE` is deliberately not used: the owner role is the explicit *system path* (`withSystem`, used only for cross-tenant queue scans and migrations), and tenant traffic never runs as the owner. Append-only tables additionally get SELECT/INSERT-only grants for `fg_tenant` and mutation-blocking triggers that apply to every role. A test asserts that **every** table with `tenant_id` has RLS and the policy.
- **Risk:** Whether the Northflank managed-PostgreSQL user may `CREATE ROLE` is `[U]`. Startup probes this; if the role cannot exist, the app refuses to start in `production` mode and logs the reason (B-004).

## D-009 — Events: transactional outbox + Graphile Worker; webhook inbox

- **Decision:** Domain state change and its event are written in one transaction to `outbox_events`; a `SECURITY DEFINER` trigger enqueues a Graphile Worker job in the same transaction (atomic, no dual-write). Inbound webhooks are signature-verified on the raw body, then inserted into `webhook_inbox` with a unique `(provider, provider_event_id)` constraint for deduplication. No Redis/Kafka/RabbitMQ (tech stack).

## D-010 — API mutation contract

- **Decision:** Every `POST/PUT/PATCH/DELETE` under `/v1` requires an `Idempotency-Key` header. Keys are stored per tenant with a request hash; a replay returns the stored response; same key with a different body returns `422`. Schemas are Zod, exported as OpenAPI 3.1 at `/v1/openapi.json`.

## D-011 — Execution state machine (product plan, extended)

- **Decision:** States exactly as the product plan: `PROPOSED → EVIDENCE_READY → POLICY_CHECKED → APPROVAL_REQUIRED | APPROVED → PREFLIGHT_VERIFIED → EXECUTING → EXECUTED_UNVERIFIED → VERIFIED | FAILED | ROLLBACK_REQUIRED → ROLLED_BACK | ESCALATED`. Added terminal states required for completeness: `DENIED` (policy), `REJECTED` (human), `CANCELLED` (kill switch / expiry). Transitions are enforced in code **and** by a database trigger; the trigger also refuses `VERIFIED` unless an `execution_proofs` row with verdict `VERIFIED` exists. There is no `SUCCESS` state.

## D-012 — Unspecified business thresholds `[U]`

- **Decision:** No λ values, KPI targets, spend ceilings, frequency caps, quiet hours, calibration gates or approval thresholds are invented. Until a tenant configures its policy:
  - every write action resolves to `REQUIRE_APPROVAL` (never pre-authorized);
  - auto-spend ceiling is 0;
  - Growth Brain utility is reported as `UNSCORED_LAMBDAS_UNCONFIGURED` and the decision requires approval;
  - forecast deployment gates fall back to the baseline model and flag `gate_unconfigured`;
  - lifecycle sends are blocked until frequency caps/quiet hours and sender postal address exist.

## D-013 — Frontend ↔ API authentication across domains

- **Decision:** Recommended deployment uses one registrable domain (`app.<domain>` on Pages, `api.<domain>` on Northflank) so session cookies are same-site (`SameSite=Lax`, `Secure`, `HttpOnly`). Fallback when no custom domain exists: a minimal Cloudflare Pages Function proxies `/api/*` to Northflank so cookies are first-party on `*.pages.dev`. The proxy consumes Workers quota (acceptable for a controlled beta, documented in RUNBOOK).

## D-014 — Package manager and build

- **Decision:** npm workspaces (pnpm is not installed; enabling it via corepack would alter the global Node install). TypeScript (strict), ESM, Node 24 LTS, Vitest, Biome for lint/format, esbuild bundles for container images.

## D-015 — Module-to-code mapping

- **Decision:** The tech stack repo contract lists infrastructure packages only. Module domain services live in `packages/core/src/modules/mNN-*` (one folder per product-plan module, all 24 kept), consumed by `apps/api` (HTTP) and `apps/worker` (jobs). See `docs/ARCHITECTURE.md` for the full map.

## D-016 — Analytics job execution model

- **Decision:** `jobs/analytics` (Python 3.13, NumPy/SciPy/psycopg) runs as a Northflank cron job that drains `analytics_requests` using `FOR UPDATE SKIP LOCKED`, writes results, and emits outbox events. An optional immediate trigger calls the Northflank job-run API when a token is configured. Same model for `jobs/media` and `render_jobs`.

## D-017 — Local verification without Docker

- **Decision:** Tests use real PostgreSQL 17 binaries via `embedded-postgres` and a portable Python 3.13 in `.tools/` (gitignored). No in-memory database substitutes for PostgreSQL semantics (RLS, triggers, `SKIP LOCKED`).

## D-018 — Messaging vendor adapter

- **Decision:** Email delivery adapter targets the Resend REST API because it provides read-after-write status (`GET /emails/{id}`) needed for verification. Vendor choice remains subject to contract/data-processing review (product plan `COMMERCIAL`), tracked as B-008. SMS/WhatsApp/push vendors are `[U]` and their action types are registered as unsupported (deny).

## D-019 — Competitor intelligence collection

- **Decision:** Collector fetches only URLs on a tenant-approved lawful-source allowlist, honours `robots.txt`, rate-limits per host, blocks private/loopback/link-local addresses after DNS resolution (SSRF guard), caps size/time, stores snapshots in object storage with SHA-256, and diffs successive snapshots. REA analysis jobs can be registered only with an authorization record (`legal_approved=true`, ownership/licence attestation, approver identity); execution is blocked because no isolated malware-safe sandbox exists in the Sandbox tier (B-012).

## D-020 — Approvals bind to the exact action

- **Decision:** An approval stores the SHA-256 of the canonical action payload. Any change to the payload invalidates the approval. Approvers need the required role and an MFA-enabled account; the proposer cannot approve their own high-risk action.

## D-021 — Kill switches

- **Decision:** Scopes: `system`, `tenant`, `connector`, `object` (campaign/post/journey), `model`, `agent`. Checked at preflight and immediately before the provider call; engaging a switch cancels queued actions in scope.

## D-022 — Local storage backend

- **Decision:** `packages/storage` implements Cloudflare R2 (S3 API, SigV4) for staging/production and a filesystem backend for local development and tests. `NODE_ENV=production` refuses the filesystem backend.

## D-023 — Autonomous execution requires evidence with a declared freshness SLA

- **Context:** The evidence object has `freshness_status: current|stale|unknown`. Without an SLA, freshness cannot be computed and is `unknown`.
- **Decision:** Agent/system-proposed actions require every cited evidence record to be `admitted`, `current` (derived at read time from `freshness_sla_hours`), permitted for `autonomous_execution`, and not prohibited for it. Evidence with unknown freshness can still support *human* proposals, which then always require approval.
- **Consequence:** Producers of evidence intended to drive automation must declare a freshness SLA; this is enforced by the policy engine, not by convention.

## D-024 — Model routing and refusal fallbacks

- **Default model:** every reasoning purpose (planning, critique, generation, extraction) routes to `claude-opus-5-5`; no automatic downgrade to cheaper models for cost. Adaptive thinking is always on for this model (the `thinking` parameter is omitted); depth is controlled with `output_config.effort` set explicitly per purpose (its default is `medium`).
- **Structured output:** responses are constrained with `output_config.format` (Zod schema via the SDK's `betaZodOutputFormat`) and re-validated with the full FUTUREGROW Zod contract; forced `tool_choice` is not used (rejected by this model).
- **Refusal fallbacks vs. the licence gate:** the vendor recommends server-side `fallbacks: "default"`, but that lets the server pick a model that is not in FUTUREGROW's registry, which the product plan forbids ("never silently switch to an unapproved-licence model"). Decision: send `fallbacks` only as an explicit list of models that are registered **and approved** with purpose `fallback`; when none are approved, no fallback is sent and a refusal makes the step abstain. Every response's served-by model is checked against the approved registry before its output is used.

## D-025 — Lifecycle journeys send as system proposals backed by trigger evidence

- **Context:** Journeys (M20) send without a human in the loop for each message, but system/agent proposals must cite current evidence permitted for autonomous execution (D-023).
- **Decision:** Each enrollment admits pseudonymous first-party evidence (the trigger event) with the journey's declared `evidence_freshness_hours` (1–720, default 168), set by the designer and approved when a different person activates the journey. Every send is a separate `email.send` action proposed by `system:journey:<id>`. Consent, suppression, frequency cap, quiet hours, sender identity (CAN-SPAM) and jurisdiction are evaluated at proposal and re-evaluated at preflight in the same transaction as rendering, immediately before the provider call. Whether sends run unattended depends only on the tenant's `MESSAGING` policy (`pre_authorized_within_limits` with `maxAudienceSize`); otherwise every send waits for approval.
- **Consequence:** Next-best-message selection uses an M10 experiment (`send_experiment` step) so allocation is measurable; there is no opaque model-chosen messaging. DSAR deletion expires the trigger evidence, which stops further sends for that profile.

## D-026 — Parameter resolution happens before any reservation or send

- **Decision:** The M23 gateway calls module resolvers (email rendering, presigned media URLs) inside a savepoint before budget reservation and before the `PREFLIGHT_VERIFIED → EXECUTING` transitions. A resolution error moves `APPROVED → FAILED` with "nothing was sent". During verification a failing resolver falls back to stored params (verification reads provider state by receipt).

## D-027 — Spend reconciliation envelope

- **Decision:** The authorized envelope for a campaign-day is the daily budget in effect at the end of that UTC day, from append-only `ad_budget_history` (sync observations, verified M23 actions, and external changes, which also raise a drift alert). Only days older than `SETTLEMENT_LAG_DAYS = 3` enter the append-only spend ledger; restated settled days raise an alert rather than editing the ledger. A period is a discrepancy when spend on known-budget days exceeds the envelope by more than the tolerance (default 2 %), when a single day exceeds 2× its budget (Google Ads' documented overdelivery cap), or currencies disagree. Spend on days with no known budget makes the result `insufficient_data`, never `ok`.

## D-028 — Retrieval for conversational questions

- **Decision:** Chat (M21) and social replies (M16) query the knowledge base with OR semantics over stemmed terms (`to_tsquery('simple', …)` built from `plainto_tsquery('english', …)`), ranked by `ts_rank_cd`; document search elsewhere keeps AND semantics. Answers are released only if every citation resolves to a retrieved public excerpt, confidence ≥ 0.6, claim/brand lint passes, no commitment (refund, discount, guarantee, delivery date) appears unless the cited excerpt states it, and the customer message shows no injection markers; otherwise the conversation is handed to a human and the AI stops replying in it.

## D-029 — Embedded Postgres clusters are initialised as UTF-8

- **Context:** On Windows, `initdb` defaults to the WIN1252 code page, which rejected non-ASCII text (e.g. "→" in alert messages) that production (UTF-8) accepts.
- **Decision:** Test and dev clusters are created with `--encoding=UTF8 --locale=C` and databases with `encoding 'UTF8' template template0`, matching managed Postgres.

## D-030 — Encrypted logical backups with verification and restore drills

- **Context:** The tech stack assigns backup verification to the analytics job and backups to R2. The Northflank Sandbox Postgres addon's native backup capabilities are tier-dependent `[U]`, and no `pg_dump` binary ships with the runtime images.
- **Decision:** `python -m futuregrow_analytics.backup create` exports every public table from one `REPEATABLE READ, READ ONLY` snapshot via `COPY … (FORMAT csv, HEADER)` (generated columns excluded), gzip + AES-256-GCM per table (key `FG_BACKUP_KEY`, AAD binds archive key and table), into a tar with a plaintext manifest of migration hashes, row counts and member hashes; archive + sidecar manifest go to R2 (SigV4 implemented in Python and cross-checked against the AWS vector and aws4fetch). `verify` checks hashes, decrypts and counts every member; `verify --restore-into` performs a restore drill into an empty database migrated by the same release (user triggers disabled during load, FK order, sequences advanced, migration-owned reference tables skipped), and every run is recorded in the platform-only `backup_runs` table. `backup_verification` is not a tenant analytics request.
- **Consequence:** Restores need the same migrations and an empty target; the backup key must be stored separately from R2 credentials (losing it makes backups unreadable). Managed addon backups, where available, remain the primary point-in-time mechanism; these logical backups are the provider-independent copy.

## D-031 — Invite-only onboarding without outbound email

- **Context:** Disabling Better Auth sign-up entirely made invitations unusable (an invitee could not create the account needed to accept). No platform email provider is configured for the beta (B-008).
- **Decision:** Sign-up stays enabled at the Better Auth level but a `user.create.before` database hook refuses account creation unless `FG_ALLOW_SIGNUP` is set or a pending, unexpired invitation exists for the address (case-insensitive). Owners/admins create invitations in Account & security; the control plane shows the `/invite?id=…` link to share out of band. Accepting requires the invitation id and the matching email; Better Auth's per-IP sign-up throttling stays on.
- **Consequence:** A person who knows a pending invitee's address could pre-register that address but cannot join the organization without the invitation id; the inviter cancels and re-invites. Email verification of invitees is added when an email provider is approved.
