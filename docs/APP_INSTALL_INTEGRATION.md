# Existing Android install ingestion contract

> **Campaign identity (D-041):** links the content studio puts on posts now carry `utm_content=<kind>-<yyyymmdd>` (one per program per day) and are registered with the brand, program, plan item, post and channel. Pass the Play Install Referrer string through unchanged; FUTUREGROW maps `(appId, utm_campaign, utm_content)` to that registry. The application must be linked to the brand (`POST /v1/brands/:id/apps` with its Play listing URL) for installs to be attributed; otherwise they appear as `unregistered`.

Status: FUTUREGROW supports application-scoped, evidence-backed backend installs, conversion events, completeness reconciliation and campaign reports. No mobile repository was inspected or modified. Play Console import, account/program mapping and conversion-driven Studio optimization remain unfinished. Backend declarations do not independently verify device instrumentation or total store coverage.

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

Without analytics consent, existing M19 stores a minimal unattributed install without campaign fields or a profile link. Do not send analytics events or optional identity/context when consent is absent. A recorded profile-level analytics denial, withdrawal or expired grant overrides a true payload flag: new linked installs and completeness declarations are rejected, app events are not recorded, and the profile is excluded from campaign reports. Renew consent through the existing consent workflow, not by replaying telemetry. Decide whether the application's consent policy permits even the minimal unattributed event before enabling forwarding.

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

The App growth screen presents the last 90 days of supported observations. Counts are observed backend events, not total Play acquisitions. Clicks and outcomes without evidence remain null/unavailable. No rate or winner is inferred. Deletion erases profile events and evidence content, detaches install evidence, attribution and coverage, and prevents new linked events from reviving that deleted installation.

## Backend completeness reconciliation

`POST /ingest/v1/app-event-coverage` requires the same server key, consent and 600-request/minute limit. Send a declaration only after all events for that installation/event kind in `[installedAt, through)` have been durably delivered and acknowledged. The source backend must actually track that event and know that its interval is complete. Silence, missing device telemetry, disabled tracking and lack of consent are not declarations of zero.

```json
{
  "appId": "com.rabbi.eps_topik_bangla",
  "platform": "android",
  "installId": "installation-random-uuid",
  "event": "activation",
  "through": "2026-11-09T08:10:00Z",
  "eventCount": 0,
  "digest": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "consent": { "analytics": true }
}
```

The example is a fixture, usable only after its `through` time has elapsed. Each declaration concerns one of `first_open`, `activation`, or `session`. `through` is exclusive, must be later than installation and no later than FUTUREGROW's current time, and cannot move backwards while a declaration remains valid. Include all distinct event IDs of that kind in the interval, at most 10,000; do not count retries. Compute `digest` as follows (UTF-8 SHA-256, lowercase hex):

```js
// Runs in the application's backend, using the acknowledged original event payloads.
import { createHash } from 'node:crypto';
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const lines = intervalEvents.map(({ eventId, occurredAt }) =>
  `${sha256(eventId)}:${new Date(occurredAt).toISOString()}`
).sort();
const declaration = { eventCount: lines.length, digest: sha256(lines.join('\n')) };
```

FUTUREGROW compares both count and digest against admitted observations for the exact application/platform/installation, event kind and interval. Mismatches return conflict (HTTP 409). Identical retries return `recorded: false` and the same evidence ID. A newly arrived event inside a declared interval invalidates that event kind's declaration atomically; deliver the remaining events and reconcile again. Events at or after `through` leave the earlier declaration intact. Cleared/revoked supporting evidence makes the reported window unavailable. Declarations and invalidations are audited.

Campaign reports add `reconciledWindows.firstOpens7d`, `activations7d` and `retainedWeek1`. First opens and activation use installation age `[0,7 days)`; retention requires a session at age `[7,14 days)`. Each includes `eligibleInstalls` (fully elapsed windows), `reconciledInstalls`, `complete`, `value`, and `basis: reconciled_backend_declaration`. A value, including a real zero, is available only if there is at least one mature install and **every** mature install in the group has the matching valid declaration. Incomplete and immature windows remain null. Existing `metrics` retain as-of observed-event semantics and are not silently reinterpreted. Coverage does not establish that every installation was reported, that instrumentation works correctly, or that a campaign caused an outcome; no conversion rate or statistical winner is produced.

## Remaining FUTUREGROW work

- Backend interval reconciliation is implemented. Independent store coverage, device instrumentation verification and account-qualified comparable rates still need genuine connected sources and explicit mappings.
- Add explicit program/channel-account mappings; the new reports isolate application/platform/campaign dimensions but do not infer which Page or account owns an arbitrary campaign label. Legacy cohorts remain separate historical summaries.
- Build a supported, credential-gated Play Console report adapter, with source verification and honest availability labels. Existing `syncAppStoreSales()` imports Apple's reports, not Google Play reports.
- The supported source to evaluate is the account's private Google Cloud Storage reporting bucket, using a service account granted the appropriate Play Console access. Google documents monthly CSV exports, delayed daily updates and UTF-16 conversion requirements; this is a separate source from device referrers. See [Google's report-export documentation](https://support.google.com/googleplay/android-developer/answer/6135870?hl=en). No credentials, reports or access permission were fabricated or connected here.
- Connect sufficiently supported, app/program/account-scoped observations to Studio learning. Do not treat a generated referrer URL as evidence of a click or install.

Code anchors: `packages/core/src/modules/m19-app-growth/index.ts` (`InstallSchema`, `recordInstall`, `acquisitionCohorts`), `apps/api/src/routes/public-channel-routes.ts`, `apps/api/src/routes/public-routes.ts`, and `apps/api/test/public-channels.test.ts`.

Deployment uses the normal migration-on-start process for additive migrations `0012_app_conversion_evidence.sql` and `0013_app_event_coverage.sql`. The latter defaults existing installations to unknown coverage (`{}`). Existing callers may omit `appId`; their records remain legacy observations. Rolling back to the previous application binary does not require dropping the new columns. Do not delete collected evidence or reassign legacy installs as part of rollback.
