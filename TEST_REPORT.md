# FUTUREGROW AI — Test report

Date: 2026-10-20 · Commit: see `git log -1` · Environment: Windows 11, Node 24.22.0, npm 12.2, Python 3.13.16, embedded PostgreSQL 17.10 (UTF-8 cluster).

## 1. Results

RESULTS_TABLE

## 2. How the system is tested

* **Real PostgreSQL, not mocks.** `test/global-setup.ts` starts an embedded PostgreSQL 17 cluster (UTF-8, D-029), applies every migration once to a template database, and each test file clones its own database. RLS, triggers, the outbox, Graphile Worker schema and the audit chain are the production ones.
* **Provider APIs** are exercised against a programmable local HTTP fixture server that records every request. Tests assert the exact requests (paths, headers such as `Idempotency-Key` and `List-Unsubscribe`, bodies) and drive the responses, including failures, ambiguity and read-back mismatches. **No live provider was called**; live validation is blocked (B-005…B-009).
* **Models** are replaced by scripted providers behind the real model gateway (registry gating, schema validation, secret scanning, cost recording). The red-team suite scripts the model to *comply* with attacks to prove the deterministic controls hold. The Anthropic adapter is tested against a fixture endpoint with the official SDK.
* **Python engines** run under pytest; the cross-language test spawns the real analytics job against the test database.
* **Media**: two real Remotion renders (Chrome Headless Shell + FFmpeg) produce an H.264 MP4 checked for dimensions, duration, hash and inherited rights; the prebuilt-bundle path used by the container image was also rendered.
* **Production artifacts**: the esbuild bundles were booted against PostgreSQL (API health/readiness/OpenAPI and 401 on `/v1`; worker task registration; bundled migrate/probe), the web app was built, and the SBOM licence policy was run.

## 3. Coverage by module

| Area | What the tests prove | Files |
|---|---|---|
| M01 Evidence | Required provenance fields, quarantine of unresolved rights/PII, freshness, lineage; evidence-integrity DB guards | `packages/db/test`, `packages/core/test/data-modules`, all module tests (evidence admitted for every automated input) |
| M02 Customer 360 | Deterministic identity resolution + explainable merges, PII scrubbing, consent ordering, suppression semantics, DSAR access/delete/opt-out propagation, retention with legal hold and floors | `data-modules`, `retention`, `channels-retention` |
| M03 Knowledge | Versioned facts and conflicts, claim lifecycle, copy lint, hybrid retrieval, OR retrieval for conversations, injection screening | `data-modules`, `channels-retention`, `redteam` |
| M04–M07 | Lawful competitor collection (robots, SSRF, legal approval with MFA), literal-quote guard, REA gate, idea ranking, Brain decisions only via M23, abstention | `intelligence`, `redteam` |
| M08–M11 | Forecast backtests vs baselines + conformal intervals, MMM convergence gates, experiment ordering/SRM/Thompson, segments with consent/suppression, propensity with feature policy, calibration and PSI drift gating | `jobs/analytics/tests`, `analytics-job`, `audiences`, `experiments` |
| M12–M15 | Margin/inventory guardrails, dark-pattern blocking, evidence-mapped briefs, asset QA + rights manifests + publish eligibility, Remotion licence gate, persona likeness/testimonial rules | `creation`, `jobs/media/test` |
| M16 Social | Anti-spam spacing and dedup, publish via M23 with verified-only status, webhook ingestion once, moderation/escalation, grounded reply drafts | `channels-acquisition` |
| M17 Paid | Campaign/budget sync with external-change drift, settled-day ledger and restatement alerts, reconciliation rules, budget proposals with reservations, spend ceilings | `channels-acquisition`, `execution` |
| M18 SEO/ASO | Robots-honouring crawl, issue detection, AI-crawler report, RFC 9309 refusal on 5xx robots, store limits (bytes vs chars), Play title policy, four-eyes listing approval, ASC baseline read | `channels-acquisition` |
| M19 App growth | Referrer minimisation, consent-gated linking, labelled attribution, cohorts marked non-causal, Apple report summarisation | `channels-acquisition` |
| M20 Lifecycle | Template safety, CAN-SPAM footer, escaping, signed unsubscribe tokens, evidence-backed journeys pre-authorized by policy, rendering at the execution boundary, verified delivery, goal exit, one-click unsubscribe → next send denied, bounce webhooks → suppression, consent denial | `channels-retention`, `public-channels` |
| M21 Conversations | Origin-checked widgets and per-widget CORS, PII redaction before the model, citations resolvable, handoff on missing knowledge / bad citations / unsupported commitments / model outage / injection, human takeover | `channels-retention`, `public-channels`, `redteam` |
| M22 Creators | Evidence-backed contracts with disclosure, sentiment-conditioned terms rejected, hashed clicks + velocity flag, Shopify attribution, proportional clawback, self-referral, refund window, payouts denied (B-015), conspicuous-disclosure check | `channels-retention`, `public-channels` |
| M23 Execution | Allowlist, state machine enforced by DB triggers, approvals bound to hash with separation of duties and MFA, preflight re-evaluation, resolver-before-send, idempotent replays, ambiguous → escalation, rollback, kill switches before send, budget reservations | `execution`, `db`, `policies`, `redteam` |
| M24 Governance | Hash-chained audit + tamper detection, registries, alerts/incidents, cost ledger, backups (encrypted, verified, restore drill), credential key rotation, SBOM licence policy | `db`, `backup-job`, `secrets-rotation`, `scripts/sbom.mjs` |
| API / auth | Better Auth sessions + TOTP, tenant resolution, Idempotency-Key contract, MFA gates, webhooks with signatures, invite-only onboarding | `apps/api/test` |
| Web control plane | Every UI call maps to a registered route and method (with negative controls); all 24 modules reachable; Pages proxy header hygiene and cookie re-scoping | `apps/web/test` |
| Security (FG-P1-005) | Allowlist escape, self-approval, approval replay, destination smuggling, secret exfiltration, log redaction, fence closing, poisoned retrieval, customer injection, planted facts, SSRF/DNS rebinding, cross-tenant retrieval, agent kill switch | `test/redteam` |

## 4. Not verified here (and why)

| Gap | Reason | Mitigation / next step |
|---|---|---|
| Live provider APIs (Meta, Google Ads, TikTok, YouTube, Shopify, App Store Connect, Resend, Search Console, Chatwoot) | No credentials / app reviews (B-005…B-009) | Fixture contract tests; enable one provider at a time in the beta with approval-required policy |
| Live model calls | No API key / vendor review (B-003) | Scripted providers through the real gateway; SDK request shape tested against a fixture |
| Container image builds | No Docker/Podman here (B-016) | Bundles booted locally; CI `images` job builds all four |
| Browser click-through of the control plane | No browser automation here (B-017) | Route-contract + build + API tests; add Playwright in CI |
| CI pipeline execution | No Git remote (B-018) | Owner pushes; the workflow mirrors the local commands in §1 |
| Northflank template import | No account (B-001) | Review in the Northflank editor before running |
| pgvector path | Not available in the embedded build (B-004) | Exact-cosine fallback is the tested path |
| Load, failover and DR timing (P2) | Out of scope for the beta; RTO/RPO `[U]` | Restore drill procedure in RUNBOOK §9 |

## 5. Known warnings

* `npm audit`: 4 moderate findings, all in `drizzle-kit`'s development-only dependency on `esbuild <= 0.24.2` (dev-server CORS issue). Not present in any runtime bundle or image.
* Biome reports warnings only (mostly `noExplicitAny` in tests and optional-chain suggestions); zero errors.
* The Remotion compositor logs "Executable file detection not yet supported on win32" on Windows; renders succeed.
