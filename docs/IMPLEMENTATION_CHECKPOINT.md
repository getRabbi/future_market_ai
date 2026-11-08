# Implementation checkpoint — 2026-11-08

## Resume here

P1 EPS growth intelligence (D-049) on branch `feat/p1-eps-growth`, from `origin/main` `d0a546b` (P0 complete and live). No migration, no new dependency. Read [APP_INTELLIGENCE.md](APP_INTELLIGENCE.md) › *Per-post store attribution* and [META_READINESS.md](META_READINESS.md) first.

- **Live baseline (unchanged until this branch is merged):** api, worker and jobs on `d0a546b`, Pages `4590d4df`, uptime Worker `da1edefb`. The real EPS Page connection, Google Play account, EPS brand, Studio program `42216a51` (shared `eps_daily` campaign) and the active Autopilot goal `fe9be4e0` all live in the organization `FG Smoke Test 20261021`.
- **Audit findings (read-only, 2026-11-07 ~20:40–21:20 UTC):** Play account `ok`, daily sync healthy, Reporting API `SERVICE_DISABLED`; EPS installs stated as an observed increase (75 vs 12 over two 28-day windows, newest final day 10-31), acquisitions withheld; no UTM campaign rows for EPS yet. Page token PAGE, never expires, data access until 2027-01-25, no `read_insights`; Page insights empty; `feed` webhook active. EPS goal cycle 7 completed with a verified post; forecast unavailable (no `kpi.facebook.*` series) and correctly not counted as a blocked cycle.
- **Changed (each with regression tests):**
  - Brain context for organic Page goals from the Page's brand apps only (`appsTrendContext`, `steps.ts` observe; `app-intelligence.test.ts`, worker D-035 test).
  - Campaign sums final-only with `excludedDays`; `campaignReportDays`; Studio `postStoreAttribution` (14-day window, `awaiting_reports`/`reported`/`not_listed`); report-only learning comparison; Content studio switch to per-post campaigns; App intelligence campaign table shows final/excluded days (`app-intelligence.test.ts`, `studio-learning.test.ts`, worker D-040 test).
  - Token lifecycle alerts 30/7 days ahead and critical re-authorization alert from the health check (`connections.test.ts`).
  - Bootstrap lesson names missing `read_insights` (worker D-036 test); Home "not measured yet" copy.
- **Already correct (verified by existing tests, not rewritten):** Reporting API failures are classified (`SERVICE_DISABLED`, denied, rate-limited, unavailable) and never block bulk reports; app names come from `apps:search` when available, otherwise the brand name or package; Page insights `no_data` never becomes zero and post counters stay a separate fallback; 12-day stale-series forecast guard; 80% baseline coverage; refused publishes are `FAILED`, not retried, and queued actions wait on `reauth_required`.

## Remaining work, in order

1. Owner: review and merge the P1 PR (merging to `main` auto-deploys api and worker; Pages needs its usual deploy for the Content studio and App intelligence changes).
2. Owner (B-023): enable the Google Play Developer Reporting API in Cloud project `futureai-513908`.
3. Owner (B-005): before 2027-01-25, authorize the app again with `read_insights`, test the new Page token, then rotate it; App Review and Live mode (docs/META_READINESS.md).
4. Owner: in Content studio, switch the EPS program to one campaign per post if per-post store results are wanted.
5. Owner (B-022, iOS only): an App Store Connect key.

## Preserved pre-existing changes

`docs/D040_CONTENT_STUDIO.md` is dirty on entry and is deliberately left uncommitted. The uptime-worker files of the previous checkpoint were merged through PR #25 and deployed (P0).
