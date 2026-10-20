# FUTUREGROW AI — Build Progress

Status legend: ☐ not started · ◐ in progress · ☑ done and tested · ⛔ externally blocked (see BLOCKERS.md)

## Phased implementation plan

The sequence follows the product plan's P0 gates (evidence, policy, capability/licence registries, consent, execution state machine, idempotency, verification) **before** autonomous intelligence, and the tech stack's rule of taking one connector through `read → propose → approve → execute → verify → learn` before adding more networks.

| Milestone | Scope | Product-plan gates |
|---|---|---|
| **M0 Foundation** | Repo, toolchain, decisions, blockers, test harness (real PostgreSQL 17, portable Python). | FG-P0-001 |
| **M1 Data core** | Contracts (Zod), Drizzle schema for all 24 modules, migrations, RLS tenant isolation, immutable hash-chained audit, idempotency store, outbox/inbox. | FG-P0-002 (schema), FG-P0-007 (state machine in DB) |
| **M2 Platform** | Fastify API, Better Auth (orgs, RBAC, MFA), Idempotency-Key middleware, OpenAPI, Graphile Worker, event dispatch, webhook ingestion. | — |
| **M3 Governance & execution** | Policy engine, action-risk matrix, capability registry, model/asset licence registry, kill switches, budget reservation + spend ledger, M23 gateway, M24 verification/rollback, first connector end-to-end. | FG-P0-003, -004, -005, -007, -008 |
| **M4 Data modules** | M01 Evidence, M02 Customer 360 + consent/suppression/DSAR, M03 Knowledge graph + claims + retrieval. | FG-P0-002, FG-P0-006 |
| **M5 Mathematical engines** | Python analytics job: forecasting + backtests + conformal intervals (M08), Bayesian MMM (M09), experiments/bandits (M10), trends (M04), propensity (M11). TS experiment library. | FG-P1-001, FG-P1-002 |
| **M6 Intelligence** | M04, M05 (lawful collector, REA gate), M06 Idea Lab, M07 Growth Brain + Agent Kernel. | FG-P1-003, FG-P1-006 |
| **M7 Strategy & creation** | M11, M12, M13, M14 (Remotion media job), M15. | FG-P1-004 |
| **M8 Channels** | M16–M22 + connectors. | — |
| **M9 Web control plane** | Astro + React dashboard for all modules, approvals, kill switches, audit. | — |
| **M10 Hardening & deploy** | Red-team suite, SBOM, CI, Dockerfiles, Northflank/Cloudflare config, test report, deployment guide. | FG-P1-005, FG-P2-001 (partial) |

## Milestone log

### M0 Foundation — ☑
- [x] Read both source documents; conflict analysis → `DECISIONS.md` (D-000…D-023).
- [x] Verified Google Ads developer-token sunset (D-003); Meta Graph v26.0, Shopify 2026-10, Google Ads v26 defaults.
- [x] Git repository initialised (work on branch `build/futuregrow-v1`).
- [x] Portable Python 3.13.16 in `.tools/` (gitignored).
- [x] npm workspaces; TypeScript 7, Vitest 5, Biome, Drizzle Kit.
- [x] Embedded PostgreSQL 17.10 harness (no pgvector locally → exact-cosine fallback path is the one exercised).

### M1 Data core — ☑
- [x] Contracts (Zod): evidence, growth decision, action request, policy decision (approval groups), proof, capability, model artifact, event envelope, tenant policy; 24-module registry (test-enforced).
- [x] Drizzle schema for all 24 modules (~95 tables) + Better Auth 1.7 tables.
- [x] Security migrations: RLS role `fg_tenant` + policy on every tenant table (test-enforced), append-only triggers, DB-enforced state machine (VERIFIED needs a postcondition proof, ROLLED_BACK a rollback proof, APPROVED a hash-bound approval), outbox→Graphile trigger, experiment logging order, evidence immutability.
- [x] Hash-chained audit with tamper/truncation detection; idempotency store.

### M3 Governance & execution — ☑ (M2 API/worker next)
- [x] Policy engine `fg-policy-1.0.0` (16 tests): allowlist, kill switches, capability/scope, evidence trust (D-023), children/sensitive blocks, jurisdiction→legal, claims, persona/endorsement disclosure, assets, messaging consent/suppression/CAN-SPAM/frequency, TikTok audit, spend ceilings; separation-of-duties approval groups.
- [x] Connectors (36 contract tests vs. local fixture): Meta (Pages post/reply, Instagram, campaign budget/status, insights), Google Ads (OAuth-only, validateOnly), TikTok Direct Post, YouTube resumable upload, Shopify discount (`context`), App Store Connect (ES256 JWT, localizations, sales reports), Resend; SSRF guard, robots.txt, webhook signatures, failure-phase classification. ⛔ live validation (B-005, B-006, B-008, B-009).
- [x] M23 gateway + M24 verification/rollback/escalation, budget reservations, rate limiting, kill switches, incidents, registries, encrypted credentials, connector health (12 end-to-end tests incl. the Facebook-post vertical slice).
- [x] M01 evidence admission/quarantine/release/lineage/freshness sweep.

**Test status:** 89/89 passing (contracts, db, policies, connectors, core).

### M2 Platform — ☑
- [x] Fastify API: Better Auth (email/password, TOTP 2FA, organizations), tenant/role resolution, Idempotency-Key contract, OpenAPI 3.1, health/ready, rate limits, CORS; signed webhook inbox (Meta, Shopify, Resend/Svix, TikTok).
- [x] Graphile worker: outbox dispatch, execute/verify with reschedule, webhooks, watchdog, sweeps, module crons.
- [x] Real-process smoke test: API + worker booted against a persistent dev PostgreSQL.

### M4 Data modules — ☑
- [x] M02 ingestion keys, deterministic identity resolution, PII scrubbing, consent ordering, suppression semantics, DSAR access (via M23)/delete (propagation + exemptions)/opt-out.
- [x] M03 versioned facts + conflicts, claim registry, brand rules, copy lint, hybrid retrieval.

### M5 Mathematical engines — ☑
- [x] Python job: forecasting (conformal, backtests, gates), Bayesian MMM (NUTS, dense metric, R-hat/ESS, experiment priors), experiments/bandits, trends/topics, propensity. 24 pytest tests; cross-language integration test.
- [x] Experiments lifecycle (start via M23), segments with consent/suppression at materialisation.

### M6 Intelligence — ☑
- [x] Agent kernel (registry-gated gateway, Anthropic SDK adapter, OpenAI-compatible adapter, prompts, safety utils).
- [x] M05 lawful collection + REA gate, M06 Idea Lab, M07 Growth Brain (decisions -> M23 only).

### M7 Strategy & creation — ☑
- [x] M12 offers/CRO, M13 briefs, M14 assets + Remotion media job (real render test), M15 personas.

**Test status:** 154/154 TS tests + 24/24 Python tests passing.

### M8 Channels — ☑
- [x] M16 organic social: scheduling with anti-spam spacing/dedup, publish through M23 (status set only on VERIFIED), Meta comment webhooks, moderation/escalation, grounded reply drafts, policy-gated replies.
- [x] M17 paid media: campaign/spend sync, append-only budget history with external-change alerts, settled-day spend ledger with restatement alerts, spend reconciliation (D-027), budget/status proposals with reservations.
- [x] M18 SEO/ASO/AI discovery: robots.txt-honouring technical audit (issues, duplicates, broken links, AI crawler access, llms.txt), Search Console sync, keyword upload, striking-distance heuristic, store-metadata validation, App Store localization pushes via M23. Google Play writes remain blocked (B-009).
- [x] M19 app growth: install-referrer minimisation, labelled attribution methods, consent-gated profile links, App Store sales reports as evidence, weekly cohorts (activation/retention) marked non-causal.
- [x] M20 lifecycle: templates (variable allow-list, HTML safety, CAN-SPAM footer), four-eyes approval, evidence-backed journeys (D-025) with wait/exit/experiment steps, RFC 8058 one-click unsubscribe, Resend bounce/complaint webhooks → suppression.
- [x] M21 conversations: widgets with per-widget CORS, PII-redacted grounded answers with resolvable citations, deterministic answer validation, handoff + tickets + leads, optional Chatwoot mirror.
- [x] M22 creators: evidence-backed contracts with mandatory disclosure, referral redirects with hashed clicks, Shopify order/refund attribution, accrual + proportional clawback, fraud flags, conspicuous-disclosure check; payouts denied by policy (B-015).
- [x] Worker crons: social_dispatch, journey_tick, ads_sync, spend_reconcile, search_console_sync, app_store_sales_sync; on-demand seo_audit.

**Test status:** 188/188 TS tests + 24/24 Python tests passing.

### M9 Web control plane — ☑
- [x] Astro 7 + React islands, static build for Cloudflare Pages; hashed-CSP `_headers` generated after build.
- [x] Bespoke screens: overview, hash-bound approvals (policy reasons, approval groups, proofs, state history, cancel), governance (kill switches, versioned autonomy policy, sender identity, alerts, incidents, model/artifact/capability registries, cost), audit-chain verification, account security (TOTP enrolment, organizations, members and invitations), asset upload with rights declarations, invitation acceptance page.
- [x] Catalog-driven sections for all 24 modules (lists, JSON create forms validated server-side, row actions, detail drawers); a contract test proves every UI call maps to a registered API route and method.
- [x] Pages Functions proxy for `/v1` and `/api/auth` (D-013) with client-IP hygiene and cookie re-scoping.
- ⛔ Browser click-through automation not available here (B-017).

### M10 Hardening & deploy — ☑ (deployment execution ⛔ B-001/B-002/B-016/B-018)
- [x] FG-P1-005 red-team suite (16 scenarios, models scripted to comply with attacks); retrieved-excerpt injection screening; broader secret detection.
- [x] Encrypted logical backups to R2 with verification and restore drills, run by the analytics cron job (D-030); credential key re-encryption CLI.
- [x] Retention policies enforced daily (FG-P0-006); PSI drift gate for propensity scores (D-032); invite-only onboarding that works without email (D-031).
- [x] Production bundles (`scripts/build.mjs`) booted against PostgreSQL; Dockerfiles for api/worker, media job (prebuilt Remotion bundle, browser baked in) and analytics job, base images pinned by digest.
- [x] CI workflow (typecheck, lint, generated-docs drift, real-PG tests, pytest, render, builds, SBOM, image builds; actions pinned by SHA); CycloneDX SBOM with licence policy.
- [x] Northflank template, Pages `wrangler.toml`, R2 CORS; `.env.example`; docs: ARCHITECTURE, RUNBOOK, DEPLOYMENT, generated MODULES / EVENT_TAXONOMY / CONNECTOR_CAPABILITIES / POLICY_MATRIX; TEST_REPORT.
- Partial (P2): provider failover and API-deprecation monitoring are not automated; cost is recorded per tenant (cost ledger, summary) but no tenant model-spend cap is enforced yet.

**Test status (final, commit 9e7b651):** 220/220 TS tests (25 files, real PostgreSQL, real renders) + 30/30 Python tests; typecheck, lint, docs drift, bundles, web build and SBOM policy all pass. See TEST_REPORT.md.

## Completion summary

All 24 modules are implemented and tested against real PostgreSQL with provider APIs exercised through fixture servers. Every P0 gate (FG-P0-001…008) and P1 item (FG-P1-001…006) is implemented and verified. What remains is external: live credentials and app reviews, account setup on Northflank/Cloudflare, legal rule packs, vendor reviews and the payout provider — each listed with its unblock step in BLOCKERS.md (B-001…B-018). Deployment steps: DEPLOYMENT.md; operations: docs/RUNBOOK.md.
