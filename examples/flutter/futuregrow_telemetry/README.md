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
);
telemetry.setAnalyticsConsent(userAgreed);
await telemetry.recordInstall(userId: currentUserId);
await telemetry.recordEvent('first_open');
// after the user completes the step that defines "activated" for your app:
await telemetry.recordEvent('activation');
await telemetry.recordEvent('conversion', conversionName: 'subscription_started', valueMicros: 4990000, currency: 'USD');
```

`fixtures/` holds the exact payloads; FUTUREGROW's test suite parses them with the server schemas
(`packages/core/test/telemetry-attribution.test.ts`), so a schema change that breaks this client fails CI.

This example is not wired into any published app. Adding it to a real app (for example EPS TOPIK
Bangla) is a separate change to that app, with its own privacy notice and store data-safety update.
