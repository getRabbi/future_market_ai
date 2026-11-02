# Implementation checkpoint — 2026-11-02

## Resume here

The full completion mission is **not finished**. P0 reliability/missing-data and the first P1 conversion-evidence milestone are implemented. Resume from this file instead of repeating the repository audit.

Starting HEAD: `7f7700cf81bd9d08e531e6b69cf8fb199117f3be`. Current working branch: `feat/app-conversion-evidence`, stacked on P0 branch `fix/studio-reliability`. P0 draft PR: [#14](https://github.com/getRabbi/future_market_ai/pull/14), final commit `914c455`, [all CI jobs passed](https://github.com/getRabbi/future_market_ai/actions/runs/41505107643). No production deployment or live Facebook calls were made. Goal `fe9be4e0`, permissions, posting frequency and $0 ad budget were not modified.

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

P0 commits: `e40ef11` (measurement/concurrent drafts), `3037370` (submission recovery), `914c455` (scheduling/recovery/checkpoint).

### P1 conversion-evidence milestone

- Additive migration `0012_app_conversion_evidence.sql` adds application ID, ingestion source, evidence reference and reporting index to existing installs. Legacy rows remain nullable and are not silently assigned to an app or included in scoped reports.
- Install ingestion now serializes replays and commits identity/event/install/evidence/audit atomically, reusing M02 validation inside the existing tenant transaction. Real installation/click timestamps are checked; duplicate responses preserve the original attribution.
- New server-key-only `/ingest/v1/app-events` accepts actual first-open, activation and session events with app/install scope, consent, stable event IDs and observed times. Replays deduplicate; conflicting event IDs and invalid timestamps are rejected. Evidence identifies authenticated backend reporting, not independent Play verification.
- New authenticated `/v1/app/applications` and `/v1/app/campaigns` expose evidence-backed observations by application/platform/source/campaign/content. Missing clicks/outcomes are unavailable, not zero. Retention requires an elapsed 14-day window and a genuine session at age 7–14 days. Evidence samples are bounded and marked when truncated; counts include all matching installs.
- App growth has a new per-application campaign screen. Old source/method cohorts remain labelled as legacy summaries, not campaign KPIs.
- DSAR deletion clears install attribution/evidence linkage and consent, deletes profile events and clears evidence content; deleted installations cannot be relinked by a new app event.
- No Play Console importer, verified tracking-coverage declaration, channel-account/program mapping or conversion-driven Studio optimization has been added yet. This is not the whole of phase 2.

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

P1 also changes `packages/core/src/modules/m02-customers/index.ts`, `packages/core/src/modules/m19-app-growth/index.ts`, `packages/db/src/schema/growth.ts`, migration `0012_app_conversion_evidence.sql` and its generated snapshot/journal, both API channel-route files, `apps/api/test/public-channels.test.ts`, new `packages/core/test/app-conversions.test.ts`, new `apps/web/src/components/AppConversions.tsx`, the control-plane mount/catalog and its route-contract test. No new dependency was introduced. `graphify update .` was run (AST only); graph output stays ignored.

## Validation

- Targeted Studio/worker/connector/M23 tests: all 77 passed, including final missing-action-link recovery, concurrent drafting and the mutable-schedule lock race.
- P1 targeted conversion/acquisition/public-API/UI-contract tests: 35 passed on the final source, covering maximum-length identifiers, concurrent replay, cross-app/tenant isolation, timestamp validation, real events, immature retention, unrelated evidence rejection, rollback, DSAR and server-key authorization. Final typecheck, lint and generated-doc checks passed. Production builds and backup/customer regression reruns are in progress; check the latest commit/PR before deployment.
- Typecheck, lint, generated docs check, API/worker/media production bundles and web build passed. Lint has 88 existing warnings and one configuration notice; no errors.
- Local full TypeScript suite: 378 passed; the separate real-TLS PostgreSQL startup hook timed out, leaving five TLS tests unrun. Do not describe that local full run as green. [Linux CI at `3037370`](https://github.com/getRabbi/future_market_ai/actions/runs/41503632542) passed all jobs, including full TypeScript/security, Python, render, E2E, production bundles and licence policy.
- Local browser E2E: all 13 passed.
- Local Python: 34 passed; three setup errors were sandbox access failures in pytest's temporary directory. Rerunning both affected backup/TLS files outside the sandbox passed all 12 tests, including the three that previously errored.
- All provider execution was against fixtures. No fresh live provider, production health, backup restore or deployed-build verification was performed.
- Final P0 CI at `914c455` passed every job. P1's local broad run was not green: 386 tests passed, the TLS setup and backup cron timed out, and an identifier-boundary test ran against an older loaded module while edits were in progress. The final focused rerun above passed that boundary regression. Do not describe the broad P1 run as passing. Review P1 CI on the committed head before merging.

## Preserved pre-existing changes

These four files were dirty on entry and were not included in this work's commits. Preserve them:

- `docs/D040_CONTENT_STUDIO.md`
- `infra/cloudflare/uptime-worker/src/monitor.ts`
- `infra/cloudflare/uptime-worker/test/monitor.test.ts`
- `infra/cloudflare/uptime-worker/wrangler.toml`

## Remaining implementation, in order

1. **P1 / phase 2:** finish verified tracking-coverage declarations and explicit program/channel-account mappings, then evidence-qualified Studio conversion learning. Current new reports deliberately use observed counts and null unobserved outcomes, without rates or claims of completeness. Add a credential/source-verified Google Play Console report importer using supported official APIs; Apple sales-report ingestion already exists. Preserve legacy callers and do not combine unscoped historical installs into new app KPIs. The existing cohort endpoint still reports legacy source/method summaries and is not the new campaign reporting API.
2. **P2 / phase 3:** reusable brand/program configuration, bounded Agent Kernel strategy, approved-claim/curriculum constraints, provider-neutral media sources with configured rights/credentials, quality/diversity checks and authorized quiz reveals. Existing EPS curriculum and branded renderer remain functional; do not replace them.
3. **P3 / phase 4:** platform-independent concepts plus per-channel formats; audit and reuse official Meta/TikTok/YouTube executors. Verify current official X/Reddit/LinkedIn API access before adding adapters. Keep unsupported publishing disabled. Extend the existing group/share-kit workspace and conservative authorized replies.
4. **P4 / phase 5:** uncertainty-aware business-outcome learning with independent brand/app/account/channel series. The present fix only makes engagement observations safe to compare; it does not implement conversion optimization or causal inference.
5. **Phase 6:** reconcile the remaining architecture/runbook/policy/capability/progress/decision/blocker records against implementation; audit current readiness, worker recovery, backups, secrets, expiry, monitoring, rollback and migration compatibility. Original blueprints were not rewritten. Current deployment/provider status must be verified rather than inferred from historical docs.

## External dependencies and exact next task

The mobile application's repository and its authenticated backend are needed to ship device telemetry. No unrelated application was guessed or edited. Use `APP_INSTALL_INTEGRATION.md`; never ship a FUTUREGROW server key in an APK. Play Console credentials/report permissions, other-platform commercial/API approvals and AI/stock credentials/rights must be genuinely connected before activating those providers. Their live availability was not audited here.

Next development task: finish P1 validation/commit, then implement verified tracking-coverage declarations and program/channel-account mappings so complete zeros and comparable conversion rates can safely feed Studio learning. Start navigation with `graphify query "recordInstall campaignConversions recordAppEvent" --budget 800`, then the already located M19 module, `packages/db/src/schema/growth.ts`, API channel routes and conversion/public-channel tests. Reuse the ingestion-key flow and M02 event infrastructure. Do not repeat the P0 audit.
