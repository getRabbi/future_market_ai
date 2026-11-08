# P1 + P2 + P3 combined release (D-050)

Branch `feat/p1-p2-p3-complete`, based on the P1 branch `feat/p1-eps-growth` (`2a8f58b`, PR #29) and `main` `d0a546b`. One combined PR; nothing in this release is merged or deployed until the owner authorizes the single rollout below.

Status labels: **IMPLEMENTED — TESTED** (code, UI, error handling and automated tests; provider behaviour against fixtures only) · **LIVE VERIFIED** (checked against the real provider in production) · **REQUIRES OWNER CONFIGURATION** · **REQUIRES PROVIDER APPROVAL** · **REQUIRES PAID INFRASTRUCTURE** · **REQUIRES LEGAL REVIEW** · **NOT IMPLEMENTED**. A fixture-tested provider is code complete, not production verified.

## 1. 33-workstream status

### P1 — preserved (PR #29 commits `9fc8b06`, `2a8f58b`, unchanged)

| # | Workstream | Status | Remaining blocker |
|---|---|---|---|
| P1-01 | Google Play Developer Reporting API | IMPLEMENTED — TESTED; bulk reports LIVE VERIFIED (D-045) | Owner enables the Reporting API in `futureai-513908` (B-023, still `SERVICE_DISABLED`) |
| P1-02 | Facebook Page Insights | IMPLEMENTED — TESTED | `read_insights` + App Review (B-005) |
| P1-03 | EPS-specific Growth Brain | IMPLEMENTED — TESTED (D-049) | Deploy |
| P1-04 | Real-user Unified UX | LIVE VERIFIED (D-048); P1 copy fixes deploy with this release | — |
| P1-05 | Per-post store attribution | IMPLEMENTED — TESTED | Owner switches the EPS program to one campaign per post |
| P1-06 | Meta App Review readiness | Checklist (docs/META_READINESS.md) | REQUIRES PROVIDER APPROVAL |
| P1-07 | Meta token renewal / expiry alerts | IMPLEMENTED — TESTED | Deploy (first EPS alert due 2026-12-26) |
| P1-08 | Documentation reconciliation | Done (and updated here) | — |

### P2 — integrations

| # | Workstream | Backend | Frontend | Tests | Live status | Remaining blocker |
|---|---|---|---|---|---|---|
| P2-01 | App Store Connect | Multi-account ES256 client, app discovery, Sales and Trends, Analytics Reports (downloads, impressions, page views, installs, sessions, crashes), revisions, freshness, scheduler (D-045) | App intelligence › Developer accounts; Integration status | `app-intelligence.test.ts`, `integrations.test.ts` | Shows `requires_connection` (never zero) | Owner: App Store Connect key (Sales and Reports; Admin once) — REQUIRES OWNER CONFIGURATION |
| P2-02 | Instagram | Publishing executor (image/reel, publish limit, status poll); **new** account + media insights | Integration status; Results per-platform card | `p3-channels.test.ts`, existing provider tests | Fixture only | Link IG professional account, `instagram_content_publish` / `instagram_manage_insights` + App Review. **Carousel publishing NOT IMPLEMENTED** |
| P2-03 | TikTok | Direct Post (creator_info, privacy, audit flag), **new** user stats + video query | Integration status; Results | `p3-channels.test.ts`, `channels-paid.test.ts` | Fixture only | App audit (posts stay `SELF_ONLY`), `video.publish`, `video.list`, `user.info.stats` — REQUIRES PROVIDER APPROVAL |
| P2-04 | YouTube | Resumable upload, privacy; **new** channel/video statistics and Analytics API watch time | Integration status; Results | `p3-channels.test.ts`, `channels-paid.test.ts` | Fixture only | OAuth client + `yt-analytics.readonly`; audit for public uploads |
| P2-05 | LinkedIn | Organization posts (Posts API); **new** follower count and share statistics | Integration status; Results | `linkedin-x.test.ts`, `p3-channels.test.ts` | Fixture only | Community Management API product (B-020) — REQUIRES PROVIDER APPROVAL |
| P2-06 | X | Post, media, read-back, delete; disabled by default (`supported: false`) | Integration status with cost estimate ($0.015/post, $0.20 with link) | `linkedin-x.test.ts`, `integrations.test.ts` | Disabled | Owner decision to pay (B-019) |
| P2-07 | Reddit | Owner-assisted share kits, community rules and history (D-042); no API by design | Community workspace; Integration status `owner_assisted` | existing community tests | Owner-assisted | Optional Reddit Data API approval for read-only research (B-021) |
| P2-08 | Google Ads | Reporting, budgets, status (existing); **new** atomic campaign creation | Integration status; Campaigns & paid media › New paid campaigns | `p3-channels.test.ts` | Fixture only | Developer token Basic access; B-026 for creation |
| P2-09 | Shopify | Discounts via M23, HMAC webhooks, order/refund attribution (existing); **new** product + inventory facts | Integration status; `POST /v1/offers/connections/:id/catalog/sync` | `channels-retention.test.ts`, `business-ops.test.ts` | Fixture only | Custom app (`read_products`, `read_inventory`, `read_orders`, `write_discounts`) |
| P2-10 | Resend email | Journeys, templates, consent, suppression, RFC 8058 unsubscribe, webhooks (existing); **new** SPF/DKIM readiness per domain and DMARC reminder | Integration status; Connections health details | `p2-integrations.test.ts`, `channels-retention.test.ts` | Fixture only | Resend key + verified domain (B-008); marketing-consent review |
| P2-11 | PostHog | **New** consent-only forwarding (keyed-hash id, PII dropped, event uuid, cursor), health check | Integration status › Turn forwarding on/off | `business-ops.test.ts`, `p2-integrations.test.ts` | Off by default | Optional: project key; DPA |
| P2-12 | Chatwoot | Handoff (existing); **new** inbox health, conversation mapping, token webhook, agent replies mirrored once, resolve closes, honest `forward_failed` | Integration status › Show webhook URL | `business-ops.test.ts`, `p2-integrations.test.ts` | Fixture only | Chatwoot instance + token + webhook |
| P2-13 | Google Search Console | Search Analytics sync (existing); **new** verified-property health check, grounded opportunities, cited Idea Lab ideas | Integration status; `GET /v1/seo/opportunities/grounded` | `p2-integrations.test.ts`, `business-ops.test.ts` | Fixture only | OAuth client + verified user |
| P2-14 | Creator/affiliate payouts | **New** provider-neutral contract, PayPal Payouts adapter, payout profiles (KYC/tax evidence), readiness check, blocked requests, disputes | Creator APIs; Integration status | `business-ops.test.ts`, `p2-integrations.test.ts`, `channels-retention.test.ts`, `research-compliance.test.ts` | Execution disabled | Legal review, merchant agreement, KYC, then enable `creator.payout` (B-015) — REQUIRES LEGAL REVIEW |
| P2-15 | Legal and licensing approvals | **New** compliance registry (14 items, gates, expiry), wired into payouts and research | Governance › Legal & licensing readiness | `research-compliance.test.ts`, `integrations.test.ts` | 0 of 14 approved | Counsel/owner reviews — REQUIRES LEGAL REVIEW |

### P3 — product development

| # | Workstream | Backend | Frontend | Tests | Live status | Remaining blocker |
|---|---|---|---|---|---|---|
| P3-01 | Universal Content Studio | General programs for any brand; persistent pipeline research → idea → brief → draft → validate → approve (four eyes) → schedule → publish (M16/M23) → verify → measure → learn; AI ideas/drafts via the approved gateway; collision-free campaigns | Content › Brand programs | `universal-studio.test.ts` (two brands, campaign collision, grounded ideas, publish + read-back) | Fixture only | An approved model for AI ideas (manual works without); attaching videos to Studio drafts is API-only |
| P3-02 | AI image generation | Provider interface, OpenAI Images adapter, async jobs, prompt screening, budget guard, cost ledger, model rights, disclosure, cover-fit, R2 | Asset studio › Media sources / AI image | `media-sources.test.ts` | Disabled | Approve an image model with a price and licence record; OpenAI credit — REQUIRES PAID INFRASTRUCTURE |
| P3-03 | Licensed stock media | Pexels search/import (photos cover-fitted, videos), attribution, licence record, dedupe, revocation sweep | Asset studio › Licensed stock | `media-sources.test.ts` | Disabled | Free Pexels key + approved stock_media licence record |
| P3-04 | AI Video Studio | Storyboard scenes (text, subtitles, media, transitions) in 9:16/1:1/16:9, Remotion `scene_story`, MP4 + thumbnail + SRT, QA, sync | Asset studio › Video Studio | `jobs/media/test/render.test.ts` (real playable H.264 MP4) | Render blocked until the Remotion licence is recorded | B-014. **Voice/TTS and generative video models NOT IMPLEMENTED** |
| P3-05 | Multi-platform analytics | IG/TikTok/YouTube/LinkedIn per-day observations, revisions, runs, definitions, daily sync | Results › per-platform cards | `p3-channels.test.ts`, `channels-paid.test.ts` | Fixture only | Platform connections and scopes. CSV export NOT IMPLEMENTED |
| P3-06 | Full paid campaign creation | Drafts with business checks; Meta and Google creation PAUSED through M23 with read-back, rollback, idempotent replay; `fg-policy-1.5.0` always-approve | Campaigns & paid media › New paid campaigns | `channels-paid.test.ts`, `p3-channels.test.ts`, `policies.test.ts` | Disabled (B-026) | Payment method, spend limits, ads tokens, owner authorization; automated optimisation of new campaigns NOT IMPLEMENTED (existing budget/status proposals apply) |
| P3-07 | App first-open and activation tracking | Install referrer, first open, activation, session, **conversion**, app version, 30-day replay window (Layer 2); Flutter client + relay example | App attribution & cohorts | `telemetry-attribution.test.ts`, `app-conversions.test.ts` | No app sends yet | Wiring into a real app is a separate change (EPS app not touched) |
| P3-08 | Advanced marketing attribution | Store-reported vs telemetry vs content side by side, never summed; incrementality only from completed experiments | `GET /v1/app/attribution` | `telemetry-attribution.test.ts` | — | UI table on the Apps page NOT IMPLEMENTED (API only) |
| P3-09 | Isolated authorized research sandbox | Allowlisted targets, limits, network off, credential refusal, second legal approval, termination, quarantine record; refuses without microVM isolation | Market & Competitors › Authorized research sandbox | `research-compliance.test.ts` | Execution refused (B-012) | Dedicated microVM runner — REQUIRES PAID INFRASTRUCTURE + REQUIRES LEGAL REVIEW |
| P3-10 | Google Meridian | Backend selection (native/meridian/compare), validation, availability, serialization, comparison | MMM request param `backend` | `jobs/analytics/tests/test_meridian.py` | `requires_compute` | GPU host with `google-meridian` (Python 3.11/3.12) — REQUIRES PAID INFRASTRUCTURE |

## 2. Module mapping, pages and endpoints

| Feature | Modules | Page | Endpoints |
|---|---|---|---|
| Integration status | M23/M24, all connectors | Settings › Connections & Credentials | `GET /v1/integrations`, `GET /v1/connections/:id/webhook-url` |
| PostHog forwarding | M02 | Connections (Integration status details) | `GET /v1/customers/forwarding`, `PUT/POST /v1/customers/forwarding/:id(/run)` |
| Universal Studio | M03, M13, M16, M23 | Content › Brand programs | `PUT /v1/content/programs` (`kind: general`), `/v1/studio/programs…`, `/v1/studio/items/:id/{preview,brief,draft,validate,approve,reject,schedule}` |
| Stock, AI images, video | M14 | Content › Asset studio | `/v1/media/stock/{search,import,assets}`, `/v1/media/images/generate`, `/v1/media/jobs`, `/v1/media/videos…` |
| Social analytics | M16 | Results | `GET /v1/social/analytics`, `POST /v1/social/connections/:id/analytics/sync` |
| Paid campaign creation | M17, M23 | Campaigns & paid media | `/v1/ads/drafts…`, `GET /v1/ads/creation-status` |
| Telemetry, attribution | M19 | Apps & Intelligence | `/ingest/v1/app-events` (extended), `GET /v1/app/attribution` |
| Shopify catalog | M12, M03 | — (API) | `POST /v1/offers/connections/:id/catalog/sync` |
| SEO opportunities | M18, M06 | — (API) | `GET /v1/seo/opportunities/grounded`, `POST /v1/seo/opportunities/ideas` |
| Chatwoot | M21 | Connections | `POST /webhooks/chatwoot/:connectionId/:token` (public, token-authenticated) |
| Payouts | M22 | — (API) | `/v1/creators/:id/{payout-readiness,payout-profile,payout}`, `/v1/creators/payout-requests…` |
| Legal readiness | M24 | Governance | `GET /v1/governance/compliance`, `PUT /v1/governance/compliance/:key` |
| Research sandbox | M05 | Market & Competitors | `/v1/competitors/research…` |
| Image model price | M24 | — (platform admin) | `POST /v1/platform/models/approve` accepts `usdPerImage` |

## 3. Database migrations (all additive, forward-only)

| Migration | Change |
|---|---|
| `0017_p2_providers` | `connections` / `webhook_inbox` provider checks gain `pexels`, `paypal` |
| `0018_universal_studio` | `studio_programs.kind` (default `curriculum`), `name`, `plan`; table `studio_content_items` |
| `0019_media_creation` | tables `media_jobs`, `stock_assets`, `video_projects`; `model_registry.usd_per_image`; checks widened: `assets.origin` + `stock`, `render_jobs.composition` + `scene_story`, `cost_ledger.category` + `image_generation` |
| `0020_channels_paid` | tables `social_metric_observations`, `social_analytics_runs`, `paid_campaign_drafts` |
| `0021_business_ops` | `conversations.chatwoot_conversation_id`, `handoff_status`; `conversation_messages.external_id` (+ unique per tenant); tables `event_forwarding`, `creator_payout_profiles`, `payout_requests` |
| `0022_research_compliance` | `rea_jobs` gains target, limits, runner, approval, quarantine columns and statuses; tables `research_targets`, `compliance_items` |

Every new tenant table gets RLS from `fg_apply_security()` (test-enforced). Existing rows are unchanged (EPS program stays `curriculum`, its campaign stays `eps_daily`).

## 4. Services, jobs, configuration and cost

* **Worker tasks (new):** `studio_items_sync` (*/15), `media_jobs_tick` (every minute, ≤5 jobs), `video_projects_sync` (*/2), `stock_licence_sweep` (04:33), `posthog_forward` (*/5, enabled destinations only), `social_analytics_sync` (11:55), `campaign_drafts_sync` (*/10). With nothing connected each is one cheap query per tenant.
* **Media job:** the Remotion bundle gains the `scene-story` composition (rebuilt with the image); renders still require the Remotion licence record.
* **Analytics job:** `meridian_backend.py`; no new Python dependency (Meridian is not installed).
* **Environment:** no new required variable or secret. Optional: `FG_MERIDIAN_COMPUTE=approved` (+ `FG_MERIDIAN_ALLOW_SMALL_RAM=1`) on a separately approved Meridian host only. An existing `OPENAI_API_KEY` now also configures the image provider, which is never called unless an image model is approved and priced.
* **Policy:** `fg-policy-1.5.0` (actions with `alwaysRequiresApproval` are never pre-authorized: paid campaign creation, payouts).
* **Cost:** $0 by default and within the free tiers (no new Northflank resource). Turning on paid capabilities costs money and needs the owner: OpenAI images (~$0.04 per medium image, set at approval), X posting ($0.015/post), ad spend (Meta/Google), a GPU host for Meridian, a microVM host for the research sandbox. Pexels, Search Console and the PostHog/Resend free tiers cost nothing.

## 5. Testing evidence (local, 2026-11-09)

* TypeScript: typecheck and Biome lint clean (0 errors). Full Vitest run: 576 tests in 66 files, 568 passed, 5 skipped. The 3 failures and 1 file failure were analysed: two hard-coded policy-version expectations and one outdated media expectation (fixed; suites rerun green), and two timeouts under concurrent load (TLS hook, backup restore check) that pass when run alone. Final CI run on the PR is the reference.
* New suites: `p2-integrations` (8), `p3-channels` (10), `integrations` (3), `universal-studio` (7), `media-sources` (9), `channels-paid` (6), `business-ops` (7), `telemetry-attribution` (4), `research-compliance` (6); Video Studio real render (`jobs/media/test/render.test.ts`, 3); Python `test_meridian.py` (5).
* Regression: worker Autopilot suite 14/14 (EPS Facebook publishing, Studio, Play), content studio, brands, app intelligence, app conversions, retention, acquisition, red team, contracts, policies.
* Browser E2E: 17/17 locally. One existing test seeded store days with the embedded database’s local `current_date` while the API counts UTC days, so it failed between local midnight and 06:00 (UTC+6); its seed now uses the UTC date (no assertion changed).

Acceptance scenarios → tests: 1 connections (`p2-integrations`, `connections`); 2 two brands/programs (`universal-studio`); 3 non-EPS content (`universal-studio`); 4 AI image (`media-sources`); 5 stock (`media-sources`); 6 MP4 (`render.test`); 7 publish + verify (`universal-studio`); 8 platform metrics without totals (`p3-channels`, `channels-paid`); 9 paid draft → M23 → fixture creation (`channels-paid`, `p3-channels`); 10 first open + activation (`telemetry-attribution`); 11 attribution without double counting (`telemetry-attribution`); 12 lifecycle email (`channels-retention`); 13 Shopify order/refund/commission (`channels-retention`, `business-ops`); 14 refused payout (`business-ops`, `channels-retention`); 15 Chatwoot handoff (`business-ops`); 16 Search Console opportunities (`business-ops`); 17 refused research job (`research-compliance`); 18 Meridian requires_compute (`test_meridian.py`); 19 tenant isolation (`integrations`, `universal-studio`, `channels-paid`, `db.test`); 20 EPS regressions (worker `autopilot.test`, `content-studio`, `app-intelligence`).

## 6. Security guarantees and limitations

* Every consequential external write still goes through M23; new writes (`ads.*.create_campaign`, `creator.payout`) are always human-approved (finance group, two-factor) and ship disabled in the capability registry.
* Provider behaviour is verified against fixtures only; no real post, ad, payout, email, generation or download happened during development.
* Chatwoot webhooks are authenticated by a per-connection keyed-hash path token (Chatwoot has no body signature to rely on); rotating `FG_IDENTIFIER_PEPPER` changes the URL.
* The research sandbox executes nothing in this deployment; isolation is a hard requirement, not a configuration toggle.
* Compliance approvals record human review; tests prove the gates, not the law.
* The web app’s Content-Security-Policy is unchanged (`img-src 'self' data:`): stock previews open on Pexels and rendered videos open as signed links instead of being embedded from third-party or storage hosts.

## 7. Release manifest — single coordinated rollout (owner authorization required)

1. Confirm the combined PR is mergeable and CI (verify, render, e2e, images) is green; owner approves superseding PR #29 (close it, do not merge it separately).
2. Baseline: note api/worker deployed SHA (`d0a546b`) and the current Pages deployment id; confirm the newest encrypted backup is < 24 h old (RUNBOOK §9) or run the analytics backup job.
3. Merge the combined PR once (merge commit).
4. Northflank builds api, worker, media-job and analytics-job from `main`; the api applies migrations 0017–0022 on start (advisory-locked): check the `migrate ok` log line.
5. Confirm api and worker run the merge SHA (`deployment.internal.deployedSHA`); trigger the media-job build so the Remotion bundle includes `scene-story`.
6. Deploy Pages from the merged tree (`npm run build -w @futuregrow/web`; `wrangler@4.147.0 pages deploy dist --project-name futuregrow-web --branch main --commit-hash <sha>`).
7. Health: `/statusz` all ok; `GET /v1/system/status`; `/v1/openapi.json` lists `/v1/integrations`, `/v1/studio/programs`, `/v1/media/jobs`, `/v1/ads/drafts`, `/v1/governance/compliance`.
8. Smoke (read-only, smoke org): `npx tsx .tools/smoke/live-smoke.ts` as before; Integration status shows App Store Connect `requires_connection`, X `requires_owner_authorization`, Reddit `owner_assisted`, payouts and legal `requires_*`; media providers show only templates (and verified assets) enabled; paid creation `disabled`.
9. EPS unchanged: the EPS goal keeps its schedule and posts once a day through M23; the EPS program is still `curriculum` with `eps_daily`; the next `store_reporting_tick` imports Play reports; P1 token lifecycle alerts appear for the EPS Page token on schedule.
10. Monitor 24 h: worker logs for the new tasks (no repeated errors), Discord alerts, `/statusz`.
11. Report deployment ids (api/worker SHA, Pages id) and the rollback targets.

**Rollback:** the migrations only add tables/columns and widen checks, and the previous binary ignores them, so redeploying `d0a546b` (api/worker) and the previous Pages deployment restores behaviour without a schema change. If data must be reverted, follow RUNBOOK §9 (restore to a new database, verify, switch). Fast stops without a deploy: kill switches (tenant, connector, agent `universal-studio`), turning PostHog forwarding off, leaving capabilities disabled.

## 8. Activation checklist and remaining owner actions

| To activate | Owner action |
|---|---|
| iOS reports | App Store Connect key (Sales and Reports; Admin once) |
| Play vitals | Enable the Play Developer Reporting API (B-023) |
| Page insights | Re-authorize with `read_insights` before 2027-01-25; App Review + Live mode (B-005) |
| Instagram | Link the IG professional account; scopes + App Review |
| TikTok / YouTube | TikTok app audit; YouTube OAuth client (+ `yt-analytics.readonly`); record the Remotion licence for videos |
| LinkedIn | Community Management API product (B-020) |
| X | Decide on pay-per-use spend (B-019) |
| Google Ads / Meta ads creation | Developer token Basic access; System User ads token; payment method; spend limits; authorize B-026, then a platform operator enables the capabilities |
| Shopify | Custom app token + webhooks |
| Resend | API key, verified domain (SPF, DKIM, DMARC), sender identity (B-008) |
| PostHog / Chatwoot / Search Console | Keys/tokens; Chatwoot webhook URL; Search Console OAuth |
| Stock media | Free Pexels key + record the Pexels License as an approved stock_media licence |
| AI images | Approve an image model with a per-image price and licence record (paid; owner decision) |
| Payouts | Legal review, merchant agreement, KYC/tax process; then enable `creator.payout` (B-015) |
| Legal readiness | Counsel reviews of the 14 compliance items (P2-15) |
| Meridian | Approved GPU compute with `google-meridian` (B-010) |
| Research sandbox | Dedicated microVM runner + counsel review (B-012) |
| EPS per-post campaigns | Content studio › "Use one campaign per post" |
