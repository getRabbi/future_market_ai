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

Validation: 2 optimizer tests and 12 existing gap-closure tests passed; typecheck passed. An invalid tenant-policy fixture was corrected before the passing rerun. Python emitted only a sandbox cache-write warning.

## Remaining work

- Batch C: provider-neutral async generative video with approved pricing/licence/budget gates and Video Studio UI; official Apple Ads campaign attribution integration.
- Batch D: reusable Flutter client and backend relay contract, retries/dedup/consent/referrer and app-specific integration guides/tests. External mobile repositories have not been inspected or modified.
- Run focused regressions, typecheck/lint, graph update; separate logical commits; one draft PR. No full-system/E2E/load verification.
