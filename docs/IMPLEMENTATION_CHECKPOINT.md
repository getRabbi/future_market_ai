# Implementation checkpoint — 2026-11-06

## Resume here

Universal App Intelligence mission (D-045) on branch `feat/d045-app-intelligence` (from `origin/main` `c348d50`). Read [APP_INTELLIGENCE.md](APP_INTELLIGENCE.md) first; do not repeat the audit.

- **Built:** migration 0016 (`store_accounts`, `store_apps`, `store_report_files`, `store_report_partitions`, `store_metric_observations`, `store_report_coverage`, `store_sync_runs`, `campaign_links.report_scope`); connectors `providers/google-play.ts` (service-account JWT, Cloud Storage list/download with MD5, Reporting API `apps:search` and vitals) and the Apple Analytics Reports functions in `providers/apple.ts`; engine `packages/core/src/modules/m19-app-growth/store/` (definitions, decode, parse, ingest, accounts, sync, query, signals); worker tasks `store_reporting_tick`, `store_account_sync`, `store_report_retention`; routes `apps/api/src/routes/app-intelligence-routes.ts`; Autopilot tab `apps/web/src/components/AppIntelligence.tsx`; Autopilot install goals use store series; new Studio programs default to per-post `utm_campaign`.
- **Validation:** see the PR for the final suite. Locally: full TypeScript suite 465 tests with one failure caused by rewording the studio note, fixed and re-run; then new store tests (22 integration + 8 decode + 6 connector), typecheck, lint (0 errors), docs check, production bundles, web build and the 13 browser E2E tests (including App intelligence at 390 px) pass.
- **Not verified live:** no real Play or Apple account is connected (B-022). Everything provider-facing is fixture-tested against the documented shapes.

## Remaining work, in order

1. Release the branch (DEPLOYMENT §12) and verify read-only: routes in OpenAPI, empty account list, EPS program still `shared`, EPS schedule unchanged.
2. Owner: connect the Play developer account (service account + "View app information", bucket URI) and, for iOS, an App Store Connect key; then verify one real import (APP_INTELLIGENCE.md › Owner setup).
3. Optional owner choice: switch the EPS program to `campaignIdentity: per_post` so Play's traffic-source report names individual posts (historical links stay unchanged).

## Preserved pre-existing changes

These four files were dirty on entry and are deliberately not committed:

- `docs/D040_CONTENT_STUDIO.md`
- `infra/cloudflare/uptime-worker/src/monitor.ts`
- `infra/cloudflare/uptime-worker/test/monitor.test.ts`
- `infra/cloudflare/uptime-worker/wrangler.toml`
