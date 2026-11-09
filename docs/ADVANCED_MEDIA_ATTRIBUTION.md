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

Campaign names, spend, impressions and Apple Ads management/report reconciliation are **not implemented**: an authorized account, current reporting API contract and credentials are still needed. AdServices campaign identifiers are supported; aggregate App Store reports are never repurposed as campaign attribution. Existing consented downstream first-open/activation/conversion observations remain separate from causal incrementality.
