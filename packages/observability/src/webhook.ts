/**
 * Alert webhook payloads (no Node.js dependencies: also bundled into the Cloudflare uptime Worker).
 * Slack and Discord incoming-webhook URLs get their native shape; any other https endpoint gets
 * the structured JSON object.
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface OpsAlert {
  severity: AlertSeverity;
  title: string;
  text: string;
  /** Which part of FUTUREGROW raised it (api, worker, uptime-monitor, ...). */
  source: string;
  /** Deployment label, e.g. production futuregrow.scalemyprints.com. */
  environment: string;
  dedupKey: string;
  /** recovery = a previously reported problem cleared. */
  status?: 'problem' | 'recovery';
  fields?: Record<string, string | number | boolean | null>;
  occurredAt?: string;
}

export type WebhookFormat = 'slack' | 'discord' | 'json';

export function webhookFormat(url: string): WebhookFormat {
  const u = new URL(url);
  if (u.hostname === 'hooks.slack.com') return 'slack';
  if ((u.hostname === 'discord.com' || u.hostname === 'discordapp.com') && u.pathname.startsWith('/api/webhooks/')) return 'discord';
  return 'json';
}

const ICON: Record<AlertSeverity, string> = { critical: '🔴', warning: '🟠', info: '🔵' };
const MAX_TEXT = 1800;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function renderAlertText(a: OpsAlert): string {
  const head = a.status === 'recovery' ? `✅ RESOLVED: ${a.title}` : `${ICON[a.severity]} ${a.severity.toUpperCase()}: ${a.title}`;
  const fields = Object.entries(a.fields ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `• ${k}: ${String(v)}`);
  return clip([head, a.text, ...fields, `${a.source} · ${a.environment}`].filter(Boolean).join('\n'), MAX_TEXT);
}

export function webhookPayload(format: WebhookFormat, a: OpsAlert): Record<string, unknown> {
  const text = renderAlertText(a);
  if (format === 'slack') return { text };
  // Discord: no @everyone / role pings from alert content.
  if (format === 'discord') return { content: text, allowed_mentions: { parse: [] } };
  return { ...a, text: clip(a.text, MAX_TEXT), occurredAt: a.occurredAt ?? new Date().toISOString(), rendered: text };
}

/** Webhook destinations must be https (they carry operational details). */
export function assertWebhookUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('ALERT_WEBHOOK_URL is not a valid URL');
  }
  if (u.protocol !== 'https:') throw new Error('ALERT_WEBHOOK_URL must use https');
}
