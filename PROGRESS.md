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

### M0 Foundation — ◐
- [x] Read both source documents; conflict analysis → `DECISIONS.md` (D-000…D-022).
- [x] Verified Google Ads developer-token sunset (D-003).
- [x] Git repository initialised.
- [x] Portable Python 3.13.16 in `.tools/` (gitignored).
- [ ] Workspace scaffold + dependency install.
- [ ] Embedded PostgreSQL 17 harness verified.
