# Implementation checkpoint — 2026-11-07

## Resume here

Final code completion pass (D-046) on branch `fix/final-completion`, from `origin/main` `238599d`. It is a stabilization pass: no new product, no UX redesign, no migration. Read [APP_INTELLIGENCE.md](APP_INTELLIGENCE.md) › *KPI series rules* first.

- **Live baseline (unchanged by this branch until it is merged):** `1401553` + docs `238599d`. Google Play is connected in production (owner-verified): the EPS TOPIK Bangla app was discovered and brand-linked, real install reports were imported, and scheduled Facebook image posts publish through M23.
- **Fixed (verified defects, each with a regression test in `packages/core/test/app-intelligence.test.ts` unless noted):**
  - A1 all-apps totals silently excluded confirmed apps without a value. Now a day needs every confirmed app; iOS no longer publishes a "total" from one of two apps.
  - A2 `evidenceByDay` cited any report of the app/day. A point now cites the admitted evidence of the winning partition of its own metric (`dailyTotals` returns one partition per app/metric/day, so two breakdowns are never added).
  - A3 provisional values and values with non-admitted evidence became points, and unsupported points stayed. Each sync now recomputes its window, removes unsupported points with an `analytics.series.points_invalidated` audit, runs under a per-organization advisory lock and is idempotent. The worker reconciles after every account sync, and ignoring an app queues one. `app.store.*` series are system-owned (`assertUserWritableSeries` on the public series API).
  - A4 signal freshness came from any complete partition (same-day vitals). It now comes from the analysed metric's own newest final, evidence-backed day; signals add `latestFinalDay` and `revisedDays`.
  - B named-app install goals measured all apps. App-scoped goals now measure that app's series, with ambiguity flagged. Forecasts are refused on stale store series. A daily baseline needs 80% coverage (`MEASURE_RULES`). The observe step stores `storeTrend`, and the Idea Lab and Growth Brain get only supported trends through the existing goal constraints.
  - C Play errors were collapsed into a permission message. They now carry codes (`PROVIDER_AUTH_FAILED`, `…_NOT_FOUND`, `…_PERMISSION_DENIED`, `…_RATE_LIMITED`, `…_UNAVAILABLE`), Reporting API failures are classified separately (`SERVICE_DISABLED` vs denied), and messages are sanitized. `POST /v1/app-intelligence/accounts/:id/key` replaces a Play key in place after a bucket test (admin + two-factor; same account, connection and history); the generic credential route refuses Play keys. UI: "Replace the service account key" on the account card.
  - C8 stock and AI media providers claimed `enabled` without an adapter. They now report `adapter: not_built` and stay disabled (`packages/core/test/media.test.ts`).
- **Already correct (shown by tests, not rewritten):** the optional Reporting API never blocks connecting or importing bulk reports; same-version imports are no-ops; older sources never overwrite newer ones; crashed-worker leases resume; organizations are isolated; Facebook Studio learning, scheduling and the M23 gateway are unchanged (their suites pass).
- **Validation (local, 2026-11-07):** typecheck clean; lint 0 errors (93 warnings, none in changed files); `npm run docs -- --check` up to date; full TypeScript suite 54 files / 478 tests passed, 0 failed, 0 skipped; production bundles and web build pass; browser E2E 13/13 (one failure from a duplicate form label was fixed and its spec re-run). No Python changed; CI runs the Python suite.

## Remaining work, in order

1. Final UX and production audit of this branch after merge. Merging to `main` auto-deploys api and worker; Pages needs its usual deploy for the "Replace key" control.
2. Owner (B-023): enable the Google Play Developer Reporting API in the service account's Cloud project, for app names and vitals.
3. Owner (B-022, iOS only): an App Store Connect key if iOS apps should be reported.
4. Deferred scope: per-post install outcomes for Studio optimization (needs per-post campaign links; EPS still uses the shared `eps_daily` campaign); stock/AI media adapters (B-011).

## Preserved pre-existing changes

These four files were dirty on entry and are deliberately not committed (an earlier owner instruction keeps the uptime-worker changes out of commits):

- `docs/D040_CONTENT_STUDIO.md`
- `infra/cloudflare/uptime-worker/src/monitor.ts` (probe `/login/`: live `/login` answers 308 and the probe uses `redirect: 'manual'`, so the committed `/login` probe would alert falsely; its 5 tests pass with the local change)
- `infra/cloudflare/uptime-worker/test/monitor.test.ts`
- `infra/cloudflare/uptime-worker/wrangler.toml`
