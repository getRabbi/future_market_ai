// FUTUREGROW app telemetry client (P3-07, Layer 2): first open, activation, sessions and optional
// conversions, sent only with the user's analytics consent.
//
// The app never holds a FUTUREGROW server key. It posts to YOUR backend (relayUrl), which adds the
// server ingestion key (fgk_sk_...) and forwards to FUTUREGROW:
//   POST /ingest/v1/app-installs   (once per install, with the Play Install Referrer string)
//   POST /ingest/v1/app-events     (first_open, activation, session, conversion)
// See ../README.md and relay/relay_example.dart.
//
// Payloads match the server schemas exactly (fixtures in ../fixtures are checked by FUTUREGROW's tests).

import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

/// Persists the install id and which one-time events were already sent (e.g. shared_preferences).
abstract class TelemetryStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

/// Reads the Google Play Install Referrer (e.g. via the play_install_referrer plugin). Return null
/// on iOS or when unavailable; never synthesize one.
typedef InstallReferrerReader = Future<String?> Function();

class FutureGrowTelemetry {
  FutureGrowTelemetry({
    required this.relayUrl,
    required this.appId,
    required this.platform,
    required this.appVersion,
    required this.store,
    this.readInstallReferrer,
    http.Client? client,
    DateTime Function()? clock,
  })  : _http = client ?? http.Client(),
        _now = clock ?? DateTime.now;

  /// Your backend endpoint that relays to FUTUREGROW with the server key.
  final Uri relayUrl;

  /// Package name (Android) or bundle id (iOS), e.g. com.example.app.
  final String appId;

  /// 'android' or 'ios'.
  final String platform;

  /// e.g. 2.2.0+7.
  final String appVersion;
  final TelemetryStore store;
  final InstallReferrerReader? readInstallReferrer;
  final http.Client _http;
  final DateTime Function() _now;

  bool _consent = false;

  /// Call with the user's current analytics choice; nothing is sent while it is false.
  void setAnalyticsConsent(bool granted) => _consent = granted;

  Future<String> _installId() async {
    final existing = await store.read('fg.installId');
    if (existing != null) return existing;
    final id = _uuid();
    await store.write('fg.installId', id);
    await store.write('fg.installedAt', _now().toUtc().toIso8601String());
    return id;
  }

  /// Once per install, right after the first launch and the consent choice.
  Future<void> recordInstall({String? userId}) async {
    if (!_consent || await store.read('fg.installSent') == '1') return;
    final installId = await _installId();
    final referrer = platform == 'android' && readInstallReferrer != null ? await readInstallReferrer!() : null;
    final body = <String, Object?>{
      'kind': 'install',
      'platform': platform,
      'appId': appId,
      'installId': installId,
      if (userId != null) 'userId': userId,
      'installedAt': await store.read('fg.installedAt'),
      if (referrer != null) 'installReferrer': referrer,
      'consent': {'analytics': true},
    };
    if (await _send(body)) await store.write('fg.installSent', '1');
  }

  /// first_open and activation are sent once; session every app start; conversion when it happens.
  Future<void> recordEvent(String event, {String? conversionName, int? valueMicros, String? currency}) async {
    if (!_consent) return;
    const once = {'first_open', 'activation'};
    if (once.contains(event) && await store.read('fg.sent.$event') == '1') return;
    final body = <String, Object?>{
      'kind': 'event',
      'appId': appId,
      'platform': platform,
      'installId': await _installId(),
      // A stable id per occurrence: a retried request is recognised as the same event.
      'eventId': once.contains(event) ? '${event}_${await _installId()}' : _uuid(),
      'event': event,
      'occurredAt': _now().toUtc().toIso8601String(),
      'appVersion': appVersion,
      'consent': {'analytics': true},
      if (event == 'conversion')
        'conversion': {
          'name': conversionName,
          if (valueMicros != null) 'valueMicros': valueMicros,
          if (currency != null) 'currency': currency,
        },
    };
    if (await _send(body) && once.contains(event)) await store.write('fg.sent.$event', '1');
  }

  Future<bool> _send(Map<String, Object?> body) async {
    try {
      final r = await _http.post(relayUrl, headers: {'content-type': 'application/json'}, body: jsonEncode(body));
      return r.statusCode >= 200 && r.statusCode < 300;
    } catch (_) {
      return false; // offline: the next launch retries; one-time events stay unsent until accepted
    }
  }

  static String _uuid() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }
}
