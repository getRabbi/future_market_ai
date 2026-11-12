# EPS TOPIK Bangla and Ecoms BD readiness

Initial readiness instructions below were written before either mobile repository was available.
The incremental PR #32 pass subsequently accessed both repositories: Ecoms BD now has a separate
`feat/futuregrow-telemetry-integration` branch; EPS already had telemetry and has a documentation-only
`feat/futuregrow-telemetry-readiness` branch. See `docs/REMAINING_DEVELOPMENT_CHECKPOINT.md` for
commits and validation. Do not install a duplicate client into EPS. Ecoms is a seller app: its
actual integration measures completed seller onboarding and verified Ecoms subscription payments,
not carts or the seller's customer orders. The original generic examples below remain contracts,
not a description of either application's current layout.

## Files to integrate in each external repository

1. Copy this package to `packages/futuregrow_telemetry/` (omit `.dart_tool` and build output). Add a
   path dependency in the app's existing `pubspec.yaml`.
2. Create `lib/integrations/futuregrow.dart`. Construct one `FutureGrowTelemetry` using the app's
   verified Android applicationId/iOS bundle ID, package version, HTTPS backend endpoint, current
   consent, atomic durable `TelemetryStore`, and session/attestation `relayHeaders` callback.
   Do not copy fixture app IDs into production configuration.
3. Implement `InstallReferrerReader` through the app's supported Google Play Install Referrer
   integration. Preserve UTM values from FUTUREGROW's registered campaign link exactly. Return null
   only when unavailable/unsupported; throw for temporary failures so the install is not prematurely
   acknowledged as unattributed. No guessed campaign, device fingerprint or click ID is needed.
4. If an iOS build exists, implement `AppleAttributionTokenReader` in the app's native integration
   using AdServices. Wire the callback into `lib/integrations/futuregrow.dart`; no token is persisted.
5. Create `backend/integrations/futuregrow_relay.dart` **only if that backend is Dart** by adapting
   `relay/relay_example.dart`. For another backend language, implement the same JSON/authentication
   contract in its existing router. Required functions: `authorizeAndRateLimit()` and
   `verifyConversion(payload)`. Store `fgk_sk_...` only in the backend secret store. Bind installs
   to authenticated or attested sessions, enforce per-session/device quotas and verify consent
   from backend state. Do not accept app identity or a paid conversion merely because the client
   supplied it. Forward successful acknowledgements unchanged; preserve retries' payloads.
6. Locate the real lifecycle, consent, activation and transaction callback files in each repository
   and call the hooks below. Their current filenames cannot be supplied without those repositories.

## EPS TOPIK Bangla

Use `EpsTopikTelemetry` from `lib/app_integrations.dart`. Call `foreground()` after loading consent
on startup/resume. Call `lessonCompleted()` from the first successfully completed lesson callback
if the owner accepts that activation definition. If subscriptions exist, call
`subscriptionConfirmed(transactionId, amountMicros, currency)` only after backend confirmation;
otherwise omit this hook. The relay must verify transaction ownership, amount and currency. The
opaque stable transaction ID deduplicates repeated callbacks. Existing EPS publishing/autopilot
automation is not altered by this client.

## Ecoms BD

Use `EcomsBdTelemetry`. Call `foreground()` after consent, `cartCreated()` at first durable cart
creation if the owner accepts that activation definition, and `orderPaid(orderId, amountMicros,
currency)` after the backend marks the order paid. The relay verifies the actual order, ownership,
payment state, amount and currency. Do not emit purchases at button click, checkout start or an
unverified client success screen. Use an opaque stable event/order ID.

## Acceptance in each external repository

The package tests run the same restart/retry/concurrency/consent and identity checks for both named
profiles. Actual app acceptance still needs: offline startup then reconnect, consent denial and
withdrawal, repeated lifecycle/transaction callbacks, a real Play test-install referrer, and (if
iOS exists) a production AdServices record. Confirm resulting evidence belongs to the correct tenant,
app and campaign. Register the brand/app and campaign identity in FUTUREGROW before interpreting
report attribution. Do not send completeness declarations unless the backend can prove all events
in that interval have been acknowledged; no telemetry is not evidence of zero conversions.
