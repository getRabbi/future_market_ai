# Existing Android install ingestion contract

Status: the FUTUREGROW endpoint below already exists and is fixture-tested. No mobile repository was inspected or modified. This document does not claim that campaign reporting, Play Console import or conversion-driven Studio optimization is complete.

## Trust boundary

The Android/Flutter application sends consented installation telemetry to **its own authenticated application backend**. That backend validates the application, installation identity, timestamps and consent, and forwards accepted events to FUTUREGROW. Only the backend holds the tenant's server ingestion key in its secret store. Never include that key in an APK, browser bundle or client configuration.

Create a server ingestion key through the existing customer-ingestion configuration. Browser keys are rejected by the install endpoint. The key selects the tenant; the request does not select a tenant. The current endpoint has a 600-request/minute route limit.

## Backend request

`POST /ingest/v1/app-installs`

Headers: `Authorization: Bearer <server-ingestion-key>`, `Content-Type: application/json`.

Example fixture (replace all identifiers and timestamps with actual observations):

```json
{
  "platform": "android",
  "installId": "installation-random-uuid",
  "installedAt": "2026-11-02T08:10:00Z",
  "installReferrer": "utm_source=facebook&utm_medium=organic_social&utm_campaign=eps_daily&utm_content=v-safety-1",
  "referrerClickAt": "2026-11-02T08:08:00Z",
  "consent": { "analytics": true },
  "context": { "country": "BD", "locale": "bn-BD", "timezone": "Asia/Dhaka" }
}
```

`userId` is optional; supply it only from the application's authenticated identity and with analytics consent. `installId` is required (8–200 characters); use a random per-installation identifier, not a hardware or advertising identifier. Preserve it across transport retries. `installedAt` is required; timestamps are ISO 8601 with an offset. The raw referrer is optional and limited to 2,000 characters. Only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` survive minimization (200 characters each). Click identifiers are discarded.

A successful response is HTTP 202, for example:

```json
{ "recorded": true, "attributionMethod": "play_install_referrer", "profileLinked": true }
```

Replaying the same tenant/platform/installation identity does not insert another install (`recorded: false`). Retain the same payload on retries; this is deduplication, not an update API. Do not interpret attribution labels as store verification: the current endpoint trusts the authenticated sender's telemetry, and does not cryptographically attest the Android device or query Play Console.

Without analytics consent, existing M19 stores a minimal unattributed install without campaign fields or a profile link. Do not send analytics events or optional identity/context when consent is absent. Decide whether the application's consent policy permits even that minimal event before enabling forwarding.

## Minimal mobile and backend work outside this repository

1. Retrieve the install referrer and its actual timestamps using the official Play Install Referrer service. A Flutter platform bridge can call the Android library. Persist the result and installation identifier, and close the service connection. The service supplies the referrer plus click and installation timestamps; see [Google's API documentation](https://developer.android.com/google/play/installreferrer).
2. Send it to the application's backend with the application's own authentication. The backend must validate it, reject implausible or reversed timestamps and enforce replay/abuse controls. It must not accept a client-supplied FUTUREGROW tenant or server key.
3. Convert observed epoch seconds to ISO timestamps. Do not replace installation time with forwarding time or first-open time. Retry transient forwarding failures with the same installation identity and original data.
4. Send actual first opens, activation and later use as separate consented events through the existing `/ingest/v1/events` flow. Use stable event message IDs and original occurrence times; never infer these events from an install or link click.

## Remaining FUTUREGROW work

- Bind installs and event identities to an explicit application/program scope before combining multiple apps in one tenant. The current install table has no app identifier; its deduplication scope is tenant + platform + hashed install ID.
- Add server-side timestamp consistency checks, auditable evidence linkage and atomic handling of install/event/audit writes. Current M19 writes these in separate transactions.
- Add campaign/content reporting and telemetry-coverage declarations so uninstrumented first opens, activation, retention and clicks remain unavailable rather than zero. Existing cohorts group by source/method and do not establish campaign conversion coverage or mature observation windows.
- Build a supported, credential-gated Play Console report adapter, with source verification and honest availability labels. Existing `syncAppStoreSales()` imports Apple's reports, not Google Play reports.
- Connect sufficiently supported, app/program/account-scoped observations to Studio learning. Do not treat a generated referrer URL as evidence of a click or install.

Code anchors: `packages/core/src/modules/m19-app-growth/index.ts` (`InstallSchema`, `recordInstall`, `acquisitionCohorts`), `apps/api/src/routes/public-channel-routes.ts`, `apps/api/src/routes/public-routes.ts`, and `apps/api/test/public-channels.test.ts`.
