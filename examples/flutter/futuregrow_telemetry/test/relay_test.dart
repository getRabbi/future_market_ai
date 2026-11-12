import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';
import '../relay/relay_example.dart';

void main() {
  for (final appId in ['fixture.eps', 'fixture.ecoms']) {
    test(
        '$appId relay binds app/session, consent, identity and verified conversions',
        () async {
      final requests = <http.Request>[];
      final transport = MockClient((r) async {
        requests.add(r);
        return http.Response('{"recorded":true}', 202);
      });
      var consent = true;
      var conversionVerified = false;
      Future<http.Response> relay(Map<String, Object?> body) =>
          relayToFutureGrow(jsonEncode(body),
              futureGrowBase: Uri.parse('https://futuregrow.example'),
              serverKey: 'fgk_sk_server_only',
              authorizeAndRateLimit: () async => RelayAuthorization(
                  appId: appId,
                  platform: 'android',
                  installId: 'install-0001',
                  analyticsConsent: consent,
                  userId: 'verified-user'),
              verifyConversion: (_) async => conversionVerified,
              client: transport);
      final install = <String, Object?>{
        'kind': 'install',
        'appId': appId,
        'platform': 'android',
        'installId': 'install-0001',
        'userId': 'forged-user',
        'consent': {'analytics': true}
      };
      expect((await relay(install)).statusCode, 202);
      expect(requests.single.followRedirects, false);
      expect(requests.single.headers['authorization'],
          'Bearer fgk_sk_server_only');
      expect(jsonDecode(requests.single.body)['userId'], 'verified-user');
      expect(
          (await relay({...install, 'appId': 'another.app'})).statusCode, 422);
      expect((await relay({...install, 'kind': 'unknown'})).statusCode, 422);
      consent = false;
      expect((await relay(install)).statusCode, 403);
      consent = true;
      final conversion = {...install, 'kind': 'event', 'event': 'conversion'};
      expect((await relay(conversion)).statusCode, 422);
      conversionVerified = true;
      expect((await relay(conversion)).statusCode, 202);
      expect(jsonDecode(requests.last.body).containsKey('userId'), false);
    });
  }
}
