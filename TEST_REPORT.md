# FUTUREGROW AI — Test report

Date: 2026-10-30 · Commit: see `git log -1` · Environment: Windows 11 (8 GB RAM), Node 24.22.0, npm 12.2, Python 3.13.16, embedded PostgreSQL 17.10 (UTF-8 cluster), Playwright 1.63.0 Chromium.

## 1. Results

### 1.0 Guided control plane (2026-10-30)

Raw JSON forms replaced by guided forms across all 24 modules, the Stage 4 ground-truth workflow, a guided autonomy-policy editor, three read-only list routes (`GET /v1/knowledge/brand-rules`, `GET /v1/knowledge/documents`, `GET /v1/evidence/sources`). Checks run, in sequence:

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **pass** |
| Lint | `npm run lint` | **pass** — 0 errors, 69 warnings (71 before the change) |
| Generated docs current | `npm run docs -- --check` | **pass** |
| TypeScript tests | `npm test` | **315 / 315 passed**, 37 files, 217 s |
| Python engine, backup and TLS tests | `npm run test:py` | **36 / 36 passed**, 334 s |
| Production bundles | `node scripts/build.mjs all` | **pass** — api, worker, media |
| Web control plane | `npm run build -w @futuregrow/web` | **pass** — 28 pages, `_headers` with 2 script + 1 style hashes |
| SBOM + licence policy | `npm run sbom` | **pass** — 0 violations |
| Browser E2E (Chromium, CSP enforced) | `npm run test:e2e` | **8 / 8 passed**, 3.2 min |

New tests: `apps/web/test/forms.test.ts` (form bodies, client checks, plain-language server errors, evidence readiness), `apps/web/test/ground-truth.test.ts` (the Stage 4 forms against the real API: quarantine and release, four-eyes claim approval, trusted evidence, restricted documents, tenant isolation of the new lists), a catalog check that every form is guided (no placeholder IDs; IDs come from pickers) and every picker list is a real route, and two E2E flows (Stage 4 end to end with a second approver; no sideways scrolling at 390 px).

The tests found two existing bugs, now fixed: claim Approve/Reject waited for status `proposed` (claims start as `pending_review`), and decision Accept/Reject waited for `proposed` (decisions use `PROPOSED`), so those buttons never appeared.

### 1.1 Previous release

Verification of the 2026-10-27 release (Meta live integration, model approval withdrawal, sign-in client address, lint scope; on top of `cfa88ff`; all commands run in sequence):

| Check | Command | Result |
|---|---|---|
| Typecheck (strict TS, all packages, apps, jobs, tests) | `npm run typecheck` | **pass** |
| Lint (Biome; errors fail) | `npm run lint` | **pass** — 0 errors, 70 warnings (233 files; generated `graphify-out/` excluded, its 88 JSON errors were the only errors) |
| Generated docs current | `npm run docs -- --check` | **pass** |
| TypeScript tests (real PostgreSQL 17, fixture servers, real renders) | `npx vitest run` | **297 / 297 passed**, 35 files, 0 skipped, 178 s (see §1.1 for the timeouts found and fixed) |
| Python engine, backup and TLS tests | `npm run test:py` | **36 / 36 passed**, 351 s |
| Production bundles | `node scripts/build.mjs all` | **pass** — api (main, migrate, probe, reencrypt-credentials), worker, media |
| Web control plane | `npm run build -w @futuregrow/web` | **pass** — 28 pages, `_headers` with 2 script + 1 style hashes |
| SBOM + licence policy | `npm run sbom` | **pass** — 440 npm + 4 Python + 2 image components; 0 violations; 6 weak-copyleft components listed for legal review; 21 Remotion components under the B-014 exception |
| Browser E2E (Chromium, CSP enforced) | `npm run test:e2e` | **6 / 6 passed**, 2.2 min |

The previous report (commit `12cdbe1`) had 272 / 272 TypeScript tests; the M10 baseline on `9e7b651` was 220 / 220 TypeScript and 30 / 30 Python tests.

### 1.1 Teardown timeouts (investigated and fixed)

The first full run on 2026-10-27 passed every test but failed three files (`analytics-job`, `backup-job`, `channels-acquisition`) with "Hook timed out in 120000ms" in `afterAll`, the same symptom the 2026-10-21 report noted for `db` and `migrate-lock`. Instrumenting `test/helpers/db.ts` showed the pool closing in 0–1 ms and `DROP DATABASE … WITH (FORCE)` taking up to 107 s: each drop waits for an immediate checkpoint (`pg_stat_activity`: `IPC/CheckpointDone`, later drops `CheckpointStart`) while the checkpointer sits in `IO/DataFileSync`, i.e. Windows file syncs under the parallel test load, so concurrent drops queue past the hook timeout. The embedded test cluster now starts with `fsync=off`, `full_page_writes=off`, `synchronous_commit=off` (`test/global-setup.ts`; a throwaway cluster, production and CI's external database untouched). Same suite, same machine: the slowest drop went from 107 s to 4.4 s (24 drops: total 402 s → 50 s), the whole TypeScript run from 381–445 s to 162 s, and no hook timed out.

With teardown fast, the next run overlapped the real Remotion render with the CPU-heavy Python tests, and Chrome Headless Shell missed Remotion's fixed 25 s start-up limit ("Timed out after 25000 ms while trying to connect to the browser"; the second render test failed only because the first job was retried). The renderer started a browser twice per render (composition selection, then rendering); it now opens one, shares it with both calls and retries a timed-out start once (`jobs/media/src/runner.ts`). Production already retries a failed render up to 3 times. Two further full runs: 297 / 297 in 162 s and 178 s.

Tests per file (TypeScript):

| File | Tests | File | Tests |
|---|---|---|---|
| packages/contracts | 13 | packages/core/test/execution | 12 |
| packages/db (db, migration lock, verify-full TLS) | 25 | packages/core/test/data-modules | 13 |
| packages/policies | 16 | packages/core/test/intelligence | 13 |
| packages/connectors (core, providers, deprecations) | 40 | packages/core/test/analytics-job (spawns Python) | 3 |
| packages/agent-kernel (incl. provider failover) | 17 | packages/core/test/audiences | 3 |
| packages/experiments | 3 | packages/core/test/creation | 7 |
| apps/api (api, account security, invitations, ops, public channels) | 21 | packages/core/test/channels-acquisition | 15 |
| apps/web (catalog contract, proxy) | 6 | packages/core/test/channels-retention | 15 |
| jobs/media (real Remotion render) | 2 | packages/core/test/backup-job (spawns Python) | 6 |
| test/redteam | 16 | packages/core/test/retention, secrets-rotation | 3 |
| infra/cloudflare/uptime-worker | 5 | packages/core/test/ops (status, monitor, notifier) | 10 |
| | | packages/core/test/p2-controls (AI budget, failover, API lifecycle) | 8 |

Python: `tests/test_engines.py` 25 (forecasting, MMM/NUTS diagnostics, experiments/bandits, trends, topics, propensity incl. PSI drift), `tests/test_backup.py` 5 (SigV4 vectors, member encryption, store, scheduling), `tests/test_pgtls.py` 6 (`verify-full` DSN building, refusal of non-verifying modes).

Additional manual verification: the bundled api booted against PostgreSQL (`/healthz`, `/readyz`, OpenAPI 3.1 with 176 paths, 401 on `/v1/me`), the bundled worker registered all 19 tasks, bundled `migrate.mjs`/`probe.mjs` ran (RLS role available, pgvector absent), and two real renders passed using the prebuilt Remotion bundle shipped in the media image.

## 2. How the system is tested

* **Real PostgreSQL, not mocks.** `test/global-setup.ts` starts an embedded PostgreSQL 17 cluster (UTF-8, D-029), applies every migration once to a template database, and each test file clones its own database. RLS, triggers, the outbox, Graphile Worker schema and the audit chain are the production ones.
* **Provider APIs** are exercised against a programmable local HTTP fixture server that records every request. Tests assert the exact requests (paths, headers such as `Idempotency-Key` and `List-Unsubscribe`, bodies) and drive the responses, including failures, ambiguity and read-back mismatches. **No live provider was called**; live validation is blocked (B-005…B-009).
* **Models** are replaced by scripted providers behind the real model gateway (registry gating, schema validation, secret scanning, cost recording). The red-team suite scripts the model to *comply* with attacks to prove the deterministic controls hold. The Anthropic adapter is tested against a fixture endpoint with the official SDK.
* **Python engines** run under pytest; the cross-language test spawns the real analytics job against the test database.
* **Media**: two real Remotion renders (Chrome Headless Shell + FFmpeg) produce an H.264 MP4 checked for dimensions, duration, hash and inherited rights; the prebuilt-bundle path used by the container image was also rendered.
* **Browser E2E** (`npm run test:e2e`): `e2e/server.ts` starts embedded PostgreSQL, the real API and the production web build on one origin with `dist/_headers` applied; Playwright drives Chromium through six flows, and any page or console error (CSP violations included) fails a test.
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
| M24 Governance | Hash-chained audit + tamper detection, registries, alerts/incidents, cost ledger, backups (encrypted, verified, restore drill), credential key rotation, SBOM licence policy; per-tenant AI spend limits, model end of life, provider API sunsets blocked by policy and deprecation headers recorded (FG-P2-001) | `db`, `backup-job`, `secrets-rotation`, `p2-controls`, `connectors/deprecations`, `scripts/sbom.mjs` |
| Model gateway | Registry gating, structured output, secret scanning, cost recording; failover to another approved provider on outage or open circuit, never on refusal or budget stop | `agent-kernel`, `p2-controls` |
| Operations | `/statusz` component status, ops monitor (announce once, re-announce, recovery, retry undelivered), webhook formats with secret redaction, API 5xx alert throttling, external uptime probe | `core/test/ops`, `apps/api/test/ops`, `uptime-worker` |
| Database | Migration advisory lock (concurrent migrators), `verify-full` TLS with a throwaway CA | `db/migrate-lock`, `db/tls` |
| API / auth | Better Auth sessions + TOTP, tenant resolution, Idempotency-Key contract, MFA gates, webhooks with signatures, invite-only onboarding, change password (rate limit, other sessions revoked, audit) | `apps/api/test` |
| Web control plane | Every UI call maps to a registered route and method (with negative controls); all 24 modules reachable; Pages proxy header hygiene and cookie re-scoping; Playwright E2E of six flows in Chromium with the CSP enforced | `apps/web/test`, `e2e/` |
| Security (FG-P1-005) | Allowlist escape, self-approval, approval replay, destination smuggling, secret exfiltration, log redaction, fence closing, poisoned retrieval, customer injection, planted facts, SSRF/DNS rebinding, cross-tenant retrieval, agent kill switch | `test/redteam` |

## 4. Not verified here (and why)

| Gap | Reason | Mitigation / next step |
|---|---|---|
| Live provider APIs other than Meta (Google Ads, TikTok, YouTube, Shopify, App Store Connect, Resend, Search Console, Chatwoot) | No credentials / app reviews (B-006…B-009) | Fixture contract tests; enable one provider at a time in the beta with approval-required policy |
| Meta publishing, comment delivery from real users | Publishing waits for the owner's approval; the app is in Development mode (B-005) | Read-only live checks pass (§6); a test post waits at approval |
| Paid model calls | Owner keeps paid models off (B-003) | Groq (approved) verified live; scripted providers through the real gateway |
| Container image builds locally | No Docker/Podman here (B-016) | Bundles booted locally; CI `images` job builds all four and Northflank builds them on every push |
| pgvector path | Not available in the embedded build (B-004) | Exact-cosine fallback is the tested path |
| Load and DR timing (P2) | Out of scope for the beta; RTO/RPO `[U]` | Restore drill procedure in RUNBOOK §9; model-provider failover is tested with scripted providers (`agent-kernel`) |
| Uptime Worker on Cloudflare | Not deployed: no `ALERT_WEBHOOK_URL`, and the Cloudflare token is refused by the Workers KV API | Monitor logic tested with fake fetch and KV (`infra/cloudflare/uptime-worker/test`) |

Resolved since the first report: browser click-through (B-017, Playwright E2E in CI), CI execution (B-018) and the Northflank deployment (B-001).

## 5. Known warnings

* `npm audit`: 4 moderate findings, all in `drizzle-kit`'s development-only dependency on `esbuild <= 0.24.2` (dev-server CORS issue). Not present in any runtime bundle or image.
* Biome reports warnings only (mostly `noExplicitAny` in tests and optional-chain suggestions); zero errors.
* The Remotion compositor logs "Executable file detection not yet supported on win32" on Windows; renders succeed.

## 6. Live verification (2026-10-27, commits `6d98d39` and `266dd88`)

| Check | Result |
|---|---|
| CI on both commits (typecheck, lint, docs, real-PG tests, pytest, render, builds, SBOM, E2E, four images) | **pass** |
| Northflank token; api, worker, analytics-job on the new commit | **pass** (deployed SHA `266dd88`) |
| PostgreSQL TLS before and after restart | **pass** — api and worker log `verify-full`, public CA, TLSv1.3; analytics job TLSv1.3 |
| `/healthz`, `/readyz`, `/statusz` | **pass** — all components `ok` |
| Live smoke (`.tools/smoke/live-smoke.ts run`, FG Smoke Test org, TOTP users) | **23 / 23** — MFA flows, 58 list endpoints, approval with separation of duties → worker → VERIFIED, R2 upload, audit chain |
| Connections smoke (`… connections`) | **5 / 5** — Meta webhook secret reported configured |
| Backups (production `backup_runs`, read-only) | **pass** — 7 daily backups and 7 verifications, all succeeded; next due ~19:00 UTC |
| Model failover | **pass** — OpenRouter (Opus) answered 402, the gateway served the call from Groq; spend $0.0007 recorded against the tenant's $5 limit |
| Sign-in client address | **pass** — new sessions record the client address; no "could not determine a client IP" warning since the deploy |
| Meta Page token (`debug_token`, Page info, feed read) | **pass** — type PAGE, never expires (data access until 2027-01-25), Page *EPS-topik-Bangla*, required scopes granted |
| Meta ads token | **pass with caveat** — reads ad account `act_6269640959734898` (BDT, nothing spent), `ads_read` + `ads_management`; a USER token, not a System User token |
| Meta app secret | **pass** — app access token accepted; correct `appsecret_proof` accepted, a wrong one refused |
| Meta webhook | **pass** — app subscribed to Page `feed` (Meta's verification handshake succeeded), Page subscribed to the app; a delivery signed with the app secret → 200 and an interaction in the Smoke org's inbox; wrong signature → 401 |
| Connection health in FUTUREGROW | **pass** — healthy: Page token PAGE/never, feed webhook true, ad account readable, ads token USER |
| Real Facebook test post | **prepared, not published** — action `248fcf33-2b87-4a42-936d-536a490e0b12` at `APPROVAL_REQUIRED` (operational + legal approval, distinct approver) |
| Instagram | **blocked** — no Instagram professional account linked to the Page |
| Comments from real users | **blocked** — app in Development mode (App Review, B-005) |
| Uptime Worker | **blocked** — no `ALERT_WEBHOOK_URL`; Cloudflare token refused by the Workers KV API |
