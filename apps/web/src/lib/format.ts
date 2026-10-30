const OK = new Set(['VERIFIED', 'ROLLED_BACK', 'approved', 'active', 'admitted', 'completed', 'delivered', 'published_verified', 'live_verified', 'sent_verified', 'healthy', 'ok', 'confirmed', 'qualified', 'running', 'current', 'granted', 'ready', 'passed', 'Ready']);
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
  'proposed',
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
  'warn',
  'drafted',
  'sent_unverified',
  'conflict',
  'received',
  'Needs review',
  'Out of date',
  'Suggestion',
]);
const DANGER = new Set(['FAILED', 'DENIED', 'REJECTED', 'blocked', 'block', 'failed', 'rejected', 'bounced', 'complained', 'suppressed', 'invalid', 'discrepancy', 'failing', 'revoked', 'critical', 'sev1', 'sev2', 'rejected_missing_disclosure', 'blocked_dark_pattern', 'expired', 'Rejected', 'Expired', 'Must fix']);

export function tone(v: unknown): 'ok' | 'warn' | 'danger' | 'info' | 'muted' {
  const s = String(v);
  if (OK.has(s)) return 'ok';
  if (WARN.has(s)) return 'warn';
  if (DANGER.has(s)) return 'danger';
  if (s === 'true') return 'ok';
  if (s === 'false') return 'muted';
  return 'info';
}

const STATUS_KEYS = /^(status|state|verdict|healthStatus|replyStatus|severity|outcome|freshnessStatus|publishEligible|supported|readiness|regulated|approvedForProduction|engaged|legalHold)$/;

export function isStatusKey(k: string): boolean {
  return STATUS_KEYS.test(k);
}

/** A status code as words: APPROVAL_REQUIRED → "Approval required", true → "Yes". */
export function statusLabel(v: unknown): string {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  const s = String(v);
  if (!/^[A-Za-z0-9_]+$/.test(s)) return s;
  const words = s.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Column headings that read better than the generated ones. */
const LABELS: Record<string, string> = {
  createdAt: 'Created',
  updatedAt: 'Updated',
  receivedAt: 'Received',
  startedAt: 'Started',
  finishedAt: 'Finished',
  openedAt: 'Opened',
  resolvedAt: 'Resolved',
  engagedAt: 'Engaged',
  releasedAt: 'Released',
  activatedAt: 'Activated',
  lastSyncedAt: 'Last synced',
  lastMessageAt: 'Last message',
  lastHealthCheckAt: 'Last checked',
  scheduledAt: 'Scheduled for',
  fetchedAt: 'Fetched',
  detectedAt: 'Detected',
  observedAt: 'Observed',
  expiresAt: 'Expires',
  dueAt: 'Due',
  sentAt: 'Sent',
  eolAt: 'End of life',
  sunsetAt: 'Sunset',
  freshnessSlaHours: 'Stays accurate (hours)',
  evidenceFreshnessHours: 'Evidence max age (hours)',
  sourceType: 'Source type',
  sourceOwner: 'Owner',
  sourceUriOrObjectId: 'Where from',
  piiClassification: 'Personal data',
  licenseOrUsageRights: 'Usage rights',
  displayName: 'Name',
  externalAccountId: 'Account',
  healthStatus: 'Health',
  replyStatus: 'Reply',
  publishEligible: 'Can publish',
  approvedForProduction: 'Approved',
  trainingOnCustomerData: 'Trains on our data',
  inputUsdPerMtok: 'Input $ / M tokens',
  outputUsdPerMtok: 'Output $ / M tokens',
  dailyBudgetMicros: 'Daily budget',
  listPriceMicros: 'List price',
  minPriceMicros: 'Minimum price',
  authorizedMicros: 'Authorised',
  reportedMicros: 'Reported',
  deltaMicros: 'Difference',
  maxDiscountFraction: 'Max discount',
  discountFraction: 'Discount',
  productRef: 'Product',
  keyPrefix: 'Key starts with',
  allowedOrigins: 'Allowed websites',
  retainDays: 'Keep for (days)',
  dataClass: 'Data',
  legalHold: 'Legal hold',
  claimType: 'Type',
  isChild: 'Child',
  isInference: 'Inferred',
  pValue: 'p-value',
  page_url: 'Page',
  known_usd: 'Known cost (USD)',
  unpriced_rows: 'Unpriced rows',
  chunkCount: 'Passages',
  evidenceStrength: 'Evidence strength',
  expectedValue: 'Expected value',
  abstainReason: 'Abstained because',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  riskTier: 'Risk',
  targetRef: 'Target',
  engagedBy: 'Engaged by',
  requiredScopes: 'Required permissions',
  appReviewRequired: 'App review needed',
  termsCheckedAt: 'Terms checked',
  statusReason: 'Reason',
  triggerEvent: 'Starts when',
  assignedUserId: 'Assigned to',
  disclosureCopy: 'Disclosure',
  occurred_at: 'When',
  actor_type: 'Actor type',
  actor_id: 'Actor',
  subject_type: 'Subject',
  subject_id: 'Subject ID',
  seq: '#',
};

export function humanize(key: string): string {
  if (LABELS[key]) return LABELS[key]!;
  return key
    .replace(/Micros$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID.test(v);

export function formatValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' && ISO.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (isUuid(v)) return shortId(v);
  if (typeof v === 'number' && /micros$/i.test(key)) return (v / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'number' && /fraction$/i.test(key)) return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.every((x) => typeof x !== 'object') ? v.map((x) => (isUuid(x) ? shortId(x) : String(x))).join(', ') : `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== null && typeof x !== 'object');
    return entries.length ? entries.map(([k, x]) => `${humanize(k)}: ${String(x)}`).join(' · ') : '…';
  }
  return String(v);
}

export function shortId(id: unknown): string {
  return typeof id === 'string' && id.length > 12 ? `${id.slice(0, 8)}…` : String(id ?? '');
}

export function relativeTime(v: unknown, now = Date.now()): string {
  const t = new Date(String(v)).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  const abs = Math.abs(s);
  const [n, unit] = abs < 60 ? [abs, 'second'] : abs < 3600 ? [Math.round(abs / 60), 'minute'] : abs < 86_400 ? [Math.round(abs / 3600), 'hour'] : [Math.round(abs / 86_400), 'day'];
  const words = `${n} ${unit}${n === 1 ? '' : 's'}`;
  return s >= 0 ? `${words} ago` : `in ${words}`;
}
