import 'futuregrow_telemetry.dart';

/// Wire once to foreground lifecycle after loading the current consent choice.
class AppTelemetryLifecycle {
  AppTelemetryLifecycle(this.client);
  final FutureGrowTelemetry client;
  Future<void> foreground() async {
    await client.recordInstall();
    await client.recordEvent('first_open');
    await client.recordEvent('session');
    await client.flush();
  }
}

/// Proposed EPS activation definition: first completed lesson. Confirm with the product owner.
class EpsTopikTelemetry extends AppTelemetryLifecycle {
  EpsTopikTelemetry(super.client);
  Future<void> lessonCompleted() => client.recordEvent('activation');
  Future<void> subscriptionConfirmed(
          String transactionId, int amountMicros, String currency) =>
      client.recordEvent('conversion',
          occurrenceId: transactionId,
          conversionName: 'subscription_started',
          valueMicros: amountMicros,
          currency: currency);
}

/// Proposed Ecoms activation definition: first cart creation. Confirm with the product owner.
class EcomsBdTelemetry extends AppTelemetryLifecycle {
  EcomsBdTelemetry(super.client);
  Future<void> cartCreated() => client.recordEvent('activation');
  Future<void> orderPaid(String orderId, int amountMicros, String currency) =>
      client.recordEvent('conversion',
          occurrenceId: orderId,
          conversionName: 'purchase',
          valueMicros: amountMicros,
          currency: currency);
}
