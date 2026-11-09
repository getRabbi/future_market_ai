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

Validation: Dart analysis passed and 14 mocked client/relay tests passed, including both apps, restart/retry/concurrency, backend validation limits, consent withdrawal and token non-persistence. No mobile repository was available or modified; native referrer/AdServices callbacks, durable storage and backend authentication/payment verification must be integrated and tested there.

## Remaining work

- Combined regression: 40 tests passed across discovery, proactive campaigns, video, Apple attribution, AI controls, worker Autopilot, public ingestion and dashboard catalog. Typecheck passed; lint passed with 141 existing warnings and one configuration deprecation notice. Generated Dart/Python caches are excluded. Graph updated locally.
- Commit Batch D and create one draft PR. No full-system/E2E/load verification or deployment performed. Existing D040 document changes remain unstaged.
