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
