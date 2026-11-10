# Remaining development checkpoint

Branch: `feat/remaining-development`, based on `b2049359` (main fetched and verified).
Preserve the pre-existing uncommitted `docs/D040_CONTENT_STUDIO.md`; do not stage it.
No deployment, production configuration, live schedule changes, or main merge authorized.

## Batch A

Implemented App Store metadata discovery from brand names, connected-app exclusion, identity validation, heuristic direct/indirect/emerging classification, scored reasons, evidence, recurring queued searches, deduplication, review and enrollment, pending monitoring source proposals, discovery controls/history/rankings, change alerts and an evidence comparison panel. Existing snippet-verified model extraction and feature-gap material continue into Idea Lab and Growth Brain. Monitoring handles text-only listing/product/positioning changes, and refuses redirects rather than fetching an unapproved destination.

Provider: Apple's documented Search API, https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html . No API key; tenant legal approval of the intended metadata use is mandatory. No live provider verification or legal authorization performed. Results are heuristic candidate relevance, never store rank, installs or market metrics. Google Play public search and general web search remain unavailable pending permitted provider adapters; no scraping fallback.

Validation: 19 focused tests passed (discovery, existing intelligence, dashboard catalog); typecheck passed. Migration 0024 is generated locally only. Batch A commit: `8397cc3`.

## Batch B

Zero-weight topic terms are filtered after the existing stable sort; 3 topic tests passed, including hash-seed independence. Autopilot periodically evaluates all active connected campaigns and reevaluates after `ads.spend.synced`. Fresh evidence and three complete recent days are required; outcome comparisons require 14 complete days. Detects low CTR/no clicks, budget risk, declining conversions and improving efficiency. Review proposals appear in the existing alerts inbox and paid-media panel, with evidence, reasons and heuristic confidence. Unacknowledged/recent proposals are suppressed under a tenant advisory lock. Operator selection recomputes the rule and proposes a pause through M23 with an idempotency key; no automatic execution or spend increase. Opportunity signals are advisory.

Validation: 2 optimizer tests and 12 existing gap-closure tests passed; typecheck passed. An invalid tenant-policy fixture was corrected before the passing rerun. Python emitted only a sandbox cache-write warning. Batch B commit: `c08b0f4`.

## Batch C

Provider-neutral generative video implemented using the existing media job queue, model/licence registries, AI budget and asset store. Submit/poll operation IDs, durable video caps, unresolved-billing reservations, output probing, evidence and rights gating are covered with fixtures. No real adapter or provider is activated; see `docs/ADVANCED_MEDIA_ATTRIBUTION.md` for the exact integration contract and ffprobe requirement. Remotion remains unchanged.

Official Apple AdServices token exchange/reconciliation implemented with consent checks, backend-source binding, test-payload rejection, token-replay protection and campaign reporting through existing attribution. Campaign identity uses Apple org/campaign IDs. Apple campaign-management reporting (names/spend/impressions) remains a coding/setup gap pending a verified account-specific integration; no aggregate report is treated as campaign data.

Validation: 30 targeted media, video, Apple, telemetry and gap-closure tests passed after correcting a rights-gate assertion; typecheck passed. Tests use fixtures, not live providers. Migrations 0025/0026 are generated only. Batch C commit: `a3acab5`.

## Batch D

Reusable Flutter client now provides durable bounded retries, stable identities/timestamps, serialized once events, first-open/activation/session/conversion hooks, minimized referrer campaign mapping, immediate consent send suppression and unsent-data purge. iOS tokens are fetched only at send time. The backend relay contract requires authentication/attestation, install binding, current consent, rate limits and conversion verification; server ingestion secrets stay on the backend. Both named app profiles have integration hooks and tests. `examples/flutter/futuregrow_telemetry/APP_INTEGRATIONS.md` lists exact new files and interfaces for each external repository, with owner-confirmed activation definitions still required.

Validation: Dart analysis passed and 14 mocked client/relay tests passed, including both apps, restart/retry/concurrency, backend validation limits, consent withdrawal/regrant races and token non-persistence. No mobile repository was available or modified; native referrer/AdServices callbacks, durable storage and backend authentication/payment verification must be integrated and tested there. Batch D commit: `658ce30`.

## Initial completion checkpoint (superseded below)

- Combined regression: 40 tests passed across discovery, proactive campaigns, video, Apple attribution, AI controls, worker Autopilot, public ingestion and dashboard catalog. Typecheck and generated-doc checks passed; lint passed with 141 existing warnings and one configuration deprecation notice. Generated Dart/Python caches are excluded. Graph updated locally.
- Batches A-D are committed. Create the draft PR from this branch; the final checkpoint commit carries `[skip ci]` to defer the repository's automatic full CI/E2E workflow as requested. No full-system/E2E/load verification or deployment performed. Existing D040 document changes remain unstaged.
- Remaining coding/provider gaps: permitted Google Play/general web discovery adapters; a verified generative-video provider adapter with idempotency, billing caps and licensed outputs; Apple campaign-management reporting for names/spend/impressions; integration in both external mobile backends/apps. Current attribution uses official AdServices campaign IDs, not aggregate reports. Do not repeat completed batches on continuation.
- External setup: tenant API/source legal approvals; model/pricing/licence approvals and provider credentials; ffprobe on the media worker; native mobile referrer/AdServices callbacks, durable storage and authenticated relays; eventual coordinated migration/application verification. All migrations remain unapplied to production.

## Incremental completion: PR #32, 2026-11-10

- FUTUREGROW code commit `13f0f5d`: documented Brave Web Search adapter, configurable provider/connection, paced bounded retries, secondary evidence, package/domain dedup and mandatory review. Play discovery uses Brave's index, not a Google catalogue API. Existing approval/crawl gates remain. Owner must supply a plan/key and approve evidence storage under that plan. Direct Google Play public search remains externally blocked; no unauthorized scraping.
- Apple Ads OAuth and v5 campaign reporting are implemented: UTC daily names/IDs, impressions/taps, exact decimal spend/currency, bounded pages, organization/permission checks, null missing metrics, evidence revision dedup and a separate attribution-dashboard panel. Manual import only; no new live schedule. Account credentials, owner terms approval and live provider verification remain external. AdServices is preserved. Setup and official contracts: `docs/ADVANCED_MEDIA_ATTRIBUTION.md`.
- Video: investigated official Google Veo documentation; current redirects did not yield a complete verified submit/poll/download contract with replay safety, hard charge-cap enforcement and authoritative per-job billing. Adapter remains absent/disabled. Do not invent those guarantees or weaken durable reservations. Requires verified current API details, owner-paid-tier approval, licence and billing integration before further adapter coding.
- Both mobile repositories are accessible. Ecoms BD `feat/futuregrow-telemetry-integration`, commit `41ec12d`, is pushed: authenticated account-bound relay, backend consent/rate limits, durable client queue, Privacy opt-in/withdrawal, native Play/AdServices callbacks and billing-verified subscription conversions. Activation is completed seller onboarding; customer orders are excluded. Payments before the acknowledged install are excluded; verified transaction identity/time and one-install binding prevent duplicate conversions. Optional AdServices failure does not block session delivery. Server secrets/Redis and native/device acceptance remain external. No release or deployment.
- EPS TOPIK Bangla already implements Play install/referrer, first-open, learning activation, sessions, explicit consent, durable queue and Supabase forwarding. Reused that implementation. Documentation-only `feat/futuregrow-telemetry-readiness`, commit `b361002`, is pushed from its actual `feature/v2-app-shell` default branch. No second SDK, invented purchase flow or automation change. Exact files/setup are recorded in that branch's `docs/FUTUREGROW_PR32_READINESS.md`.
- Validation: FUTUREGROW 12 targeted provider/discovery/AdServices/catalog tests passed; typecheck, changed-file Biome and generated-doc checks passed. Ecoms 3 backend fixture tests (including verified-billing normalization), 3 Flutter tests and focused Python/Dart lint/analysis passed. EPS 26 existing Flutter telemetry tests passed. An initial picker regression and missing Flutter generated bindings were corrected before passing runs. No native Android/iOS build or live API acceptance is claimed.
- Migration 0027 is generated only. Graph updated locally. No production migrations, configuration, services, schedules, full CI/E2E/load audit, deployment or merge. Review branches carry `[skip ci]`. Preserve the sole pre-existing D040 document edit. Batches B/D were not reimplemented.

External branches: [Ecoms integration](https://github.com/getRabbi/ecomsbd/tree/feat/futuregrow-telemetry-integration), [EPS readiness](https://github.com/getRabbi/eps_topik_bangla/tree/feat/futuregrow-telemetry-readiness).
Continue with external provider/account approvals or the separately authorized coordinated verification phase; do not repeat completed investigations or batches.
