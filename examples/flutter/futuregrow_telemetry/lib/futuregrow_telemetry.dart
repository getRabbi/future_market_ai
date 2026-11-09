// Consented telemetry through the application's authenticated backend. No server ingestion keys.
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;

/// Writes must be durable and atomic. Use one client per app/storage namespace.
abstract class TelemetryStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

typedef InstallReferrerReader = Future<String?> Function();
typedef AppleAttributionTokenReader = Future<String?> Function();
typedef RelayHeaders = Future<Map<String, String>> Function();

class FutureGrowTelemetry {
  FutureGrowTelemetry({
    required this.relayUrl,
    required this.appId,
    required this.platform,
    required this.appVersion,
    required this.store,
    required this.relayHeaders,
    this.readInstallReferrer,
    this.readAppleAttributionToken,
    http.Client? client,
    DateTime Function()? clock,
  })  : _http = client ?? http.Client(),
        _now = clock ?? DateTime.now {
    if (relayUrl.scheme != 'https' ||
        relayUrl.userInfo.isNotEmpty ||
        relayUrl.hasQuery ||
        relayUrl.hasFragment)
      throw ArgumentError(
          'Use an HTTPS backend relay URL without credentials or query parameters');
    if (!{'android', 'ios'}.contains(platform) ||
        !RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{1,199}$').hasMatch(appId) ||
        !RegExp(r'^[0-9A-Za-z.+_-]{1,40}$').hasMatch(appVersion))
      throw ArgumentError('Invalid app identity');
  }
  final Uri relayUrl;
  final String appId, platform, appVersion;
  final TelemetryStore store;
  final RelayHeaders relayHeaders;
  final InstallReferrerReader? readInstallReferrer;
  final AppleAttributionTokenReader? readAppleAttributionToken;
  final http.Client _http;
  final DateTime Function() _now;
  bool _consent = false;
  int _consentRevision = 0;
  Future<void> _tail = Future.value();
  String? lastFailure;
  String get _prefix => 'fg.$platform.$appId.';
  Future<String?> _read(String key) => store.read('$_prefix$key');
  Future<void> _write(String key, String value) =>
      store.write('$_prefix$key', value);
  Future<void> _serial(Future<void> Function() action) {
    final task = _tail.then((_) => action());
    _tail = task.catchError((Object _) {});
    return task;
  }

  /// Stops future sends immediately and erases unsent telemetry. Withdraw delivered data's
  /// consent separately in the backend; a request already sent cannot be recalled.
  Future<void> setAnalyticsConsent(bool granted) {
    final revision = ++_consentRevision;
    if (!granted) _consent = false;
    return _serial(() async {
      if (!granted) await _write('outbox', '[]');
      if (granted && revision == _consentRevision) _consent = true;
    });
  }

  Future<String> _installId() async {
    final existing = await _read('installId');
    if (existing != null) return existing;
    final id = _uuid();
    await _write('installedAt', _now().toUtc().toIso8601String());
    await _write('installId', id);
    return id;
  }

  Future<List<Map<String, dynamic>>> _queue() async =>
      (jsonDecode(await _read('outbox') ?? '[]') as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
  Future<void> _save(List<Map<String, dynamic>> queue) =>
      _write('outbox', jsonEncode(queue));
  Future<void> _enqueue(Map<String, Object?> payload, {String? once}) async {
    if (!_consent || (once != null && await _read('sent.$once') == '1')) return;
    final queue = await _queue();
    if (once != null && queue.any((e) => e['once'] == once)) return;
    if (queue.length >= 500)
      throw StateError('Telemetry outbox full; no event was discarded');
    queue.add({'payload': payload, 'once': once, 'attempts': 0, 'nextAt': 0});
    await _save(queue);
  }

  Future<void> _ensureInstall({String? userId}) async {
    if (!_consent || await _read('sent.install') == '1') return;
    if ((await _queue()).any((e) => e['once'] == 'install')) return;
    final id = await _installId();
    final referrer = platform == 'android' && readInstallReferrer != null
        ? await readInstallReferrer!()
        : null;
    await _enqueue({
      'kind': 'install',
      'platform': platform,
      'appId': appId,
      'installId': id,
      'installedAt': await _read('installedAt'),
      if (userId != null) 'userId': userId,
      if (referrer != null) 'installReferrer': minimizeReferrer(referrer),
      'consent': {'analytics': true},
    }, once: 'install');
  }

  Future<void> recordInstall({String? userId}) => _serial(() async {
        await _ensureInstall(userId: userId);
        await _flush();
      });

  /// Stable occurrenceId is required for conversions (use an opaque backend order/event ID).
  /// Offline retries reuse the entire persisted payload, including timestamp and event ID.
  Future<void> recordEvent(String event,
          {String? occurrenceId,
          String? conversionName,
          int? valueMicros,
          String? currency}) =>
      _serial(() async {
        if (!_consent) return;
        if (!{'first_open', 'activation', 'session', 'conversion'}
            .contains(event)) throw ArgumentError('Unknown event');
        if (event == 'conversion' &&
            (occurrenceId == null ||
                conversionName == null ||
                !RegExp(r'^[a-z0-9_]{2,40}$').hasMatch(conversionName)))
          throw ArgumentError(
              'Conversions need a stable occurrenceId and conversionName');
        if ((valueMicros == null) != (currency == null) ||
            (valueMicros != null && valueMicros < 0) ||
            (currency != null && !RegExp(r'^[A-Z]{3}$').hasMatch(currency)))
          throw ArgumentError(
              'Supply nonnegative valueMicros with an ISO currency');
        if (occurrenceId != null &&
            (occurrenceId.length < 8 || occurrenceId.length > 180))
          throw ArgumentError('occurrenceId must contain 8-180 characters');
        await _ensureInstall();
        final id = await _installId();
        final once = {'first_open', 'activation'}.contains(event)
            ? event
            : occurrenceId != null
                ? '$event:$occurrenceId'
                : null;
        await _enqueue({
          'kind': 'event',
          'appId': appId,
          'platform': platform,
          'installId': id,
          'eventId': once != null ? '${event}_${occurrenceId ?? id}' : _uuid(),
          'event': event,
          'occurredAt': _now().toUtc().toIso8601String(),
          'appVersion': appVersion,
          'consent': {'analytics': true},
          if (event == 'conversion')
            'conversion': {
              'name': conversionName,
              if (valueMicros != null) 'valueMicros': valueMicros,
              if (currency != null) 'currency': currency
            },
        }, once: once);
        await _flush();
      });

  /// Fetch a fresh native AdServices token at send time; never persist tokens in the outbox.
  Future<void> recordAppleAttribution() => _serial(() async {
        if (!_consent || platform != 'ios' || readAppleAttributionToken == null)
          return;
        await _ensureInstall();
        await _enqueue({
          'kind': 'apple_attribution',
          'appId': appId,
          'installId': await _installId(),
          'consent': {'analytics': true}
        }, once: 'apple_attribution');
        await _flush();
      });

  /// Call at startup, foreground resume and connectivity restoration; no background tracking.
  Future<void> flush() => _serial(_flush);
  Future<void> _flush() async {
    if (!_consent) return;
    final queue = await _queue();
    while (_consent && queue.isNotEmpty) {
      final entry = queue.first;
      if ((entry['nextAt'] as int) > _now().millisecondsSinceEpoch) return;
      final body = Map<String, dynamic>.from(entry['payload'] as Map);
      try {
        if (body['kind'] == 'apple_attribution') {
          final token = await readAppleAttributionToken?.call();
          if (token == null)
            throw StateError('Native Apple attribution token unavailable');
          body['token'] = token;
        }
        final headers = await relayHeaders();
        if (headers.values.any((v) => v.contains('fgk_sk_')))
          throw StateError(
              'Server ingestion secrets must not be used by mobile clients');
        if (!_consent) return;
        final request = http.Request('POST', relayUrl)
          ..followRedirects = false
          ..headers.addAll({...headers, 'content-type': 'application/json'})
          ..body = jsonEncode(body);
        final response =
            await _http.send(request).timeout(const Duration(seconds: 30));
        final result = await http.Response.fromStream(response)
            .timeout(const Duration(seconds: 30));
        if (!_consent) return;
        if (result.statusCode < 200 || result.statusCode >= 300)
          throw StateError('Relay returned HTTP ${result.statusCode}');
        if (result.body.isNotEmpty) {
          final ack = jsonDecode(result.body);
          if (ack is Map && ack['recorded'] == false && ack['reason'] != null)
            throw StateError('Backend declined telemetry');
        }
        if (entry['once'] != null) await _write('sent.${entry['once']}', '1');
        queue.removeAt(0);
        await _save(queue);
        lastFailure = null;
      } catch (_) {
        // Never expose a native token, session header or payload in diagnostics.
        lastFailure =
            'Delivery deferred; check authentication, consent, connectivity and validation.';
        entry['attempts'] = (entry['attempts'] as int) + 1;
        final seconds = min(3600, 1 << min(entry['attempts'] as int, 12));
        entry['nextAt'] = _now().millisecondsSinceEpoch + seconds * 1000;
        if (_consent) await _save(queue);
        return;
      }
    }
  }

  static String minimizeReferrer(String raw) {
    final source =
        Uri.splitQueryString(raw.startsWith('?') ? raw.substring(1) : raw);
    return Uri(queryParameters: {
      for (final key in [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term'
      ])
        if (source[key]?.isNotEmpty == true)
          key: source[key]!.substring(0, min(200, source[key]!.length))
    }).query;
  }

  void close() => _http.close();
  static String _uuid() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
  }
}
