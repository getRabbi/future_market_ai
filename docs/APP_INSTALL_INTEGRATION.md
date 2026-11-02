# Existing Android install ingestion contract

Status: FUTUREGROW supports application-scoped, evidence-backed backend install and conversion-event ingestion and campaign reports. No mobile repository was inspected or modified. Play Console import, verified tracking-coverage declarations and conversion-driven Studio optimization remain unfinished.

## Trust boundary

The Android/Flutter application sends consented installation telemetry to **its own authenticated application backend**. That backend validates the application, installation identity, timestamps and consent, and forwards accepted events to FUTUREGROW. Only the backend holds the tenant's server ingestion key in its secret store. Never include that key in an APK, browser bundle or client configuration.

Create a server ingestion key through the existing customer-ingestion configuration. Browser keys are rejected by the install endpoint. The key selects the tenant; the request does not select a tenant. The current endpoint has a 600-request/minute route limit.

## Backend request

`POST /ingest/v1/app-installs`

Headers: `Authorization: Bearer <server-ingestion-key>`, `Content-Type: application/json`.

Example fixture (replace all identifiers and timestamps with actual observations):

```json
{
  "appId": "com.rabbi.eps_topik_bangla",
  "platform": "android",
  "installId": "installation-random-uuid",
  "installedAt": "2026-11-02T08:10:00Z",
  "installReferrer": "utm_source=facebook&utm_medium=organic_social&utm_campaign=eps_daily&utm_content=v-safety-1",
  "referrerClickAt": "2026-11-02T08:08:00Z",
  "consent": { "analytics": true },
  "context": { "country": "BD", "locale": "bn-BD", "timezone": "Asia/Dhaka" }
}
```

`appId` identifies the application (2–200 letters, digits, dots, underscores or hyphens, starting with a letter/digit). It is required for scoped conversion reports and events; omission remains supported for legacy callers, whose records are excluded from scoped reports. Choose a stable ID such as the package name. `userId` is optional; supply it only from the application's authenticated identity and with analytics consent. `installId` is required (8–200 characters); use a random per-installation identifier, not a hardware or advertising identifier. Preserve it across transport retries. `installedAt` is required; timestamps are ISO 8601 with an offset. The raw referrer is optional and limited to 2,000 characters. Only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` survive minimization (200 characters each). Click identifiers are discarded.

A successful response is HTTP 202, for example:

```json
{ "recorded": true, "attributionMethod": "play_install_referrer", "profileLinked": true }
```

Replaying the same tenant/application/platform/installation identity does not insert another install (`recorded: false`). Retries return the original attribution result. Retain the same payload on retries; this is deduplication, not an update API. Installation, event, identity, evidence and audit writes commit atomically. Installation timestamps more than five minutes in the future and clicks after installation are rejected. Do not interpret attribution labels as store verification: the endpoint trusts the authenticated sender's telemetry, and does not cryptographically attest the Android device or query Play Console. Legacy records are not automatically reassigned to an application.

Without analytics consent, existing M19 stores a minimal unattributed install without campaign fields or a profile link. Do not send analytics events or optional identity/context when consent is absent. Decide whether the application's consent policy permits even that minimal event before enabling forwarding.

## Minimal mobile and backend work outside this repository

1. Retrieve the install referrer and its actual timestamps using the official Play Install Referrer service. A Flutter platform bridge can call the Android library. Persist the result and installation identifier, and close the service connection. The service supplies the referrer plus click and installation timestamps; see [Google's API documentation](https://developer.android.com/google/play/installreferrer).
2. Send it to the application's backend with the application's own authentication. The backend must validate it, reject implausible or reversed timestamps and enforce replay/abuse controls. It must not accept a client-supplied FUTUREGROW tenant or server key.
3. Convert observed epoch seconds to ISO timestamps. Do not replace installation time with forwarding time or first-open time. Retry transient forwarding failures with the same installation identity and original data.
4. Send actual first opens, activation and later use through `/ingest/v1/app-events` as described below. Use stable event IDs and original occurrence times; never infer these events from an install or link click.

## Conversion events and reports

`POST /ingest/v1/app-events` uses the same server-key authorization and 600-request/minute route limit. A scoped install must already exist. Example fixture:

```json
{
  "appId": "com.rabbi.eps_topik_bangla",
  "platform": "android",
  "installId": "installation-random-uuid",
  "eventId": "stable-event-random-uuid",
  "event": "first_open",
  "occurredAt": "2026-11-02T08:11:00Z",
  "consent": { "analytics": true }
}
```

Allowed events are `first_open`, `activation` and `session`. The application backend defines a meaningful activation action and reports it only when it happens. A session in the install's age interval [7 days, 14 days) supports week-one retention after that interval fully elapses. Events before installation or more than five minutes in the future are rejected. Retries with the same event ID are deduplicated; changing its event kind or occurrence time produces a conflict. Consent-denied events are not stored. Successful accepted events return HTTP 202 with `recorded: true` and an `evidenceId`; duplicate events return `recorded: false` with the original evidence ID.

The authenticated control-plane endpoints are `GET /v1/app/applications` and `GET /v1/app/campaigns?appId=...&platform=android&from=<ISO>&to=<ISO>`. Dates form a half-open install interval, limited to 366 days. Reports group campaign, source, medium, content and attribution method within one application/platform/tenant. Evidence references include installs and representative supporting events for at most 50 installations per campaign group; `evidenceReferencesTruncated` identifies larger groups while counts still cover every supported install. Generic event ingestion cannot manufacture a conversion by attaching an unrelated evidence ID: the report checks matching observation content, timestamp and source.

The App growth screen presents the last 90 days of supported observations. Counts are observed backend events, not total Play acquisitions. Clicks and outcomes without evidence remain null/unavailable. No rate or winner is inferred without tracking-coverage evidence. Deletion erases profile events and evidence content, detaches install evidence and attribution, and prevents new linked events from reviving that deleted installation.

## Remaining FUTUREGROW work

- Add verified tracking-coverage declarations so an observed zero can be distinguished from incomplete reporting, and event-aware denominators can support conversion rates.
- Add explicit program/channel-account mappings; the new reports isolate application/platform/campaign dimensions but do not infer which Page or account owns an arbitrary campaign label. Legacy cohorts remain separate historical summaries.
- Build a supported, credential-gated Play Console report adapter, with source verification and honest availability labels. Existing `syncAppStoreSales()` imports Apple's reports, not Google Play reports.
- The supported source to evaluate is the account's private Google Cloud Storage reporting bucket, using a service account granted the appropriate Play Console access. Google documents monthly CSV exports, delayed daily updates and UTF-16 conversion requirements; this is a separate source from device referrers. See [Google's report-export documentation](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en). No credentials, reports or access permission were fabricated or connected here.
- Connect sufficiently supported, app/program/account-scoped observations to Studio learning. Do not treat a generated referrer URL as evidence of a click or install.

Code anchors: `packages/core/src/modules/m19-app-growth/index.ts` (`InstallSchema`, `recordInstall`, `acquisitionCohorts`), `apps/api/src/routes/public-channel-routes.ts`, `apps/api/src/routes/public-routes.ts`, and `apps/api/test/public-channels.test.ts`.

Deployment uses the normal migration-on-start process for additive migration `0012_app_conversion_evidence.sql`. Existing callers may omit `appId`; their records remain legacy observations. Rolling back to the previous application binary does not require dropping the new nullable columns. Do not delete collected evidence or reassign legacy installs as part of rollback.
