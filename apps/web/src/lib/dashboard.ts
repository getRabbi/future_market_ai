/**
 * Home dashboard and notification logic (D-048), kept pure so it can be tested without a
 * browser. Everything here is derived from persisted API records; nothing is estimated, and an
 * input that has not loaded yet yields `null` (the UI then shows a skeleton, never a premature
 * "nothing needs attention").
 */
import { readableText, statusLabel } from './format.js';
import type { Task } from './journey.js';

/* ------------------------------------------------------------------ */
/* Records (the API's persisted shapes, only the fields used here)     */
/* ------------------------------------------------------------------ */

export interface ActionLite {
  id: string;
  actionType: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt?: string;
  params?: Record<string, unknown>;
}

export interface InboxLite {
  approvals: { id: string; actionType: string; statusReason: string | null; createdAt: string; goalTitle: string }[];
  otherApprovals?: number;
  decisions: { id: string; objective: string; createdAt: string; goalTitle: string }[];
  drafts: { id: string; title: string; createdAt: string }[];
  postDrafts?: { id: string; caption: string; createdAt: string }[];
}

export interface IncidentLite {
  id: string;
  severity: string;
  title: string;
  description?: string;
  status: string;
  openedAt: string;
}

export interface AlertLite {
  id: string;
  kind: string;
  severity: string;
  message: string;
  createdAt: string;
}

export interface KillSwitchLite {
  id: string;
  scope: string;
  targetRef?: string | null;
  reason?: string | null;
  engaged: boolean;
}

export interface CycleNoteLite {
  taskId: string;
  kind: string;
  title: string;
  detail: string | null;
}

export interface GoalLite {
  id: string;
  title: string;
  status: string;
  statusReason: string | null;
  nextRunAt: string | null;
  kpi: { label: string; metricKey: string };
  memory: { lastMeasurement?: MeasurementLite | null; finalMeasurement?: MeasurementLite; lessons?: string[] };
  latestCycle?: { id: string; seq: number; status: string; summary: string | null; finishedAt: string | null; startedAt: string; unavailable?: CycleNoteLite[]; attention?: CycleNoteLite[] } | null;
}

export interface MeasurementLite {
  status: 'measured' | 'insufficient_data';
  progressPct: number | null;
  changeVsBaselinePct: number | null;
  forecast: { position: 'above' | 'within' | 'below' } | null;
  note: string;
  measuredAt: string;
}

export interface StoreWarningLite {
  code: string;
  title: string;
  detail: string;
  action: string;
  account: string;
}

export interface StoreAccountLite {
  id: string;
  displayName: string;
  status: string;
  health: string;
  consecutiveFailures: number;
  lastRun?: { status: string; error: { message?: string } | null } | null;
  warnings?: Omit<StoreWarningLite, 'account'>[];
}

export interface ConnectionLite {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  healthStatus?: string | null;
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const ACTION_NAMES: Record<string, string> = {
  'social.facebook.publish_post': 'Facebook post',
  'social.instagram.publish_media': 'Instagram post',
  'social.tiktok.publish_video': 'TikTok video',
  'social.linkedin.publish_post': 'LinkedIn post',
  'social.x.publish_post': 'X post',
  'social.youtube.upload_video': 'YouTube video',
  'social.facebook.reply_comment': 'Facebook comment reply',
  'ads.google.update_campaign_budget': 'Google Ads budget change',
  'ads.google.set_campaign_status': 'Google Ads campaign status change',
  'ads.meta.update_campaign_budget': 'Meta Ads budget change',
  'ads.meta.set_campaign_status': 'Meta Ads campaign status change',
  'email.send': 'Email send',
  'commerce.shopify.create_discount': 'Shopify discount',
  'store.app_store.update_localization': 'App Store listing update',
  'experiment.start': 'Experiment start',
  'data.export_customer_data': 'Customer data export',
  'sms.send': 'SMS send',
  'whatsapp.send': 'WhatsApp message',
  'creator.payout': 'Creator payout',
};

/** "social.facebook.publish_post" → "Facebook post". */
export function actionName(type: string): string {
  return ACTION_NAMES[type] ?? statusLabel(type.split('.').pop() ?? type);
}

const PUBLISHING = /^social\.[a-z]+\.(publish|upload)/;

/** What a VERIFIED action means in words. */
export function verifiedTitle(type: string): string {
  return PUBLISHING.test(type) ? `${actionName(type)} published and verified` : `${actionName(type)} verified`;
}

/** Action states as people read them. */
export function actionStateLabel(status: string): string {
  switch (status) {
    case 'APPROVAL_REQUIRED':
      return 'Needs your approval';
    case 'VERIFIED':
      return 'Verified';
    case 'EXECUTED_UNVERIFIED':
      return 'Done, verification pending';
    case 'ESCALATED':
      return 'Escalated to a person';
    case 'ROLLBACK_REQUIRED':
      return 'Needs a rollback decision';
    case 'FAILED':
      return 'Failed';
    case 'DENIED':
      return 'Denied by policy';
    case 'REJECTED':
      return 'Rejected';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return statusLabel(status);
  }
}

/* ------------------------------------------------------------------ */
/* At a glance                                                         */
/* ------------------------------------------------------------------ */

export interface Glance {
  active: number;
  paused: number;
  onTrack: number;
  attention: number;
  /** Active goals with no measured result yet (not a problem: data has not arrived). */
  notMeasured: number;
}

const measurementOf = (g: GoalLite) => g.memory.finalMeasurement ?? g.memory.lastMeasurement ?? null;

/** Needs attention: the latest cycle is blocked or failed (a forecast without data next to a verified result is not), or the result is below the no-action forecast range. */
export function goalNeedsAttention(g: GoalLite): boolean {
  const c = g.latestCycle;
  if (c && (c.status === 'blocked' || c.status === 'failed')) return true;
  const m = measurementOf(g);
  return m?.status === 'measured' && m.forecast?.position === 'below';
}

export function glance(goals: GoalLite[] | null): Glance | null {
  if (!goals) return null;
  const active = goals.filter((g) => g.status === 'active');
  const attention = active.filter(goalNeedsAttention);
  return {
    active: active.length,
    paused: goals.filter((g) => g.status === 'paused').length,
    onTrack: active.length - attention.length,
    attention: attention.length,
    notMeasured: active.filter((g) => measurementOf(g)?.status !== 'measured').length,
  };
}

/* ------------------------------------------------------------------ */
/* Next best action                                                    */
/* ------------------------------------------------------------------ */

export type ActionTone = 'critical' | 'action' | 'setup' | 'calm';

export interface NextAction {
  tone: ActionTone;
  title: string;
  text: string;
  primary: { label: string; href: string };
  secondary?: { label: string; href: string };
  /** One small fact under the text (e.g. what kind of action it is). */
  meta?: string;
}

export interface NextActionInput {
  stopped: string | null | undefined;
  killSwitches: KillSwitchLite[] | null;
  escalated: ActionLite[] | null;
  approvals: ActionLite[] | null;
  inbox: InboxLite | null;
  incidents: IncidentLite[] | null;
  goals: GoalLite[] | null;
  journeyNext: Task | null | undefined;
  journeyLoaded: boolean;
  userId: string;
  /** Titles of pages by slug, for the journey step button. */
  pageTitle: (slug: string) => string;
}

const byOldest = <T extends { createdAt: string }>(a: T, b: T) => Date.parse(a.createdAt) - Date.parse(b.createdAt);

/**
 * The single most important real thing to do now, or a calm state. Returns null while any input
 * the decision depends on is still loading (inputs that failed to load are passed as empty lists
 * by the caller only when the failure is a permission refusal).
 */
export function nextBestAction(i: NextActionInput): NextAction | null {
  if (i.killSwitches === null || i.escalated === null || i.approvals === null || i.incidents === null || i.goals === null || !i.journeyLoaded) return null;

  if (i.stopped) {
    return { tone: 'critical', title: 'The Autopilot is stopped', text: `${i.stopped}. Nothing runs on its own until the emergency stop is released.`, primary: { label: 'Review emergency stops', href: '/app/governance' }, secondary: { label: 'Open incidents', href: '/app/incidents' } };
  }
  const tenantStop = i.killSwitches.find((k) => k.engaged && k.scope === 'tenant');
  if (tenantStop) {
    return { tone: 'critical', title: 'Everything is stopped for this organization', text: `An emergency stop is engaged${tenantStop.reason ? `: ${tenantStop.reason}` : ''}. Release it once the cause is fixed.`, primary: { label: 'Review emergency stops', href: '/app/governance' } };
  }
  const escalated = [...i.escalated].sort(byOldest)[0];
  if (escalated) {
    return {
      tone: 'critical',
      title: `${actionName(escalated.actionType)}: ${actionStateLabel(escalated.status).toLowerCase()}`,
      text: escalated.statusReason ? readableText(escalated.statusReason, { userId: i.userId }) : 'This action could not finish on its own and needs a person to decide what happens next.',
      primary: { label: 'Review the action', href: `/app/approvals?id=${escalated.id}` },
      ...(i.escalated.length > 1 ? { secondary: { label: `See all ${i.escalated.length}`, href: '/app/approvals?tab=attention' } } : {}),
    };
  }
  const critical = i.incidents.filter((x) => x.status === 'open').sort((a, b) => sevRank(a.severity) - sevRank(b.severity))[0];
  if (critical && sevRank(critical.severity) <= 1) {
    return { tone: 'critical', title: `Open incident: ${critical.title}`, text: critical.description ? readableText(critical.description) : 'An incident is open. Investigate it and record the resolution.', primary: { label: 'Investigate', href: '/app/incidents' } };
  }
  const approvals = [...i.approvals].sort(byOldest);
  const first = approvals[0];
  if (first) {
    const fromInbox = i.inbox?.approvals.find((a) => a.id === first.id);
    const when = scheduledFor(first);
    return {
      tone: 'action',
      title: `Review ${articled(actionName(first.actionType))}`,
      text: [fromInbox ? `For the goal “${fromInbox.goalTitle}”.` : null, first.statusReason ? readableText(first.statusReason, { userId: i.userId }) : 'It waits for a person because your policy requires approval.', when ? `Scheduled for ${when}.` : null].filter(Boolean).join(' '),
      meta: 'Approval is bound to the exact action and needs a two-factor session.',
      primary: { label: approvals.length > 1 ? `Review & approve (${approvals.length})` : 'Review & approve', href: `/app/approvals?id=${first.id}` },
      secondary: { label: 'See all actions', href: '/app/approvals' },
    };
  }
  const inboxCount = i.inbox ? i.inbox.decisions.length + i.inbox.drafts.length + (i.inbox.postDrafts?.length ?? 0) : 0;
  if (inboxCount > 0 && i.inbox) {
    const d = i.inbox.decisions[0];
    return {
      tone: 'action',
      title: d ? 'Review a growth decision' : 'Review drafts that wait for you',
      text: d ? `For the goal “${d.goalTitle}”: ${readableText(d.objective)}` : `${inboxCount} draft${inboxCount === 1 ? '' : 's'} the Autopilot did not publish on its own.`,
      primary: { label: `Open the inbox (${inboxCount})`, href: '/app/approvals#inbox' },
    };
  }
  const blockedGoal = i.goals.find((g) => g.status === 'active' && (g.latestCycle?.status === 'blocked' || g.latestCycle?.status === 'failed'));
  if (blockedGoal) {
    const note = blockedGoal.latestCycle?.attention?.[0];
    return {
      tone: 'action',
      title: `Unblock “${blockedGoal.title}”`,
      text: note ? `${note.title}${note.detail ? `: ${readableText(note.detail, { userId: i.userId })}` : ''}` : blockedGoal.latestCycle?.summary ? readableText(blockedGoal.latestCycle.summary, { userId: i.userId }) : 'The latest cycle could not finish every step.',
      primary: { label: 'See what is blocked', href: `/app/goals?id=${blockedGoal.id}` },
      secondary: { label: 'Autopilot activity', href: '/app/autopilot' },
    };
  }
  const narrowStops = i.killSwitches.filter((k) => k.engaged && k.scope !== 'tenant');
  if (narrowStops.length) {
    const targets = [...new Set(narrowStops.map((k) => k.targetRef ?? statusLabel(k.scope).toLowerCase()))];
    return {
      tone: 'action',
      title: `Review ${narrowStops.length === 1 ? 'an engaged emergency stop' : `${narrowStops.length} engaged emergency stops`}`,
      text: `Stopped: ${targets.slice(0, 3).join(', ')}${targets.length > 3 ? ' and more' : ''}. Matching actions do not run until a stop is released; release the ones you no longer need.`,
      meta: 'Releasing needs a two-factor session.',
      primary: { label: 'Review emergency stops', href: '/app/governance' },
      secondary: { label: 'Incidents & Alerts', href: '/app/incidents' },
    };
  }
  if (i.journeyNext) {
    const t = i.journeyNext;
    return { tone: 'setup', title: t.title, text: t.why, meta: `How: ${t.how}`, primary: { label: `Go to ${i.pageTitle(t.section)}`, href: `/app/${t.section}` }, secondary: { label: 'View full journey', href: '/app/journey' } };
  }
  return {
    tone: 'calm',
    title: "You're on track",
    text: 'Nothing needs you right now. Approvals, blockers and incidents will show up here the moment they appear.',
    primary: { label: 'See performance', href: '/app/results' },
    secondary: { label: 'Content calendar', href: '/app/calendar' },
  };
}

function articled(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** A scheduled publish time from the action's parameters, in local time. */
export function scheduledFor(a: ActionLite): string | null {
  const v = a.params?.scheduledAt ?? a.params?.scheduled_at ?? a.params?.publishAt;
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function sevRank(s: string): number {
  const v = s.toLowerCase();
  if (v === 'sev1' || v === 'critical') return 0;
  if (v === 'sev2' || v === 'high') return 1;
  if (v === 'sev3' || v === 'medium' || v === 'warning' || v === 'warn') return 2;
  return 3;
}

/* ------------------------------------------------------------------ */
/* Blockers                                                            */
/* ------------------------------------------------------------------ */

export type BlockerLevel = 'critical' | 'action' | 'external' | 'optional' | 'info';

export const BLOCKER_LEVEL_LABEL: Record<BlockerLevel, string> = {
  critical: 'Critical problem',
  action: 'Action required',
  external: 'External setup needed',
  optional: 'Optional enhancement',
  info: 'Temporarily unavailable',
};

export interface Blocker {
  id: string;
  level: BlockerLevel;
  title: string;
  detail: string;
  /** What happens because of it, and what does not. */
  impact: string;
  remedy: { label: string; href: string };
}

export interface BlockerInput {
  killSwitches: KillSwitchLite[] | null;
  incidents: IncidentLite[] | null;
  goals: GoalLite[] | null;
  storeAccounts: StoreAccountLite[] | null;
  connections: ConnectionLite[] | null;
  policyConfigured: boolean | null;
  userId: string;
}

const NEED_REMEDY: Record<string, { label: string; href: string; level: BlockerLevel }> = {
  data: { label: 'Add or connect KPI data', href: '/app/apps', level: 'external' },
  connection: { label: 'Fix the connection', href: '/app/connections', level: 'action' },
  evidence: { label: 'Add evidence', href: '/app/evidence', level: 'action' },
  claims: { label: 'Approve claims', href: '/app/knowledge', level: 'action' },
  approval: { label: 'Review approvals', href: '/app/approvals', level: 'action' },
  configuration: { label: 'Check your rules', href: '/app/governance', level: 'action' },
  model: { label: 'Approve an AI model', href: '/app/governance', level: 'external' },
  budget: { label: 'Review the goal budget', href: '/app/goals', level: 'action' },
};

/**
 * Unresolved problems, most severe first. Optional provider limitations (e.g. the Play Developer
 * Reporting API) are optional enhancements, never critical; a forecast without data next to a
 * verified result is already excluded by the API's cycle view (`unavailable`).
 */
export function blockers(i: BlockerInput): Blocker[] | null {
  if (i.killSwitches === null || i.incidents === null || i.goals === null) return null;
  const out: Blocker[] = [];
  // One row per stopped target (several switches on the same target are one stop for the reader).
  const stops = new Map<string, KillSwitchLite[]>();
  for (const k of i.killSwitches.filter((x) => x.engaged)) stops.set(`${k.scope}:${k.targetRef ?? ''}`, [...(stops.get(`${k.scope}:${k.targetRef ?? ''}`) ?? []), k]);
  for (const [key, ks] of stops) {
    const k = ks[0]!;
    const tenant = k.scope === 'tenant';
    out.push({
      id: `kill-${key}`,
      level: tenant ? 'critical' : 'action',
      title: tenant ? 'Emergency stop: everything is paused' : `Emergency stop on ${k.targetRef ?? statusLabel(k.scope).toLowerCase()}${ks.length > 1 ? ` (${ks.length} switches)` : ''}`,
      detail: k.reason ? readableText(k.reason) : 'A kill switch is engaged.',
      impact: tenant ? 'Nothing in this organization runs until it is released.' : `Only actions of this ${statusLabel(k.scope).toLowerCase()} are stopped; release it once the cause is fixed or the stop is no longer needed.`,
      remedy: { label: 'Review emergency stops', href: '/app/governance' },
    });
  }
  for (const x of i.incidents.filter((y) => y.status === 'open')) {
    out.push({ id: `incident-${x.id}`, level: sevRank(x.severity) <= 1 ? 'critical' : 'action', title: x.title, detail: x.description ? readableText(x.description) : 'An incident is open.', impact: 'Investigate and record the resolution.', remedy: { label: 'Open incidents', href: '/app/incidents' } });
  }
  for (const g of i.goals.filter((y) => y.status === 'active')) {
    const c = g.latestCycle;
    if (!c || (c.status !== 'blocked' && c.status !== 'failed')) continue;
    const notes = c.attention?.length ? c.attention : [{ taskId: c.id, kind: 'cycle', title: `Cycle ${c.seq} ${c.status}`, detail: c.summary }];
    for (const n of notes.slice(0, 3)) {
      const need = guessNeed(n);
      const r = need ? NEED_REMEDY[need] : null;
      out.push({
        id: `goal-${g.id}-${n.taskId}`,
        level: c.status === 'failed' ? 'action' : (r?.level ?? 'action'),
        title: n.title,
        detail: `${g.title}${n.detail ? ` — ${readableText(n.detail, { userId: i.userId })}` : ''}`,
        impact: c.status === 'failed' ? 'This step failed in the latest Autopilot cycle.' : 'This step waits; the rest of the goal keeps running.',
        remedy: r ? { label: r.label, href: r.href } : { label: 'Open the goal', href: `/app/goals?id=${g.id}` },
      });
    }
  }
  for (const a of i.storeAccounts ?? []) {
    if (a.status === 'active' && (a.health === 'failing' || a.health === 'error' || (a.consecutiveFailures ?? 0) >= 3)) {
      out.push({
        id: `store-${a.id}`,
        level: 'external',
        title: `${a.displayName}: store reports are not importing`,
        detail: a.lastRun?.error?.message ? readableText(a.lastRun.error.message) : 'The last imports failed.',
        impact: 'Recent app days stay missing (never shown as zero) until imports succeed.',
        remedy: { label: 'Check the developer account', href: '/app/apps?tab=accounts' },
      });
    }
    for (const w of a.status === 'active' ? (a.warnings ?? []) : []) {
      out.push({
        id: `store-${a.id}-${w.code}`,
        level: 'optional',
        title: w.title.replace(/^Optional\s+/i, ''),
        detail: `${a.displayName}: ${readableText(w.detail)}`,
        impact: 'Optional: app names and crash/ANR rates are unavailable. Installs, acquisitions and other report metrics are not affected.',
        remedy: { label: 'How to enable it', href: '/app/apps?tab=accounts' },
      });
    }
  }
  for (const c of i.connections ?? []) {
    if (c.status === 'reauth_required' || c.status === 'failing' || c.healthStatus === 'failing' || c.healthStatus === 'unhealthy') {
      out.push({
        id: `conn-${c.id}`,
        level: 'action',
        title: `${c.displayName} needs attention`,
        detail: `The ${c.provider} connection is ${statusLabel(c.healthStatus ?? c.status).toLowerCase()}.`,
        impact: 'Queued actions for this account wait until it is healthy.',
        remedy: { label: 'Test the connection', href: '/app/connections' },
      });
    }
  }
  if (i.policyConfigured === false) {
    out.push({ id: 'policy', level: 'info', title: 'Autonomy policy not configured', detail: 'Every consequential action waits for a person until you set your rules.', impact: 'Nothing is blocked; actions simply need approval.', remedy: { label: 'Set your rules', href: '/app/governance' } });
  }
  const order: BlockerLevel[] = ['critical', 'action', 'external', 'optional', 'info'];
  return out.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
}

function guessNeed(n: CycleNoteLite): string | null {
  const t = `${n.kind} ${n.title} ${n.detail ?? ''}`.toLowerCase();
  if (/model/.test(t)) return 'model';
  if (n.kind === 'forecast' || n.kind === 'observe') return 'data';
  if (/approv/.test(t)) return 'approval';
  if (/connect|reauth|token/.test(t)) return 'connection';
  if (/claim/.test(t)) return 'claims';
  if (/evidence/.test(t)) return 'evidence';
  if (/budget/.test(t)) return 'budget';
  if (/data|kpi|download|install|forecast/.test(t)) return 'data';
  return null;
}

/* ------------------------------------------------------------------ */
/* Activity (audit log in plain language)                              */
/* ------------------------------------------------------------------ */

export interface AuditRow {
  seq: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  payload?: Record<string, unknown> | null;
}

export type ActivityKind = 'publish' | 'content' | 'store' | 'autopilot' | 'approval' | 'governance' | 'connection' | 'data' | 'team' | 'other';

export interface ActivityItem {
  key: string;
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string;
  actor: string;
  status: { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted' };
  href: string | null;
  /** The raw record, for the technical details disclosure. */
  record: AuditRow;
}

const NOISE = new Set(['autopilot.cycle.started', 'action.preflight.evaluated', 'action.request.proposed', 'social.posts.snapshot', 'analytics.series.points_invalidated', 'knowledge.entity.upserted', 'knowledge.relation.created', 'store.sync.requested', 'connector.connection.tested', 'store.account.tested']);

export function actorLabel(type: string, id: string, userId: string): string {
  if (type === 'user') return id === userId ? 'You' : 'A team member';
  if (type === 'agent') return 'An AI agent';
  if (/autopilot/.test(id)) return 'The Autopilot';
  if (/content-studio|studio/.test(id)) return 'The content studio';
  if (/worker|scheduler|system/.test(type) || /^system/.test(id)) return 'FUTUREGROW';
  return 'FUTUREGROW';
}

function subjectHref(type: string, id: string | null): string | null {
  if (!id) return null;
  switch (type) {
    case 'action':
      return `/app/approvals?id=${id}`;
    case 'goal':
    case 'growth_goal':
      return `/app/goals?id=${id}`;
    case 'social_post':
    case 'post':
      return '/app/calendar';
    case 'store_account':
    case 'store_app':
    case 'store_report_file':
      return '/app/apps';
    case 'connection':
      return '/app/connections';
    case 'claim':
    case 'brand_rule':
      return '/app/knowledge';
    case 'evidence':
    case 'evidence_source':
      return '/app/evidence';
    case 'kill_switch':
    case 'policy':
    case 'tenant_policy':
      return '/app/governance';
    case 'incident':
      return '/app/incidents';
    case 'brand':
      return '/app/channels';
    case 'studio_program':
    case 'content_plan_item':
      return '/app/content';
    default:
      return null;
  }
}

/** One audit record as a sentence, or null for internal steps that only matter in the audit trail. */
export function describeAudit(r: AuditRow, userId: string): ActivityItem | null {
  if (NOISE.has(r.action)) return null;
  const p = r.payload ?? {};
  const base = { key: `audit-${r.seq}`, at: r.occurred_at, actor: actorLabel(r.actor_type, r.actor_id, userId), href: subjectHref(r.subject_type, r.subject_id), record: r };
  const ok = { label: 'Completed', tone: 'ok' as const };
  if (r.action === 'action.request.transitioned') {
    const to = String(p.to ?? '');
    if (to === 'VERIFIED') return { ...base, kind: 'publish', title: 'Action verified', detail: 'An independent read-back confirmed the result.', status: { label: 'Verified', tone: 'ok' } };
    if (to === 'APPROVAL_REQUIRED') return { ...base, kind: 'approval', title: 'Action waits for approval', detail: p.reason ? readableText(String(p.reason), { userId }) : 'Your policy requires a person.', status: { label: 'Needs approval', tone: 'warn' } };
    if (['FAILED', 'ESCALATED', 'ROLLBACK_REQUIRED', 'DENIED'].includes(to)) return { ...base, kind: 'approval', title: `Action ${actionStateLabel(to).toLowerCase()}`, detail: p.reason ? readableText(String(p.reason), { userId }) : '', status: { label: actionStateLabel(to), tone: 'danger' } };
    return null;
  }
  if (r.action === 'action.approval.recorded') {
    const d = String(p.decision ?? 'recorded');
    return { ...base, kind: 'approval', title: d === 'rejected' ? 'Action rejected' : 'Action approved', detail: p.comment ? readableText(String(p.comment), { userId }) : '', status: { label: d === 'rejected' ? 'Rejected' : 'Approved', tone: d === 'rejected' ? 'danger' : 'ok' } };
  }
  if (r.action === 'action.verification.recorded') {
    const v = String(p.verdict ?? '');
    if (v && v !== 'verified' && v !== 'VERIFIED') return { ...base, kind: 'publish', title: 'Verification did not confirm the result', detail: readableText(String(p.notes ?? '')), status: { label: statusLabel(v), tone: 'danger' } };
    return null;
  }
  const [area, , verb] = r.action.split('.');
  const table: Record<string, [ActivityKind, string, string?]> = {
    'studio.post.drafted': ['content', 'Lesson draft prepared', 'Drafted'],
    'studio.post.superseded': ['content', 'Studio draft closed (superseded)', 'Closed'],
    'studio.post.expired': ['content', 'Studio draft closed (its day passed)', 'Closed'],
    'studio.post.failed': ['content', 'Studio draft could not be prepared', 'Failed'],
    'studio.program.saved': ['content', 'Content studio program saved'],
    'social.post.auto_submitted': ['publish', 'Post submitted for publishing', 'Submitted'],
    'social.post.resubmitted': ['publish', 'Post resubmitted for publishing', 'Submitted'],
    'social.post.drafted': ['content', 'Post draft created', 'Drafted'],
    'social.post.discarded': ['content', 'Post draft discarded', 'Discarded'],
    'store.report.revised': ['store', 'Store report revised', 'Imported'],
    'store.report.rejected': ['store', 'Store report file rejected', 'Rejected'],
    'store.sync.failed': ['store', 'Store report import failed', 'Failed'],
    'store.account.connected': ['store', 'Developer account connected'],
    'store.account.health_changed': ['store', 'Developer account health changed', 'Changed'],
    'app.coverage.reconciled': ['store', 'Store reports imported', 'Imported'],
    'store.app.confirmed': ['store', 'App confirmed'],
    'store.app.added': ['store', 'App added'],
    'autopilot.settings.changed': ['autopilot', 'Autopilot settings changed', 'Changed'],
    'autopilot.goal.created': ['autopilot', 'Growth goal created'],
    'autopilot.cycle.finished': ['autopilot', 'Autopilot cycle finished', 'Finished'],
    'governance.policy.updated': ['governance', 'Autonomy policy updated', 'Updated'],
    'governance.kill_switch.engaged': ['governance', 'Emergency stop engaged', 'Engaged'],
    'governance.kill_switch.released': ['governance', 'Emergency stop released', 'Released'],
    'governance.incident.resolved': ['governance', 'Incident resolved', 'Resolved'],
    'connector.connection.created': ['connection', 'Account connected'],
    'connector.connection.status_changed': ['connection', 'Connection status changed', 'Changed'],
    'connector.connection.credentials_rotated': ['connection', 'Connection credentials replaced', 'Updated'],
    'knowledge.claim.proposed': ['data', 'Claim proposed', 'Proposed'],
    'knowledge.claim.approved': ['data', 'Claim approved', 'Approved'],
    'evidence.source.registered': ['data', 'Evidence source registered'],
    'auth.password_changed': ['team', 'Password changed', 'Changed'],
    'brand.created': ['content', 'Brand created'],
  };
  const hit = table[r.action];
  if (hit) {
    const [kind, title, label] = hit;
    const bad = label === 'Failed' || label === 'Rejected';
    const detail = typeof p.reason === 'string' ? readableText(p.reason, { userId }) : typeof p.statusReason === 'string' ? readableText(p.statusReason, { userId }) : '';
    return { ...base, kind, title, detail, status: { label: label ?? 'Completed', tone: bad ? 'danger' : label === 'Closed' || label === 'Discarded' ? 'muted' : label === 'Submitted' || label === 'Drafted' || label === 'Proposed' || label === 'Finished' ? 'info' : 'ok' } };
  }
  // Anything else: the action name in words ("creator.contract.signed" → "Creator contract signed").
  const words = r.action.replace(/[._]/g, ' ').trim();
  return { ...base, kind: area === 'governance' ? 'governance' : area === 'autopilot' ? 'autopilot' : 'other', title: words.charAt(0).toUpperCase() + words.slice(1), detail: '', status: { ...ok, label: verb ? statusLabel(verb) : 'Recorded', tone: 'info' } };
}

/** Kinds worth a line on Home; background syncs and data upkeep stay in the Activity log. */
export const SIGNIFICANT_KINDS: ReadonlySet<ActivityKind> = new Set(['publish', 'content', 'store', 'autopilot', 'approval', 'governance', 'connection', 'team']);

export function activityFromAudit(rows: AuditRow[] | null, userId: string, limit = 50, kinds?: ReadonlySet<ActivityKind>): ActivityItem[] | null {
  if (!rows) return null;
  const out: ActivityItem[] = [];
  for (const r of rows) {
    const item = describeAudit(r, userId);
    if (item && (!kinds || kinds.has(item.kind))) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

export interface Notice {
  id: string;
  tone: 'danger' | 'warn' | 'info';
  title: string;
  detail: string;
  href: string;
  at: string;
}

export function notifications(i: { approvals: ActionLite[] | null; escalated: ActionLite[] | null; inbox: InboxLite | null; incidents: IncidentLite[] | null; alerts: AlertLite[] | null; userId: string }): Notice[] {
  const out: Notice[] = [];
  for (const a of i.escalated ?? []) out.push({ id: `esc-${a.id}`, tone: 'danger', title: `${actionName(a.actionType)}: ${actionStateLabel(a.status).toLowerCase()}`, detail: a.statusReason ? readableText(a.statusReason, { userId: i.userId }) : '', href: `/app/approvals?id=${a.id}`, at: a.updatedAt ?? a.createdAt });
  for (const x of (i.incidents ?? []).filter((y) => y.status === 'open')) out.push({ id: `inc-${x.id}`, tone: 'danger', title: `Incident: ${x.title}`, detail: statusLabel(x.severity), href: '/app/incidents', at: x.openedAt });
  for (const a of i.approvals ?? []) {
    const when = scheduledFor(a);
    out.push({ id: `appr-${a.id}`, tone: 'warn', title: `${actionName(a.actionType)} needs your approval`, detail: [when ? `Scheduled for ${when}` : null, a.statusReason ? readableText(a.statusReason, { userId: i.userId }) : null].filter(Boolean).join(' · '), href: `/app/approvals?id=${a.id}`, at: a.createdAt });
  }
  for (const d of i.inbox?.decisions ?? []) out.push({ id: `dec-${d.id}`, tone: 'warn', title: 'Growth decision to review', detail: `${d.goalTitle}: ${readableText(d.objective)}`, href: '/app/approvals#inbox', at: d.createdAt });
  for (const p of i.inbox?.postDrafts ?? []) out.push({ id: `draft-${p.id}`, tone: 'info', title: 'Post draft waiting', detail: p.caption.slice(0, 90), href: '/app/approvals#inbox', at: p.createdAt });
  for (const b of i.inbox?.drafts ?? []) out.push({ id: `brief-${b.id}`, tone: 'info', title: 'Creative brief to review', detail: b.title, href: '/app/creative', at: b.createdAt });
  for (const a of i.alerts ?? []) out.push({ id: `alert-${a.id}`, tone: sevRank(a.severity) <= 1 ? 'danger' : 'info', title: readableText(a.message).slice(0, 120), detail: statusLabel(a.kind), href: '/app/incidents', at: a.createdAt });
  const order = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone] || Date.parse(b.at) - Date.parse(a.at));
}
