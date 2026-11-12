import 'dart:async';
import 'dart:convert';
import 'package:futuregrow_telemetry/futuregrow_telemetry.dart';
import 'package:futuregrow_telemetry/app_integrations.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';

class MemoryStore implements TelemetryStore {
  final values = <String, String>{};
  @override
  Future<String?> read(String key) async => values[key];
  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }
}

void main() {
  for (final target in ['EPS TOPIK Bangla', 'Ecoms BD']) {
    group(target, () {
      late MemoryStore store;
      late DateTime now;
      late List<Map<String, dynamic>> received;
      late bool offline;
      late FutureGrowTelemetry client;
      FutureGrowTelemetry make() => FutureGrowTelemetry(
            relayUrl: Uri.parse('https://backend.example/telemetry'),
            appId:
                target == 'EPS TOPIK Bangla' ? 'fixture.eps' : 'fixture.ecoms',
            platform: 'android',
            appVersion: '1.0.0+1',
            store: store,
            relayHeaders: () async =>
                {'authorization': 'Bearer application-session'},
            clock: () => now,
            readInstallReferrer: () async =>
                'utm_campaign=real-tag&utm_content=post-1&gclid=drop-this',
            client: MockClient((request) async {
              expect(request.headers['authorization'],
                  'Bearer application-session');
              expect(request.followRedirects, false);
              received.add(jsonDecode(request.body) as Map<String, dynamic>);
              return http.Response(
                  offline ? '{}' : '{"recorded":true}', offline ? 503 : 202);
            }),
          );
      setUp(() {
        store = MemoryStore();
        now = DateTime.utc(2026, 11, 9);
        received = [];
        offline = false;
        client = make();
      });
      test('sends nothing without consent; serializes concurrent once events',
          () async {
        await client.recordEvent('first_open');
        expect(received, isEmpty);
        await client.setAnalyticsConsent(true);
        await Future.wait([
          client.recordInstall(),
          client.recordEvent('first_open'),
          client.recordEvent('first_open'),
          client.recordEvent('activation')
        ]);
        expect(received.map((r) => r['kind']), ['install', 'event', 'event']);
        expect(received.where((r) => r['event'] == 'first_open').length, 1);
        expect(received.first['installReferrer'],
            contains('utm_campaign=real-tag'));
        expect(received.first['installReferrer'], isNot(contains('gclid')));
        expect(received.map((r) => r['installId']).toSet().length, 1);
      });
      test('persists exact event ID/time across failures and process restart',
          () async {
        await client.setAnalyticsConsent(true);
        await client.recordInstall();
        offline = true;
        await client.recordEvent('first_open');
        final original = Map<String, dynamic>.from(received.last);
        now = now.add(const Duration(hours: 1));
        offline = false;
        client = make();
        await client.setAnalyticsConsent(true);
        await client.recordEvent('first_open');
        expect(received.last, original);
        expect(client.lastFailure, isNull);
      });
      test('rejects conversion names outside the backend schema', () async {
        await client.setAnalyticsConsent(true);
        await expectLater(
          client.recordEvent('conversion',
              occurrenceId: 'order-00000001',
              conversionName: List.filled(41, 'a').join()),
          throwsArgumentError,
        );
        expect(received, isEmpty);
      });
      test(
          'purges pending data on withdrawal and never sends it on later grant',
          () async {
        await client.setAnalyticsConsent(true);
        offline = true;
        await client.recordEvent('session');
        final sent = received.length;
        await client.setAnalyticsConsent(false);
        offline = false;
        now = now.add(const Duration(hours: 1));
        await client.flush();
        expect(received.length, sent);
        await client.setAnalyticsConsent(true);
        await client.flush();
        expect(received.length, sent);
        expect(store.values.values.where((v) => v == '[]'), isNotEmpty);
      });
      test(
          'integration hooks use stable conversion identity and once activation',
          () async {
        await client.setAnalyticsConsent(true);
        if (target == 'EPS TOPIK Bangla') {
          final app = EpsTopikTelemetry(client);
          await app.foreground();
          await app.lessonCompleted();
          await app.lessonCompleted();
          await app.subscriptionConfirmed('transaction-0001', 2000000, 'BDT');
          await app.subscriptionConfirmed('transaction-0001', 2000000, 'BDT');
        } else {
          final app = EcomsBdTelemetry(client);
          await app.foreground();
          await app.cartCreated();
          await app.cartCreated();
          await app.orderPaid('order-00000001', 2000000, 'BDT');
          await app.orderPaid('order-00000001', 2000000, 'BDT');
        }
        expect(received.where((r) => r['event'] == 'activation').length, 1);
        expect(received.where((r) => r['event'] == 'conversion').length, 1);
        expect(received.last['conversion']['valueMicros'], 2000000);
      });
    });
  }
  test('withdrawal while native referrer awaits prevents sending', () async {
    final deferred = Completer<String?>();
    final calls = <http.Request>[];
    final client = FutureGrowTelemetry(
        relayUrl: Uri.parse('https://backend.example/telemetry'),
        appId: 'fixture.eps',
        platform: 'android',
        appVersion: '1',
        store: MemoryStore(),
        relayHeaders: () async => {},
        readInstallReferrer: () => deferred.future,
        client: MockClient((r) async {
          calls.add(r);
          return http.Response('{}', 202);
        }));
    await client.setAnalyticsConsent(true);
    final install = client.recordInstall();
    await Future<void>.delayed(Duration.zero);
    final revoke = client.setAnalyticsConsent(false);
    final regrant = client.setAnalyticsConsent(true);
    deferred.complete('utm_campaign=x');
    await install;
    await revoke;
    await regrant;
    await client.flush();
    expect(calls, isEmpty);
  });
  test('iOS attribution tokens are fetched at send time and never persisted',
      () async {
    final store = MemoryStore();
    final calls = <Map<String, dynamic>>[];
    final client = FutureGrowTelemetry(
        relayUrl: Uri.parse('https://backend.example/telemetry'),
        appId: 'fixture.ios',
        platform: 'ios',
        appVersion: '1',
        store: store,
        relayHeaders: () async => {},
        readAppleAttributionToken: () async => 'sensitive-native-token',
        client: MockClient((r) async {
          calls.add(jsonDecode(r.body));
          return http.Response('{}', 202);
        }));
    await client.setAnalyticsConsent(true);
    await client.recordAppleAttribution();
    expect(calls.last['token'], 'sensitive-native-token');
    expect(jsonEncode(store.values), isNot(contains('sensitive-native-token')));
  });
}
