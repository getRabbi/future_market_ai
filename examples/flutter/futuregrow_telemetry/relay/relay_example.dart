// Backend contract: authenticate/attest the session, check current consent, bind installId
// to the session, and enforce a rate limit BEFORE forwarding. Never log payloads or tokens.
import 'dart:convert';
import 'package:http/http.dart' as http;

class RelayAuthorization {
  const RelayAuthorization(
      {required this.appId,
      required this.platform,
      required this.installId,
      required this.analyticsConsent,
      this.userId});
  final String appId, platform, installId;
  final bool analyticsConsent;
  final String? userId;
}

Future<http.Response> relayToFutureGrow(
  String requestBody, {
  required Uri futureGrowBase,
  required String serverKey,
  required Future<RelayAuthorization?> Function() authorizeAndRateLimit,
  required Future<bool> Function(Map<String, dynamic>) verifyConversion,
  http.Client? client,
}) async {
  if (futureGrowBase.scheme != 'https' ||
      futureGrowBase.userInfo.isNotEmpty ||
      futureGrowBase.hasQuery ||
      futureGrowBase.hasFragment ||
      !serverKey.startsWith('fgk_sk_'))
    throw ArgumentError('Invalid server-side configuration');
  if (utf8.encode(requestBody).length > 20000)
    return http.Response('payload too large', 413);
  final auth = await authorizeAndRateLimit();
  if (auth == null) return http.Response('unauthorized or rate limited', 403);
  if (!auth.analyticsConsent)
    return http.Response('analytics consent denied', 403);
  Map<String, dynamic> body;
  try {
    body = Map<String, dynamic>.from(jsonDecode(requestBody) as Map);
  } catch (_) {
    return http.Response('invalid JSON object', 400);
  }
  final kind = body.remove('kind');
  final paths = {
    'install': '/ingest/v1/app-installs',
    'event': '/ingest/v1/app-events',
    'apple_attribution': '/ingest/v1/apple-ads-attribution'
  };
  if (!paths.containsKey(kind) ||
      body['appId'] != auth.appId ||
      body['installId'] != auth.installId ||
      (kind != 'apple_attribution' && body['platform'] != auth.platform) ||
      (kind == 'apple_attribution' && auth.platform != 'ios'))
    return http.Response('application or installation mismatch', 422);
  if (body['consent'] is! Map || (body['consent'] as Map)['analytics'] != true)
    return http.Response('analytics consent denied', 403);
  body.remove('userId');
  if (kind == 'install' && auth.userId != null) body['userId'] = auth.userId;
  if (body['event'] == 'conversion' &&
      !await verifyConversion(Map.unmodifiable(body)))
    return http.Response('unverified conversion', 422);
  final transport = client ?? http.Client();
  try {
    final request = http.Request('POST', futureGrowBase.resolve(paths[kind]!))
      ..followRedirects = false
      ..headers.addAll({
        'authorization': 'Bearer $serverKey',
        'content-type': 'application/json'
      })
      ..body = jsonEncode(body);
    final response =
        await transport.send(request).timeout(const Duration(seconds: 45));
    final result = await http.Response.fromStream(response)
        .timeout(const Duration(seconds: 10));
    if (result.statusCode >= 300 && result.statusCode < 400)
      return http.Response('upstream redirect refused', 502);
    return result;
  } catch (_) {
    return http.Response('telemetry upstream unavailable', 503);
  } finally {
    if (client == null) transport.close();
  }
}
