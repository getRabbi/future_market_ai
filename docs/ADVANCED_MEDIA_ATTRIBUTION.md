# Generative video and Apple Ads integration

## Generative video (adapter architecture; not operational)

`CoreDeps.videos[provider]` implements `GenerativeVideoProvider` in `packages/core/src/modules/media/generative-video.ts`. No real adapter, credentials, model approval or licence is shipped. Implement against a verified official API; do not invent endpoints. The adapter must enforce AbortSignal timeouts, replay-safe submission by idempotency key, a maximum charge bound, bounded downloads with SSRF protection and no redirects to unapproved hosts. `poll` returns pending, failure with actual billing, or bytes with actual billing. Never guess billing.

Register a model with purpose `video_generation`, reviewed `usdPerVideoSecond`, allowed commercial use and no training on customer data. Its tenant output licence must be approved under the exact name `provider/model`. The existing model-approval function accepts the video price. No production settings were changed.

Video Studio queues 1–15 second silent clips via `/v1/media/generative-video`. The existing media worker leases each submit/poll step; operation identity survives between polls. Queued/in-flight video caps are durable AI budget reservations. Ambiguous submission or billing retains the reservation and fails closed; an operator must reconcile the provider's actual billing before releasing unresolved reservations. Do not clear a reservation merely because a network call failed. Existing text/image reservations remain process-local, as before; cross-provider strict aggregate accounting remains a separate infrastructure limitation.

Install `ffprobe` on the worker. QA checks bounded MP4 bytes, one H.264 stream, dimensions, duration, and absence of audio/auxiliary streams. Generated clips carry hashes, model/licence evidence and disclosure. They stay ineligible for publishing until an authorized reviewer records appropriate likeness rights in Assets after reviewing the clip. Fixture tests override the probe and are not validation of a live provider or codec runtime. Remotion project generation is unchanged.

## Apple Ads (AdServices)

The authenticated application backend first records the iOS install, then sends `{appId, installId, token, consent:{analytics:true}}` to `POST /ingest/v1/apple-ads-attribution`, using the **same server ingestion key**. Obtain a fresh token on-device using `AAAttribution.attributionToken()`. Never include a server ingestion secret in the app. Bind the authenticated application/session to its install ID in the relay.

The server exchanges the token at Apple's documented plain-text endpoint, retries a premature 404 at five-second intervals (at most three attempts), rejects the documented developer test payload, and requires current analytics consent. Tokens are never persisted. Evidence contains the minimized provider response and a hashed token identity to prevent reuse across installations. Canonical campaign IDs are `apple_ads:<orgId>:<campaignId>`; the attribution dashboard shows these as `apple_ads_adservices` telemetry with evidence. The application binding is asserted by the authenticated backend, not independently returned by Apple. Provider responses without campaign fields remain unavailable, and no-match responses do not establish organic acquisition.

Official specification checked: [Apple AdServices attributionToken](https://developer.apple.com/documentation/AdServices/AAAttribution/attributionToken()). A token has a 24-hour lifetime; fresh device tokens and real campaign traffic are required for live validation.

Campaign reporting is now implemented separately through Apple's documented Campaign Management API v5. See configuration below. AdServices remains unchanged; aggregate App Store reports are never repurposed as campaign attribution.

## Incremental provider work (PR #32)

### Apple Ads reporting

Create an encrypted `apple_ads` connection through the existing owner/MFA Connections API.
Use the organization's numeric ID as `externalAccountId`, credentials `{clientId, teamId, keyId,
privateKeyPem}`, and owner-approved metadata `{reportingTermsApproved:true}`. The adapter generates
a short-lived ES256 client secret, exchanges it for an OAuth token, and reads campaign reports.
No campaign/budget mutation endpoint is implemented. Report import is manual, never a new live schedule.

`POST /v1/app/apple-ads/reports` accepts `{connectionId,start,end}` for completed UTC days in the
past 90 days. `GET` at that path returns evidence-backed revisions; repeated identical reports reuse
evidence. Bounded pagination, organization checks, preserved decimal spend/currency, null missing
metrics and connection revocation protect the read path. Campaign keys match AdServices
`apple_ads:<orgId>:<campaignId>`. The Attribution page displays reports separately, filtered to their
provider-reported app ID, without summing overlapping intervals. Credentials/account permissions and
real-provider validation are still external requirements. Tests use fixtures only.

Verified official contracts: [OAuth](https://developer.apple.com/documentation/apple_ads/implementing-oauth-for-the-apple-search-ads-api),
[campaign reports](https://developer.apple.com/documentation/apple_ads/get-campaign-level-reports),
[request](https://developer.apple.com/documentation/apple_ads/reportingrequest),
[response](https://developer.apple.com/documentation/apple_ads/reportingresponse).

### Discovery

The provider interface now supports provider identity, terms and conservative result normalization.
Brave's [documented Web Search API](https://api-dashboard.search.brave.com/api-reference/web/search/get)
is implemented using an encrypted `brave_search` connection with `{apiKey}`. An owner must provision
the plan/key separately; no subscription or billing was activated. Legal approval must explicitly
cover the selected provider's result use **and storage as evidence**, under the owner's actual plan.

Discovery settings accept `provider: app_store | brave_web | brave_google_play` and `connectionId`.
The last option queries Brave's index with a Play listing restriction; it is **not** Google's app
catalogue. Google's [publishing API](https://developers.google.com/android-publisher) does not supply
a public competitor-search contract. Direct Google Play search remains unavailable. No scraping fallback.
Brave results are secondary evidence, confidence-capped and review-only; package/domain identities
deduplicate runs. Enrollment proposes pending sources and never approves crawling. Worker pacing and
bounded retry/backoff honor rate limits; long Retry-After defers to a later run. Country selection applies
to Apple search; Brave queries deliberately use provider-default geographic coverage.

### Video investigation: still disabled

Investigated Google's Veo via the official [video guide](https://ai.google.dev/gemini-api/docs/video)
and [pricing](https://ai.google.dev/gemini-api/docs/pricing). Current guide redirects prevented verification
of a complete stable submit/poll/download contract in this session. No verified replay/idempotency
guarantee, request charge-cap enforcement or authoritative per-job actual-billing contract was established.
Those are required by `GenerativeVideoProvider`; a public price estimate cannot replace actual billing.
The registry remains empty. Owner-approved paid-tier access, exact model/output licence, current API
contract, billing reconciliation and compatibility with silent H.264 QA are required before implementing
or enabling this adapter. No fake API endpoint, dependency, billing activation or relaxed reservation was added.
