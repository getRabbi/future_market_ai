# Implementation checkpoint — 2026-11-02

## Resume here

The full completion mission is **not finished**. This session implements the P0 reliability/missing-data milestone and records the existing Android ingestion contract. Resume from this file instead of repeating the repository audit.

Starting HEAD: `7f7700cf81bd9d08e531e6b69cf8fb199117f3be`. Working branch: `fix/studio-reliability`. Draft PR: [#14](https://github.com/getRabbi/future_market_ai/pull/14). No production deployment or live Facebook calls were made. Goal `fe9be4e0`, permissions, posting frequency and $0 ad budget were not modified.

## Completed code

- Studio measurements explicitly record missing counters and completeness. Reactions, comments and shares must all be observed and evidence-backed to score; true zeroes remain valid. Missing fields in snapshots no longer throw.
- Measurement age comes from observation time, not sync time. Older/repeated observations cannot replace newer ones; observations outside 24–168 hours are rejected; seven-day windows freeze even if no new observation arrives. Learning only compares complete frozen observations taken at age 144–168 hours. Scores remain descriptive, not causal/statistical winners.
- Frozen historical records remain untouched. Legacy unversioned scores are excluded from current learning/API scores rather than silently reinterpreted. UI shows incomplete counters and unavailable/provisional scores.
- Calendar-item row locking prevents simultaneous workers from creating multiple daily drafts; restart reuses the existing draft. Failure updates cannot overwrite an already drafted item.
- Social `verifiedAt` uses the independent proof's `checkedAt`.
- Interrupted submit steps recover existing M23 actions before applying limits for new submissions. Recovery also repairs a missing post/action link using the original, tenant-scoped idempotency key and matching post/account.
- Calendar occupancy is bounded to the current Dhaka date; a future-dated submitted post no longer consumes today's slot.
- Cycle startup rechecks mutable `nextRunAt` and target date under the goal row lock. A real PostgreSQL lock-race regression covers schedule changes between the initial read and lock acquisition.
- Architecture policy reference corrected to 1.4.0 and the implemented Studio behavior documented. [Android integration contract](APP_INSTALL_INTEGRATION.md) describes the existing endpoint and explicitly separates remaining backend/mobile work.

Commits already saved: `e40ef11` (measurement/concurrent drafts), `3037370` (submission recovery). Subsequent scheduling/recovery and documentation commits are on the same branch; inspect `git log -4 --oneline` for their IDs.

## Files changed by this work

- `packages/core/src/modules/studio/measurement.ts` (new)
- `packages/core/src/modules/studio/index.ts`
- `packages/core/src/modules/m16-social/index.ts`
- `packages/core/src/modules/autopilot/steps.ts`
- `packages/core/src/modules/autopilot/engine.ts`
- `packages/core/test/studio-measurement.test.ts` (new)
- `apps/worker/test/autopilot.test.ts`
- `apps/web/src/components/ContentStudio.tsx`
- `docs/ARCHITECTURE.md`
- `docs/APP_INSTALL_INTEGRATION.md` (new)
- this checkpoint

No database migration or new dependency was introduced. `graphify update .` was run (AST only); graph output stays ignored.

## Validation

- Targeted Studio/worker/connector/M23 tests: all 77 passed, including final missing-action-link recovery, concurrent drafting and the mutable-schedule lock race.
- Typecheck, lint, generated docs check, API/worker/media production bundles and web build passed. Lint has 88 existing warnings and one configuration notice; no errors.
- Local full TypeScript suite: 378 passed; the separate real-TLS PostgreSQL startup hook timed out, leaving five TLS tests unrun. Do not describe that local full run as green. [Linux CI at `3037370`](https://github.com/getRabbi/future_market_ai/actions/runs/41503632542) passed all jobs, including full TypeScript/security, Python, render, E2E, production bundles and licence policy.
- Local browser E2E: all 13 passed.
- Local Python: 34 passed; three setup errors were sandbox access failures in pytest's temporary directory. Rerunning both affected backup/TLS files outside the sandbox passed all 12 tests, including the three that previously errored.
- All provider execution was against fixtures. No fresh live provider, production health, backup restore or deployed-build verification was performed.
- Final PR CI and final scheduling/recovery validation must be checked on the latest head before merging. Keep the draft PR undeployed until those checks are reviewed.

## Preserved pre-existing changes

These four files were dirty on entry and were not included in this work's commits. Preserve them:

- `docs/D040_CONTENT_STUDIO.md`
- `infra/cloudflare/uptime-worker/src/monitor.ts`
- `infra/cloudflare/uptime-worker/test/monitor.test.ts`
- `infra/cloudflare/uptime-worker/wrangler.toml`

## Remaining implementation, in order

1. **P1 / phase 2:** implement application-scoped, evidence-backed campaign conversion reporting on existing M19. Do not rebuild ingestion. `/ingest/v1/app-installs` already requires a server ingestion key and rejects browser keys; `recordInstall()` deduplicates per tenant/platform/hashed install ID and minimizes referrers. Existing `acquisitionCohorts()` groups source/method, not campaigns, and lacks telemetry-coverage/mature-window semantics. The install table lacks application scope. Install, profile-event and audit writes are separate transactions. Add app scope, timestamp consistency checks, durable evidence/atomic deduplication, actual first-open/activation/retention coverage, null unavailable metrics and focused tenant/app isolation tests. Then add reporting/API/UI and evidence-qualified Studio use. Apple sales-report ingestion exists; Google Play Console report ingestion does not.
2. **P2 / phase 3:** reusable brand/program configuration, bounded Agent Kernel strategy, approved-claim/curriculum constraints, provider-neutral media sources with configured rights/credentials, quality/diversity checks and authorized quiz reveals. Existing EPS curriculum and branded renderer remain functional; do not replace them.
3. **P3 / phase 4:** platform-independent concepts plus per-channel formats; audit and reuse official Meta/TikTok/YouTube executors. Verify current official X/Reddit/LinkedIn API access before adding adapters. Keep unsupported publishing disabled. Extend the existing group/share-kit workspace and conservative authorized replies.
4. **P4 / phase 5:** uncertainty-aware business-outcome learning with independent brand/app/account/channel series. The present fix only makes engagement observations safe to compare; it does not implement conversion optimization or causal inference.
5. **Phase 6:** reconcile the remaining architecture/runbook/policy/capability/progress/decision/blocker records against implementation; audit current readiness, worker recovery, backups, secrets, expiry, monitoring, rollback and migration compatibility. Original blueprints were not rewritten. Current deployment/provider status must be verified rather than inferred from historical docs.

## External dependencies and exact next task

The mobile application's repository and its authenticated backend are needed to ship device telemetry. No unrelated application was guessed or edited. Use `APP_INSTALL_INTEGRATION.md`; never ship a FUTUREGROW server key in an APK. Play Console credentials/report permissions, other-platform commercial/API approvals and AI/stock credentials/rights must be genuinely connected before activating those providers. Their live availability was not audited here.

Next development task: after checking the latest PR validation, add application scope and evidence-backed install/campaign observations to M19, with atomic replay behavior and cross-app/tenant isolation tests. Start navigation with `graphify query "recordInstall acquisitionCohorts" --budget 800`, then the already located `packages/core/src/modules/m19-app-growth/index.ts`, `packages/db/src/schema/growth.ts` (`appInstalls`), `apps/api/src/routes/public-channel-routes.ts`, `apps/api/src/routes/public-routes.ts`, and their existing acquisition/public-channel tests. Reuse the ingestion-key flow and existing M02 event infrastructure.
