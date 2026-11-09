// Minimal relay for YOUR backend (shelf-style handler). It receives the app's telemetry, removes the
// client-only `kind` field, adds the FUTUREGROW server key and forwards. Keep the key in your
// server's secret store; never ship it in the app.

import 'dart:convert';

import 'package:http/http.dart' as http;

Future<int> relayToFutureGrow(String requestBody, {required Uri futureGrowBase, required String serverKey}) async {
  final body = jsonDecode(requestBody) as Map<String, dynamic>;
  final kind = body.remove('kind');
  final path = kind == 'install' ? '/ingest/v1/app-installs' : '/ingest/v1/app-events';
  final r = await http.post(
    futureGrowBase.resolve(path),
    headers: {'authorization': 'Bearer $serverKey', 'content-type': 'application/json'},
    body: jsonEncode(body),
  );
  return r.statusCode;
}
