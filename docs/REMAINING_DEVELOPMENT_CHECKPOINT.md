# Remaining development checkpoint

Branch: `feat/remaining-development`, based on `b2049359` (main fetched and verified).
Preserve the pre-existing uncommitted `docs/D040_CONTENT_STUDIO.md`; do not stage it.
No deployment, production configuration, live schedule changes, or main merge authorized.

## Batch A

Implemented App Store metadata discovery from brand names, connected-app exclusion, identity validation, heuristic direct/indirect/emerging classification, scored reasons, evidence, recurring queued searches, deduplication, review and enrollment, pending monitoring source proposals, discovery controls/history/rankings, change alerts and an evidence comparison panel. Existing snippet-verified model extraction and feature-gap material continue into Idea Lab and Growth Brain. Monitoring handles text-only listing/product/positioning changes, and refuses redirects rather than fetching an unapproved destination.

Provider: Apple's documented Search API, https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html . No API key; tenant legal approval of the intended metadata use is mandatory. No live provider verification or legal authorization performed. Results are heuristic candidate relevance, never store rank, installs or market metrics. Google Play public search and general web search remain unavailable pending permitted provider adapters; no scraping fallback.

Validation: 2 new fixture/database tests passed (approval, concurrency, dedup, own-app exclusion, rejected candidates, pending-source no-fetch, tenant isolation). Further combined regression pending. Migration 0024 is generated locally only.

## Remaining work

- Batch B: zero-weight topic filtering/regression; periodic and event-triggered campaign optimization with evidence, freshness and M23 approval.
- Batch C: provider-neutral async generative video with approved pricing/licence/budget gates and Video Studio UI; official Apple Ads campaign attribution integration.
- Batch D: reusable Flutter client and backend relay contract, retries/dedup/consent/referrer and app-specific integration guides/tests. External mobile repositories have not been inspected or modified.
- Run focused regressions, typecheck/lint, graph update; separate logical commits; one draft PR. No full-system/E2E/load verification.
