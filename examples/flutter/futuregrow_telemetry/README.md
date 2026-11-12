# FUTUREGROW app telemetry (Flutter example)

Optional Layer 2 for M19 App Growth (P3-07): consented **first open**, **activation**, **session** and
**conversion** events, plus the Google Play **Install Referrer** for campaign attribution. Official
store reports (Layer 1) work without it; the two are shown side by side and never added together.

## How data flows

```
app (this client) ──JSON──▶ your backend (relay_example.dart) ──server key──▶ FUTUREGROW
                                                        POST /ingest/v1/app-installs
                                                        POST /ingest/v1/app-events
```

* The app never contains the FUTUREGROW server key (`fgk_sk_…`). Create it in FUTUREGROW
  (Customers & consent › Ingestion keys, kind *server*) and store it only on your backend.
* Nothing is sent until `setAnalyticsConsent(true)`. FUTUREGROW also checks the profile's current
  analytics consent and drops events of withdrawn or expired grants.
* `first_open` and `activation` are sent once per install with a stable event id, so a retry is
  recognised as the same event; FUTUREGROW refuses a reused id with different data, events in the
  future, events before the install and events older than 30 days (possible replay).
* `installReferrer` is the raw Play string; FUTUREGROW keeps only the UTM fields it needs and drops
  click identifiers. iOS has no referrer; do not invent one.

## Use

```dart
final telemetry = FutureGrowTelemetry(
  relayUrl: Uri.parse('https://api.your-app.example/telemetry'),
  appId: 'com.example.app', platform: 'android', appVersion: '2.2.0+7',
  store: SharedPrefsStore(), readInstallReferrer: readPlayInstallReferrer,
  relayHeaders: () async => {'authorization': 'Bearer ${await appSessionToken()}'},
);
await telemetry.setAnalyticsConsent(userAgreed);
await telemetry.recordInstall(userId: currentUserId);
await telemetry.recordEvent('first_open');
// after the user completes the step that defines "activated" for your app:
await telemetry.recordEvent('activation');
await telemetry.recordEvent('conversion', occurrenceId: 'backend-transaction-opaque-id', conversionName: 'subscription_started', valueMicros: 4990000, currency: 'USD');
```

`fixtures/` holds the exact payloads; FUTUREGROW's test suite parses them with the server schemas
(`packages/core/test/telemetry-attribution.test.ts`), so a schema change that breaks this client fails CI.

This example is not wired into any published app. Adding it to a real app (for example EPS TOPIK
Bangla) is a separate change to that app, with its own privacy notice and store data-safety update.

## Delivery and backend contract

The client now persists a bounded FIFO outbox (500 records) and serializes concurrent calls. An
offline retry preserves the exact timestamp, event ID and payload across app restarts. Install
acknowledgement precedes event delivery. Exponential retry delay is capped at one hour; call `flush()`
on foreground resume and connectivity restoration. Permanent validation/authentication failures
remain queued and set `lastFailure`; resolve the integration problem rather than reporting success.
The server refuses events older than 30 days. Queue overflow throws without discarding an event.

Use a single client per app with an atomic durable `TelemetryStore`; use protected storage when
application identifiers require it. State is namespaced by platform and app ID. The old demonstration
namespace is not migrated automatically because no published app deployment has been verified.
Consent withdrawal stops new sends and purges pending payloads; the backend must also revoke consent
for already delivered profiles. A request already sent cannot be recalled.

`relayHeaders` supplies the application's session/attestation headers, **never** a FUTUREGROW key.
The updated relay requires `authorizeAndRateLimit` to return a trusted `RelayAuthorization` binding
the configured app/platform and installation to the session and current consent. It replaces
client-supplied user identity, rejects unknown message kinds and cross-app IDs, and requires
`verifyConversion` to validate conversions against the backend's authoritative transaction/event.
Forward the relay's response status **and body**. Neither mobile nor backend follows redirects with
credentials. Host authentication, durable rate limiting and purchase verification must be supplied
by the actual application backend; the example does not implement those services.

For iOS, provide `readAppleAttributionToken` using native `AAAttribution.attributionToken()` and call
`recordAppleAttribution()` after consent. Tokens are fetched at send time and never stored in the
outbox. The relay forwards to `/ingest/v1/apple-ads-attribution`; unavailable/expired tokens remain
retryable. No iOS Install Referrer is invented.

Run `dart pub get`, `dart analyze`, and `dart test` in this directory. Tests cover both app integration
profiles using fixtures; they do not verify either published app. See
[`APP_INTEGRATIONS.md`](APP_INTEGRATIONS.md) for exact external integration interfaces.
