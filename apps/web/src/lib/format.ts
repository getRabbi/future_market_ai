const OK = new Set(['VERIFIED', 'ROLLED_BACK', 'approved', 'active', 'admitted', 'completed', 'delivered', 'published_verified', 'live_verified', 'sent_verified', 'healthy', 'ok', 'confirmed', 'qualified', 'running', 'current', 'granted']);
const WARN = new Set([
  'APPROVAL_REQUIRED',
  'PROPOSED',
  'EVIDENCE_READY',
  'POLICY_CHECKED',
  'EXECUTED_UNVERIFIED',
  'ESCALATED',
  'ROLLBACK_REQUIRED',
  'quarantined',
  'pending_review',
  'draft',
  'queued',
  'submitted',
  'scheduled',
  'handoff',
  'degraded',
  'reauth_required',
  'insufficient_data',
  'paused',
  'stale',
  'open',
  'warning',
  'drafted',
  'sent_unverified',
]);
const DANGER = new Set(['FAILED', 'DENIED', 'REJECTED', 'blocked', 'failed', 'rejected', 'bounced', 'complained', 'suppressed', 'invalid', 'discrepancy', 'failing', 'revoked', 'critical', 'sev1', 'sev2', 'rejected_missing_disclosure', 'blocked_dark_pattern', 'expired']);

export function tone(v: unknown): 'ok' | 'warn' | 'danger' | 'info' | 'muted' {
  const s = String(v);
  if (OK.has(s)) return 'ok';
  if (WARN.has(s)) return 'warn';
  if (DANGER.has(s)) return 'danger';
  if (s === 'true') return 'ok';
  if (s === 'false') return 'muted';
  return 'info';
}

const STATUS_KEYS = /^(status|state|verdict|healthStatus|replyStatus|severity|outcome|freshnessStatus|publishEligible|supported)$/;

export function isStatusKey(k: string): boolean {
  return STATUS_KEYS.test(k);
}

export function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' && ISO.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
  }
  if (typeof v === 'number' && /micros$/i.test(key)) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} items`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function shortId(id: unknown): string {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : String(id ?? '');
}
