import type { ResolvedEmail } from '@futuregrow/connectors';
import { customerEvents, customerProfiles, type DbOrTx, executions, journeyEnrollments, journeys, messages, messageTemplates, type Tx, withSystem, withTenant } from '@futuregrow/db';
import { conflict, hmacSha256Hex, invalid, notFound, safeEqual, sha256Hex } from '@futuregrow/observability';
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { addSuppression, recordConsent } from '../m02-customers/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { assign as assignVariant } from '../m10-experiments/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { type ActionRow, registerHooks, registerResolver } from '../m23-execution/registry.js';
import { getTenantSettingsRow, senderIdentityComplete } from '../m24-governance/index.js';
import { registerWebhookHandler } from '../webhooks.js';

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/** Personalisation variables. Anything else in {{ }} is rejected; values are HTML-escaped. */
export const TEMPLATE_VARS = ['first_name', 'display_name', 'company_name'] as const;
const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

export const TemplateInputSchema = z.object({
  name: z.string().min(2).max(200),
  category: z.enum(['transactional', 'commercial']),
  subject: z.string().min(1).max(200),
  bodyText: z.string().min(1).max(50_000),
  bodyHtml: z.string().max(200_000).nullable().default(null),
  claimIds: z.array(z.string().uuid()).default([]),
});

export function templateProblems(t: { subject: string; bodyText: string; bodyHtml: string | null }): string[] {
  const out: string[] = [];
  for (const part of [t.subject, t.bodyText, t.bodyHtml ?? '']) {
    for (const m of part.matchAll(VAR_RE)) if (!(TEMPLATE_VARS as readonly string[]).includes(m[1]!)) out.push(`unknown variable {{${m[1]}}}`);
  }
  if (t.bodyHtml) {
    if (/<script\b/i.test(t.bodyHtml)) out.push('HTML body contains <script>');
    if (/\son[a-z]+\s*=/i.test(t.bodyHtml)) out.push('HTML body contains inline event handlers');
    if (/javascript:/i.test(t.bodyHtml)) out.push('HTML body contains javascript: URLs');
    if (/<form\b/i.test(t.bodyHtml)) out.push('HTML body contains a form');
  }
  if (/^\s*(re|fwd?):/i.test(t.subject)) out.push('subject implies a prior conversation (deceptive under CAN-SPAM)');
  return [...new Set(out)];
}

export async function createTemplate(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'authoring message templates');
  const input = TemplateInputSchema.parse(raw);
  const problems = templateProblems(input);
  if (problems.length) throw invalid(`template rejected: ${problems.join('; ')}`);
  const lint = await lintCopy(tx, `${input.subject}\n${input.bodyText}`, { claimIds: input.claimIds, channel: 'email', now: deps.clock.now() });
  const [last] = await tx.select({ v: messageTemplates.version }).from(messageTemplates).where(eq(messageTemplates.name, input.name)).orderBy(desc(messageTemplates.version)).limit(1);
  const [row] = await tx
    .insert(messageTemplates)
    .values({ tenantId, channel: 'email', ...input, lint: lint as unknown as Record<string, unknown>, version: (last?.v ?? 0) + 1, createdBy: actorRef(actor) })
    .returning();
  await audit(tx, tenantId, actor, 'lifecycle.template.created', { type: 'message_template', id: row!.id }, { name: input.name, version: row!.version, lintPassed: lint.passed });
  return row!;
}

export async function approveTemplate(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'approver', 'legal_approver'], 'approving message templates');
  const [t] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for('update');
  if (!t) throw notFound('template');
  if (t.status !== 'draft') throw invalid(`template is ${t.status}`);
  if (t.createdBy === actorRef(actor)) throw invalid('the author cannot approve their own template');
  // Re-lint at approval: claims may have expired since drafting.
  const lint = await lintCopy(tx, `${t.subject}\n${t.bodyText}`, { claimIds: t.claimIds, channel: 'email', now: deps.clock.now() });
  if (!lint.passed)
    throw invalid(
      `template fails lint: ${lint.violations
        .filter((v) => v.severity === 'block')
        .map((v) => v.code)
        .join(', ')}`,
    );
  await tx
    .update(messageTemplates)
    .set({ status: 'archived' })
    .where(and(eq(messageTemplates.name, t.name), eq(messageTemplates.status, 'approved')));
  const [row] = await tx
    .update(messageTemplates)
    .set({ status: 'approved', approvedBy: actorRef(actor), lint: lint as unknown as Record<string, unknown> })
    .where(eq(messageTemplates.id, id))
    .returning();
  await audit(tx, tenantId, actor, 'lifecycle.template.approved', { type: 'message_template', id }, { name: t.name, version: t.version });
  return row!;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function renderTemplate(src: string, vars: Record<string, string>, html: boolean): string {
  return src.replace(VAR_RE, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`unknown template variable ${name}`);
    return html ? esc(vars[name]!) : vars[name]!;
  });
}

export interface Sender {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  postalAddress: string;
}

/** Render subject/body with the CAN-SPAM footer: identity + postal address, and unsubscribe for commercial mail. */
export function renderEmail(t: { subject: string; bodyText: string; bodyHtml: string | null; category: string }, profile: { displayName: string | null }, sender: Sender, unsubscribeUrl: string | null) {
  const display = profile.displayName?.trim() || 'there';
  const vars = { display_name: display, first_name: display.split(/\s+/)[0]!, company_name: sender.fromName };
  const commercial = t.category === 'commercial';
  if (commercial && !unsubscribeUrl) throw new Error('commercial email requires an unsubscribe URL');
  const footerText = [`—`, `${sender.fromName}, ${sender.postalAddress}`, ...(commercial ? [`You receive marketing email from ${sender.fromName}. Unsubscribe: ${unsubscribeUrl}`] : [])].join('\n');
  const footerHtml = `<hr><p style="font-size:12px;color:#555">${esc(sender.fromName)}, ${esc(sender.postalAddress)}${commercial ? `<br>You receive marketing email from ${esc(sender.fromName)}. <a href="${esc(unsubscribeUrl!)}">Unsubscribe</a>` : ''}</p>`;
  const text = `${renderTemplate(t.bodyText, vars, false)}\n\n${footerText}`;
  const html = t.bodyHtml ? `${renderTemplate(t.bodyHtml, vars, true)}${footerHtml}` : null;
  return { subject: renderTemplate(t.subject, vars, false), text, html };
}

/* ------------------------------------------------------------------ */
/* Unsubscribe tokens (RFC 8058 one-click)                             */
/* ------------------------------------------------------------------ */

export function unsubscribeToken(pepper: string, tenantId: string, messageId: string): string {
  return `${tenantId}.${messageId}.${hmacSha256Hex(pepper, `unsub|${tenantId}|${messageId}`).slice(0, 40)}`;
}

export function parseUnsubscribeToken(pepper: string, token: string): { tenantId: string; messageId: string } | null {
  const m = token.match(/^([A-Za-z0-9_-]{1,64})\.([0-9a-f-]{36})\.([0-9a-f]{40})$/);
  if (!m) return null;
  const expected = hmacSha256Hex(pepper, `unsub|${m[1]}|${m[2]}`).slice(0, 40);
  return safeEqual(expected, m[3]!) ? { tenantId: m[1]!, messageId: m[2]! } : null;
}

/** Idempotent: suppress commercial email for the address and withdraw marketing consent. */
export async function processUnsubscribe(deps: CoreDeps, token: string): Promise<{ ok: boolean }> {
  const parsed = parseUnsubscribeToken(deps.config.identifierPepper, token);
  if (!parsed) return { ok: false };
  const actor = systemActor('unsubscribe');
  return withTenant(deps.db, { tenantId: parsed.tenantId, actor: actorRef(actor) }, async (tx) => {
    const [m] = await tx.select().from(messages).where(eq(messages.id, parsed.messageId));
    if (!m || !m.unsubscribeTokenHash || !safeEqual(m.unsubscribeTokenHash, sha256Hex(token))) return { ok: false };
    const [p] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, m.profileId));
    if (p?.email) await addSuppression(tx, deps, parsed.tenantId, actor, { channel: 'email', identifier: { kind: 'email', value: p.email }, reason: 'unsubscribe', source: `unsubscribe:${m.id}` });
    if (p && !p.deletedAt) {
      await recordConsent(tx, parsed.tenantId, actor, { profileId: p.id, purpose: 'marketing_email', status: 'withdrawn', lawfulBasis: 'consent', source: `unsubscribe_link:${m.id}`, capturedAt: new Date().toISOString() });
    }
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* Messages and the email.send boundary                                */
/* ------------------------------------------------------------------ */

/** Deterministic UUID (v4 layout) so retried journey steps reuse the same message row. */
export function stableUuid(seed: string): string {
  const h = sha256Hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const DENIED_STATES = new Set(['DENIED', 'REJECTED']);

/**
 * Queue one message and submit it to M23. Consent, suppression, frequency caps, quiet hours,
 * sender identity and jurisdiction are all evaluated by policy at proposal AND again at preflight,
 * immediately before the provider call.
 */
async function submitMessage(deps: CoreDeps, tenantId: string, proposer: Actor, args: { messageId: string; profileId: string; templateId: string; journeyId?: string | null; enrollmentId?: string | null; evidenceIds: string[]; connectionId: string }) {
  const prep = await withTenant(deps.db, { tenantId, actor: actorRef(proposer) }, async (tx) => {
    const [t] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, args.templateId));
    if (!t || t.status !== 'approved') throw invalid('template is not approved');
    const [p] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, args.profileId));
    if (!p) throw notFound('profile');
    const inserted = await tx
      .insert(messages)
      .values({ id: args.messageId, tenantId, profileId: p.id, channel: 'email', templateId: t.id, journeyId: args.journeyId ?? null, enrollmentId: args.enrollmentId ?? null, category: t.category })
      .onConflictDoNothing()
      .returning();
    if (inserted.length) await record(tx, tenantId, proposer, 'lifecycle.message.queued', { type: 'message', id: args.messageId }, { templateId: t.id, category: t.category, journeyId: args.journeyId ?? null });
    const [m] = await tx.select().from(messages).where(eq(messages.id, args.messageId));
    return { t, p, m: m! };
  });
  if (prep.m.actionId) return { messageId: prep.m.id, actionId: prep.m.actionId, status: prep.m.status };
  const view = await proposeAction(deps, tenantId, proposer, {
    actionType: 'email.send',
    connectionId: args.connectionId,
    target: { messageId: args.messageId },
    params: { messageId: args.messageId, profileId: prep.p.id, templateId: prep.t.id, category: prep.t.category, subject: prep.t.subject, claimIds: prep.t.claimIds },
    risk: { audienceSize: 1, geographies: prep.p.country ? [prep.p.country] : [] },
    evidenceIds: args.evidenceIds,
    idempotencyKey: `email:${args.messageId}`,
  });
  const denied = DENIED_STATES.has(view.status);
  const suppressed = denied && /RECIPIENT_SUPPRESSED|NO_MARKETING_CONSENT/.test(view.statusReason ?? '');
  await withTenant(deps.db, { tenantId, actor: actorRef(proposer) }, (tx) =>
    tx
      .update(messages)
      .set({ actionId: view.id, status: denied ? (suppressed ? 'suppressed' : 'blocked') : 'submitted', statusReason: denied ? view.statusReason : null })
      .where(eq(messages.id, args.messageId)),
  );
  return { messageId: args.messageId, actionId: view.id, status: view.status };
}

/** A human sends one approved template to one profile (still policy-gated). */
export async function sendOneOff(deps: CoreDeps, tenantId: string, actor: Actor, input: { profileId: string; templateId: string; connectionId: string; evidenceIds?: string[] }) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'sending messages');
  const messageId = stableUuid(`oneoff:${tenantId}:${input.profileId}:${input.templateId}:${deps.clock.now().toISOString().slice(0, 13)}`);
  return submitMessage(deps, tenantId, actor, { messageId, profileId: input.profileId, templateId: input.templateId, evidenceIds: input.evidenceIds ?? [], connectionId: input.connectionId });
}

/** Execution-boundary resolver: renders the exact email. Deterministic (also used during verification). */
registerResolver('email.send', async (deps: CoreDeps, tx: Tx, action: ActionRow): Promise<Record<string, unknown>> => {
  const p = action.params as { messageId: string; profileId: string; templateId: string; category: string; subject: string };
  const [m] = await tx.select().from(messages).where(eq(messages.id, p.messageId));
  if (!m) throw new Error('message row missing');
  const [t] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, p.templateId));
  if (!t) throw new Error('template missing');
  if (t.subject !== p.subject || t.category !== p.category) throw new Error('template changed after the action was proposed');
  const [profile] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, p.profileId));
  if (!profile?.email || profile.deletedAt) throw new Error('recipient has no deliverable address');
  const settings = await getTenantSettingsRow(tx, action.tenantId);
  if (!senderIdentityComplete(settings?.senderIdentity)) throw new Error('sender identity incomplete (CAN-SPAM)');
  const sender = settings!.senderIdentity as unknown as Sender;
  let unsubscribeUrl: string | null = null;
  if (t.category === 'commercial') {
    const token = unsubscribeToken(deps.config.identifierPepper, action.tenantId, m.id);
    unsubscribeUrl = `${deps.config.apiBaseUrl.replace(/\/$/, '')}/u/${token}`;
    const hash = sha256Hex(token);
    if (m.unsubscribeTokenHash !== hash) await tx.update(messages).set({ unsubscribeTokenHash: hash }).where(eq(messages.id, m.id));
  }
  const r = renderEmail(t, profile, sender, unsubscribeUrl);
  const resolved: ResolvedEmail = {
    from: `${sender.fromName.replace(/["<>]/g, '')} <${sender.fromEmail}>`,
    to: profile.email,
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    subject: r.subject,
    html: r.html,
    text: r.text,
    unsubscribeUrl,
    messageId: m.id,
  };
  return resolved as unknown as Record<string, unknown>;
});

const STATUS_RANK: Record<string, number> = { queued: 0, submitted: 1, sent_unverified: 2, delivered: 3, failed: 4, bounced: 4, complained: 5, blocked: 6, suppressed: 6 };

async function setMessageStatus(tx: Tx, tenantId: string, messageId: string, status: string, extra: Partial<typeof messages.$inferInsert> = {}, reason?: string) {
  const [m] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('update');
  if (!m) return false;
  if ((STATUS_RANK[status] ?? 0) <= (STATUS_RANK[m.status] ?? 0) && status !== m.status) return false;
  if (status === m.status && Object.keys(extra).length === 0) return false;
  await tx
    .update(messages)
    .set({ status, lastEventAt: new Date(), ...(reason ? { statusReason: reason.slice(0, 1000) } : {}), ...extra })
    .where(eq(messages.id, messageId));
  if (status !== m.status) await record(tx, tenantId, systemActor('lifecycle'), 'lifecycle.message.status_changed', { type: 'message', id: messageId }, { from: m.status, to: status });
  return true;
}

registerHooks('email.send', {
  async onVerified(tx, action, receipt) {
    const id = (action.params as { messageId: string }).messageId;
    await setMessageStatus(tx, action.tenantId, id, 'delivered', { providerMessageId: receipt.providerObjectId, sentAt: new Date(receipt.observedAt) });
  },
  async onTerminalFailure(tx, action, status, reason, proof) {
    const id = (action.params as { messageId: string }).messageId;
    const ev = (proof?.observed as { lastEvent?: string } | null)?.lastEvent;
    const to = ev === 'bounced' ? 'bounced' : ev === 'complained' ? 'complained' : DENIED_STATES.has(status) ? (/RECIPIENT_SUPPRESSED|NO_MARKETING_CONSENT/.test(reason) ? 'suppressed' : 'blocked') : 'failed';
    await setMessageStatus(tx, action.tenantId, id, to, {}, `${status}: ${reason}`);
  },
});

/**
 * Resend webhook (svix-signed; signature checked at the edge). The provider email id is matched
 * to our execution receipt to find the tenant and message. Bounces and complaints suppress the
 * address immediately.
 */
registerWebhookHandler('resend', async ({ deps, payload }) => {
  const p = payload as { type?: string; data?: { email_id?: string; bounce?: { type?: string } } };
  const emailId = p.data?.email_id;
  if (!p.type?.startsWith('email.') || !emailId) return 'ignored';
  const [ex] = await withSystem(deps.db, 'system:webhooks', (tx) => tx.select({ tenantId: executions.tenantId, actionId: executions.actionId }).from(executions).where(eq(executions.providerObjectId, emailId)).limit(1));
  if (!ex) return 'ignored';
  const map: Record<string, string> = { 'email.sent': 'sent_unverified', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.complained': 'complained', 'email.failed': 'failed' };
  const status = map[p.type];
  if (!status) return 'ignored';
  const actor = systemActor('resend-webhook');
  await withTenant(deps.db, { tenantId: ex.tenantId, actor: actorRef(actor) }, async (tx) => {
    const [m] = await tx.select().from(messages).where(eq(messages.actionId, ex.actionId));
    if (!m) return;
    await setMessageStatus(tx, ex.tenantId, m.id, status, { providerMessageId: emailId });
    const hard = p.type === 'email.complained' || (p.type === 'email.bounced' && (p.data?.bounce?.type ?? 'Permanent').toLowerCase() !== 'transient');
    if (hard) {
      const [prof] = await tx.select().from(customerProfiles).where(eq(customerProfiles.id, m.profileId));
      if (prof?.email) await addSuppression(tx, deps, ex.tenantId, actor, { channel: 'email', identifier: { kind: 'email', value: prof.email }, reason: p.type === 'email.complained' ? 'complaint' : 'bounce', source: `resend:${emailId}` });
    }
  });
  return 'processed';
});

/* ------------------------------------------------------------------ */
/* Journeys                                                            */
/* ------------------------------------------------------------------ */

export const JourneyStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('wait'),
    hours: z
      .number()
      .positive()
      .max(24 * 90),
  }),
  z.object({ type: z.literal('send_email'), templateId: z.string().uuid() }),
  /** Next-best-message: the variant assigned by an M10 experiment (bandit or fixed) picks the template. */
  z.object({ type: z.literal('send_experiment'), experimentId: z.string().uuid() }),
  z.object({ type: z.literal('exit_if_event'), eventName: z.string().min(1).max(200) }),
]);
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

export const JourneyInputSchema = z.object({
  name: z.string().min(2).max(200),
  triggerEvent: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.:\- ]+$/),
  steps: z.array(JourneyStepSchema).min(1).max(30),
  evidenceFreshnessHours: z.number().int().min(1).max(720).default(168),
  connectionId: z.string().uuid(),
});

export async function createJourney(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'designing journeys');
  const input = JourneyInputSchema.parse(raw);
  if (!input.steps.some((s) => s.type === 'send_email' || s.type === 'send_experiment')) throw invalid('a journey must send at least one message');
  const [row] = await tx
    .insert(journeys)
    .values({ tenantId, name: input.name, triggerEvent: input.triggerEvent, connectionId: input.connectionId, steps: input.steps, evidenceFreshnessHours: input.evidenceFreshnessHours, createdBy: actorRef(actor) })
    .returning();
  await audit(tx, tenantId, actor, 'lifecycle.journey.created', { type: 'journey', id: row!.id }, { name: input.name, trigger: input.triggerEvent, steps: input.steps.length });
  return row!;
}

export function journeyParts(j: typeof journeys.$inferSelect): { connectionId: string; steps: JourneyStep[] } {
  return { connectionId: j.connectionId, steps: z.array(JourneyStepSchema).parse(j.steps) };
}

export async function activateJourney(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'approver'], 'activating journeys');
  const [j] = await tx.select().from(journeys).where(eq(journeys.id, id)).for('update');
  if (!j) throw notFound('journey');
  if (!['draft', 'paused'].includes(j.status)) throw invalid(`journey is ${j.status}`);
  if (j.status === 'draft' && j.createdBy === actorRef(actor)) throw invalid('the designer cannot activate their own journey');
  const { steps } = journeyParts(j);
  const templateIds = steps.flatMap((s) => (s.type === 'send_email' ? [s.templateId] : []));
  if (templateIds.length) {
    const ok = await tx
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(and(inArray(messageTemplates.id, templateIds), eq(messageTemplates.status, 'approved')));
    if (ok.length !== new Set(templateIds).size) throw invalid('every template in the journey must be approved');
  }
  const [row] = await tx
    .update(journeys)
    .set({ status: 'active', approvedBy: j.approvedBy ?? actorRef(actor), activatedAt: j.activatedAt ?? new Date() })
    .where(eq(journeys.id, id))
    .returning();
  await record(tx, tenantId, actor, 'lifecycle.journey.activated', { type: 'journey', id }, { name: j.name });
  return row!;
}

export async function pauseJourney(tx: Tx, tenantId: string, actor: Actor, id: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'approver', 'growth_operator'], 'pausing journeys');
  const [row] = await tx
    .update(journeys)
    .set({ status: 'paused' })
    .where(and(eq(journeys.id, id), eq(journeys.status, 'active')))
    .returning();
  if (!row) throw conflict('journey is not active');
  await audit(tx, tenantId, actor, 'lifecycle.journey.paused', { type: 'journey', id }, { reason });
  return row;
}

/**
 * Enroll profiles from trigger events that arrived after activation. Each enrollment admits
 * pseudonymous first-party evidence (the trigger) with the journey's declared freshness SLA;
 * journey sends are system proposals and therefore need it (D-023, D-025).
 */
export async function enrollFromEvents(deps: CoreDeps, tenantId: string, limit = 500) {
  const actor = systemActor('journey-enroller');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const active = await tx.select().from(journeys).where(eq(journeys.status, 'active'));
    let enrolled = 0;
    for (const j of active) {
      const evs = await tx
        .select({ id: customerEvents.id, profileId: customerEvents.profileId, occurredAt: customerEvents.occurredAt })
        .from(customerEvents)
        .where(and(eq(customerEvents.eventName, j.triggerEvent), gte(customerEvents.receivedAt, j.activatedAt!), sql`${customerEvents.profileId} is not null`, sql`not exists (select 1 from journey_enrollments e where e.journey_id = ${j.id} and e.trigger_event_id = ${customerEvents.id})`))
        .orderBy(asc(customerEvents.receivedAt))
        .limit(limit);
      for (const e of evs) {
        const ev = await admitInternalEvidence(tx, tenantId, actor, {
          kind: 'observation',
          owner: 'first_party_events',
          uri: `customer-event://${e.id}#journey:${j.id}`,
          content: { journeyId: j.id, triggerEvent: j.triggerEvent, eventId: e.id, profileId: e.profileId, occurredAt: e.occurredAt.toISOString() },
          summary: `Trigger ${j.triggerEvent} for journey ${j.name}`,
          confidence: 1,
          license: 'first-party event data',
          pii: 'pseudonymous',
          permittedUses: ['autonomous_execution', 'personalization'],
          observedAt: e.occurredAt,
          freshnessSlaHours: j.evidenceFreshnessHours,
          now: deps.clock.now(),
        });
        const ins = await tx.insert(journeyEnrollments).values({ tenantId, journeyId: j.id, profileId: e.profileId!, nextRunAt: deps.clock.now(), enrolledAt: deps.clock.now(), triggerEventId: e.id, evidenceId: ev.evidenceId }).onConflictDoNothing().returning({ id: journeyEnrollments.id });
        if (ins.length) {
          enrolled++;
          await record(tx, tenantId, actor, 'lifecycle.enrollment.created', { type: 'journey_enrollment', id: ins[0]!.id }, { journeyId: j.id });
        }
      }
    }
    return { enrolled };
  });
}

const LEASE_MS = 10 * 60_000;

/** Advance due enrollments. Claims use SKIP LOCKED plus a lease, so concurrent ticks never double-step. */
export async function tickJourneys(deps: CoreDeps, tenantId: string, limit = 100) {
  const actor = systemActor('journey-runner');
  const now = deps.clock.now();
  const claimed = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const rows = await tx
      .select()
      .from(journeyEnrollments)
      .where(and(eq(journeyEnrollments.state, 'active'), lte(journeyEnrollments.nextRunAt, now)))
      .orderBy(asc(journeyEnrollments.nextRunAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (rows.length)
      await tx
        .update(journeyEnrollments)
        .set({ nextRunAt: new Date(now.getTime() + LEASE_MS) })
        .where(
          inArray(
            journeyEnrollments.id,
            rows.map((r) => r.id),
          ),
        );
    return rows;
  });
  const results: { enrollmentId: string; outcome: string }[] = [];
  for (const en of claimed) {
    try {
      results.push({ enrollmentId: en.id, outcome: await advance(deps, tenantId, actor, en) });
    } catch (err) {
      deps.logger.error({ enrollmentId: en.id, err: err instanceof Error ? err.message : String(err) }, 'journey step failed');
      results.push({ enrollmentId: en.id, outcome: 'error' });
    }
  }
  return results;
}

async function advance(deps: CoreDeps, tenantId: string, actor: Actor, en: typeof journeyEnrollments.$inferSelect): Promise<string> {
  const now = deps.clock.now();
  const ctx = { tenantId, actor: actorRef(actor) };
  const { j, profile } = await withTenant(deps.db, ctx, async (tx) => ({
    j: (await tx.select().from(journeys).where(eq(journeys.id, en.journeyId)))[0]!,
    profile: (await tx.select().from(customerProfiles).where(eq(customerProfiles.id, en.profileId)))[0],
  }));
  const exit = (reason: string, state: 'exited' | 'completed' = 'exited') => withTenant(deps.db, ctx, (tx) => tx.update(journeyEnrollments).set({ state, exitReason: reason, updatedAt: now }).where(eq(journeyEnrollments.id, en.id))).then(() => reason);
  if (!profile || profile.deletedAt) return exit('profile_deleted');
  if (j.status === 'paused') {
    await withTenant(deps.db, ctx, (tx) =>
      tx
        .update(journeyEnrollments)
        .set({ nextRunAt: new Date(now.getTime() + 3_600_000) })
        .where(eq(journeyEnrollments.id, en.id)),
    );
    return 'paused';
  }
  if (j.status !== 'active') return exit(`journey_${j.status}`);
  const { connectionId, steps } = journeyParts(j);
  const proposer: Actor = { type: 'system', id: `journey:${j.id}`, roles: [], mfaVerified: false };
  let idx = en.stepIndex;
  for (let guard = 0; guard < steps.length + 1; guard++) {
    const step = steps[idx];
    if (!step) return exit('completed', 'completed');
    if (step.type === 'wait') {
      await withTenant(deps.db, ctx, (tx) =>
        tx
          .update(journeyEnrollments)
          .set({ stepIndex: idx + 1, nextRunAt: new Date(now.getTime() + step.hours * 3_600_000), updatedAt: now })
          .where(eq(journeyEnrollments.id, en.id)),
      );
      return 'waiting';
    }
    if (step.type === 'exit_if_event') {
      const [hit] = await withTenant(deps.db, ctx, (tx) =>
        tx
          .select({ id: customerEvents.id })
          .from(customerEvents)
          .where(and(eq(customerEvents.profileId, en.profileId), eq(customerEvents.eventName, step.eventName), gte(customerEvents.occurredAt, en.enrolledAt)))
          .limit(1),
      );
      if (hit) return exit('goal_reached', 'completed');
    } else {
      let templateId: string | null = step.type === 'send_email' ? step.templateId : null;
      if (step.type === 'send_experiment') {
        const choice = await withTenant(deps.db, ctx, async (tx) => {
          const a = await assignVariant(tx, step.experimentId, en.profileId, { ...(profile.country ? { country: profile.country } : {}), ...(profile.locale ? { locale: profile.locale } : {}) });
          if (!a.variant) return { holdout: a.holdout, templateId: null as string | null };
          const r = await tx.execute<{ template_id: string | null }>(sql`select config->>'templateId' as template_id from experiment_variants where experiment_id = ${step.experimentId} and key = ${a.variant}`);
          return { holdout: false, templateId: r.rows[0]?.template_id ?? null };
        });
        templateId = choice.templateId; // holdout / not running => no message for this step
      }
      if (templateId) {
        await submitMessage(deps, tenantId, proposer, {
          messageId: stableUuid(`journey:${en.id}:step:${idx}`),
          profileId: en.profileId,
          templateId,
          journeyId: j.id,
          enrollmentId: en.id,
          evidenceIds: en.evidenceId ? [en.evidenceId] : [],
          connectionId,
        });
      }
    }
    idx++;
    await withTenant(deps.db, ctx, (tx) => tx.update(journeyEnrollments).set({ stepIndex: idx, nextRunAt: now, updatedAt: now }).where(eq(journeyEnrollments.id, en.id)));
  }
  return 'advanced';
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export async function listTemplates(tx: DbOrTx) {
  return tx.select().from(messageTemplates).where(ne(messageTemplates.status, 'archived')).orderBy(asc(messageTemplates.name), desc(messageTemplates.version)).limit(500);
}

export async function listJourneys(tx: DbOrTx) {
  return tx.select().from(journeys).orderBy(desc(journeys.createdAt)).limit(200);
}

export async function journeyStats(tx: DbOrTx, journeyId: string) {
  const enroll = await tx.execute<{ state: string; n: number }>(sql`select state, count(*)::int as n from journey_enrollments where journey_id = ${journeyId} group by state`);
  const msgs = await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from messages where journey_id = ${journeyId} group by status`);
  return { enrollments: enroll.rows, messages: msgs.rows };
}

export async function deliveryReport(tx: DbOrTx, since: Date) {
  const r = await tx.execute<{ category: string; status: string; n: number }>(sql`select category, status, count(*)::int as n from messages where created_at >= ${since} group by 1, 2 order by 1, 2`);
  return r.rows;
}

export async function listMessages(tx: DbOrTx, profileId?: string) {
  const q = tx.select().from(messages);
  return (profileId ? q.where(eq(messages.profileId, profileId)) : q).orderBy(desc(messages.createdAt)).limit(200);
}
