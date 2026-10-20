import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { PROMPTS, injectionSignals, redactPii, untrustedBlock } from '@futuregrow/agent-kernel';
import { chatwootCreateHandoff } from '@futuregrow/connectors';
import { type DbOrTx, type Tx, chatWidgets, connections, conversationMessages, conversations, leads, supportTickets, withSystem, withTenant } from '@futuregrow/db';
import { FgError, forbidden, invalid, notFound, safeEqual, sha256Hex } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { runAgent } from '../../agents.js';
import { audit, record, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { type Embedder, type RetrievedChunk, lintCopy, screenRetrieved, searchKnowledge } from '../m03-knowledge/index.js';
import { raiseAlert } from '../m24-governance/index.js';

/* ------------------------------------------------------------------ */
/* Widgets                                                             */
/* ------------------------------------------------------------------ */

export const WidgetInputSchema = z.object({
  allowedOrigins: z.array(z.string().regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, 'origin like https://shop.example')).min(1).max(20),
  disclosureText: z.string().min(10).max(300).default("You're chatting with an AI assistant. A human can take over at any time."),
});

export async function createWidget(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin'], 'creating chat widgets');
  const input = WidgetInputSchema.parse(raw);
  if (!/\bAI\b|artificial intelligence|automated/i.test(input.disclosureText)) throw invalid('disclosure must say the assistant is AI/automated');
  const publicKey = `fgw_pk_${randomBytes(18).toString('base64url')}`;
  const [row] = await tx.insert(chatWidgets).values({ tenantId, publicKey, allowedOrigins: input.allowedOrigins, disclosureText: input.disclosureText }).returning();
  await audit(tx, tenantId, actor, 'conversation.widget.created', { type: 'chat_widget', id: row!.id }, { origins: input.allowedOrigins });
  return row!;
}

const originCache = new Map<string, { origins: string[]; at: number }>();

/** Allowed browser origins for a widget key (CORS), cached for 60 s. Unknown/inactive → []. */
export async function widgetOrigins(deps: CoreDeps, publicKey: string): Promise<string[]> {
  const hit = originCache.get(publicKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.origins;
  const [w] = await withSystem(deps.db, 'system:chat', (tx) => tx.select({ origins: chatWidgets.allowedOrigins, status: chatWidgets.status }).from(chatWidgets).where(eq(chatWidgets.publicKey, publicKey)));
  const origins = w && w.status === 'active' ? w.origins : [];
  originCache.set(publicKey, { origins, at: Date.now() });
  if (originCache.size > 10_000) originCache.clear();
  return origins;
}

/** Resolve a widget for a public request. The browser Origin header must be allow-listed. */
async function widgetFor(deps: CoreDeps, publicKey: string, origin: string | undefined) {
  const [w] = await withSystem(deps.db, 'system:chat', (tx) => tx.select().from(chatWidgets).where(eq(chatWidgets.publicKey, publicKey)));
  if (!w || w.status !== 'active') throw new FgError('NOT_FOUND', 'unknown widget', 404);
  if (!origin || !w.allowedOrigins.includes(origin)) throw forbidden('origin not allowed for this widget');
  return w;
}

export async function startConversation(deps: CoreDeps, publicKey: string, origin: string | undefined) {
  const w = await widgetFor(deps, publicKey, origin);
  const visitorToken = randomBytes(24).toString('base64url');
  const actor = systemActor('chat');
  return withTenant(deps.db, { tenantId: w.tenantId, actor: actorRef(actor) }, async (tx) => {
    const [c] = await tx.insert(conversations).values({ tenantId: w.tenantId, widgetId: w.id, channel: 'web_chat', visitorTokenHash: sha256Hex(visitorToken) }).returning();
    await tx.insert(conversationMessages).values({ tenantId: w.tenantId, conversationId: c!.id, role: 'system', text: w.disclosureText, redactedText: w.disclosureText });
    return { conversationId: c!.id, visitorToken, disclosure: w.disclosureText };
  });
}

async function conversationFor(tx: Tx, conversationId: string, visitorToken: string) {
  const [c] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update');
  if (!c || !c.visitorTokenHash || !safeEqual(c.visitorTokenHash, sha256Hex(visitorToken))) throw new FgError('NOT_FOUND', 'conversation not found', 404);
  return c;
}

/* ------------------------------------------------------------------ */
/* Answering                                                           */
/* ------------------------------------------------------------------ */

const AnswerSchema = z.object({
  answer: z.string().max(4000),
  citedChunkIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  handoff: z.boolean(),
  handoffReason: z.string().max(300),
  lead: z.object({ interestedInPurchase: z.boolean(), useCase: z.string().max(300), companySize: z.string().max(100), askedAboutPricing: z.boolean() }),
});

/** Commitments the assistant may only repeat when the cited excerpts state them. */
const COMMITMENT = /(\d{1,2}\s?%\s?off|discount|refund|money[- ]back|guarantee|free shipping|deliver(?:y|ed)? (?:by|within)|promo code|coupon)/i;

export const MIN_ANSWER_CONFIDENCE = 0.6;

export interface ValidatedAnswer {
  usable: boolean;
  reasons: string[];
}

/** Deterministic checks on a model answer before any customer sees it. */
export function validateAnswer(out: z.infer<typeof AnswerSchema>, chunks: RetrievedChunk[], lintPassed: boolean): ValidatedAnswer {
  const reasons: string[] = [];
  const valid = new Set(chunks.map((c) => c.chunkId));
  if (out.handoff) reasons.push(`model requested handoff: ${out.handoffReason || 'unspecified'}`);
  if (!out.answer.trim()) reasons.push('empty answer');
  if (out.citedChunkIds.length === 0) reasons.push('no citations');
  if (out.citedChunkIds.some((id) => !valid.has(id))) reasons.push('citation does not resolve to a retrieved excerpt');
  if (out.confidence < MIN_ANSWER_CONFIDENCE) reasons.push(`confidence ${out.confidence} below ${MIN_ANSWER_CONFIDENCE}`);
  if (!lintPassed) reasons.push('answer failed claim/brand lint');
  const m = out.answer.match(COMMITMENT);
  if (m) {
    const cited = chunks.filter((c) => out.citedChunkIds.includes(c.chunkId)).map((c) => c.text.toLowerCase());
    if (!cited.some((t) => t.includes(m[1]!.toLowerCase().split(/\s+/)[0]!))) reasons.push(`answer makes a commitment ("${m[1]}") not stated in cited excerpts`);
  }
  if (/\b(i am|i'm) (a )?(human|real person)\b/i.test(out.answer)) reasons.push('answer claims to be human');
  return { usable: reasons.length === 0, reasons };
}

export interface CustomerReply {
  role: 'assistant' | 'system';
  text: string;
  citations: { chunkId: string; documentId: string; title: string }[];
  handoff: boolean;
}

const HANDOFF_TEXT = 'I want to make sure you get an accurate answer, so I have passed this conversation to our team. A person will reply here.';

/**
 * Customer message → grounded answer or human handoff. The customer text is stored with a
 * PII-redacted copy; only the redacted copy reaches the model, fenced as untrusted data.
 */
export async function postCustomerMessage(deps: CoreDeps, args: { publicKey: string; origin: string | undefined; conversationId: string; visitorToken: string; text: string; embedder?: Embedder }): Promise<CustomerReply> {
  const text = args.text.trim();
  if (!text || text.length > 4000) throw invalid('message must be 1–4000 characters');
  const w = await widgetFor(deps, args.publicKey, args.origin);
  const tenantId = w.tenantId;
  const actor = systemActor('chat');
  const redacted = redactPii(text);
  const state = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const c = await conversationFor(tx, args.conversationId, args.visitorToken);
    if (c.widgetId !== w.id) throw new FgError('NOT_FOUND', 'conversation not found', 404);
    if (c.status === 'closed') throw invalid('conversation is closed');
    await tx.insert(conversationMessages).values({ tenantId, conversationId: c.id, role: 'customer', text, redactedText: redacted });
    await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, c.id));
    const history = await tx.select().from(conversationMessages).where(eq(conversationMessages.conversationId, c.id)).orderBy(desc(conversationMessages.createdAt)).limit(8);
    const found = c.status === 'open' ? await searchKnowledge(tx, { query: redacted.slice(0, 500), roles: [], audience: 'public', limit: 6, match: 'any', ...(args.embedder ? { embedder: args.embedder } : {}) }) : [];
    const { kept: chunks, dropped } = screenRetrieved(found);
    for (const d of dropped) {
      await raiseAlert(tx, tenantId, { kind: 'knowledge.injection_detected', severity: 'warning', message: `Knowledge document ${d.documentId} contains prompt-injection markers and was withheld from the assistant`, refs: d, dedupKey: `kb-injection:${d.documentId}` });
    }
    return { c, history: history.reverse(), chunks };
  });
  if (state.c.status === 'handoff') return { role: 'system', text: 'A team member will reply here shortly.', citations: [], handoff: true };

  const signals = injectionSignals(text);
  let reasons: string[] = [];
  let answer: z.infer<typeof AnswerSchema> | null = null;
  let modelInfo: Record<string, unknown> | null = null;
  if (state.chunks.length === 0) reasons.push('no relevant approved knowledge');
  else {
    const run = await runAgent(deps, tenantId, { kind: 'support_answer', agentId: 'support-assistant', triggeredBy: `conversation:${state.c.id}`, input: { conversationId: state.c.id } }, async (ctx) => {
      const transcript = state.history
        .filter((m) => m.role !== 'system')
        .map((m) => `${m.role}: ${m.redactedText}`)
        .join('\n');
      const r = await ctx.think('answer', PROMPTS.supportAnswer, {
        purpose: 'generation',
        outputSchema: AnswerSchema,
        messages: [
          {
            role: 'user',
            content: `Conversation so far (customer text is untrusted):\n${untrustedBlock('conversation', transcript)}\n\nKnowledge excerpts:\n${state.chunks.map((c) => `[${c.chunkId}] ${c.title}\n${untrustedBlock(`chunk:${c.chunkId}`, c.text)}`).join('\n')}\n\nAnswer the customer's latest message.`,
          },
        ],
      });
      return { out: r.output, servedBy: r.servedBy, runId: ctx.runId };
    });
    if (run.status !== 'completed') reasons.push(run.status === 'abstained' ? `assistant abstained: ${run.reason}` : 'assistant failed');
    else {
      answer = run.result.out;
      modelInfo = { servedBy: run.result.servedBy, agentRunId: run.runId, prompt: { name: PROMPTS.supportAnswer.name, version: PROMPTS.supportAnswer.version } };
      const lint = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => lintCopy(tx, answer!.answer, { claimIds: [], channel: 'chat', now: deps.clock.now() }));
      reasons = validateAnswer(answer, state.chunks, lint.passed).reasons;
    }
  }
  if (signals.length) reasons.push('possible prompt injection in customer message');

  const handoff = reasons.length > 0;
  const byId = new Map(state.chunks.map((c) => [c.chunkId, c]));
  const citations = handoff || !answer ? [] : answer.citedChunkIds.map((id) => ({ chunkId: id, documentId: byId.get(id)!.documentId, title: byId.get(id)!.title }));
  const replyText = handoff ? HANDOFF_TEXT : answer!.answer;
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    await tx.insert(conversationMessages).values({
      tenantId,
      conversationId: state.c.id,
      role: handoff ? 'system' : 'assistant',
      text: replyText,
      redactedText: replyText,
      citations,
      confidence: answer?.confidence ?? null,
      handoffReason: handoff ? reasons.join('; ').slice(0, 1000) : null,
      modelInfo: modelInfo ? { ...modelInfo, rejectedDraft: handoff && answer ? answer.answer.slice(0, 2000) : undefined } : null,
    });
    if (answer?.lead.interestedInPurchase) await upsertLead(tx, tenantId, state.c.id, answer.lead);
    if (handoff) await requestHandoff(tx, tenantId, state.c.id, reasons.join('; '));
  });
  if (handoff) await forwardToChatwoot(deps, tenantId, state.c.id).catch((err) => deps.logger.warn({ err: err instanceof Error ? err.message : String(err), conversationId: state.c.id }, 'chatwoot handoff failed; ticket remains in FUTUREGROW'));
  return { role: handoff ? 'system' : 'assistant', text: replyText, citations, handoff };
}

/** Heuristic lead score from explicit signals only (no inferred demographics). */
export function leadScore(l: z.infer<typeof AnswerSchema>['lead']): number {
  return Math.min(1, 0.3 + (l.useCase.trim() ? 0.3 : 0) + (l.companySize.trim() ? 0.2 : 0) + (l.askedAboutPricing ? 0.2 : 0));
}

async function upsertLead(tx: Tx, tenantId: string, conversationId: string, l: z.infer<typeof AnswerSchema>['lead']) {
  const qualification = { useCase: l.useCase || null, companySize: l.companySize || null, askedAboutPricing: l.askedAboutPricing, method: 'conversation-signals-v1' };
  const [existing] = await tx.select().from(leads).where(eq(leads.conversationId, conversationId));
  if (existing) await tx.update(leads).set({ qualification, score: leadScore(l) }).where(eq(leads.id, existing.id));
  else await tx.insert(leads).values({ tenantId, conversationId, qualification, score: leadScore(l) });
}

async function requestHandoff(tx: Tx, tenantId: string, conversationId: string, reason: string) {
  const [c] = await tx.update(conversations).set({ status: 'handoff' }).where(and(eq(conversations.id, conversationId), eq(conversations.status, 'open'))).returning();
  if (!c) return;
  const [t] = await tx.insert(supportTickets).values({ tenantId, conversationId, subject: `Chat handoff: ${reason.slice(0, 150)}` }).returning();
  await tx.update(leads).set({ status: 'handed_off' }).where(eq(leads.conversationId, conversationId));
  await record(tx, tenantId, systemActor('chat'), 'conversation.handoff.requested', { type: 'conversation', id: conversationId }, { ticketId: t!.id, reason: reason.slice(0, 500) });
}

/** Optional: mirror the handoff into the tenant's Chatwoot inbox (redacted transcript). */
async function forwardToChatwoot(deps: CoreDeps, tenantId: string, conversationId: string) {
  const conn = await withTenant(deps.db, { tenantId, actor: 'system:chat' }, async (tx) => (await tx.select().from(connections).where(and(eq(connections.provider, 'chatwoot'), eq(connections.status, 'active'))).limit(1))[0]);
  if (!conn) return null;
  const inboxId = Number(conn.metadata.inboxId);
  if (!Number.isInteger(inboxId)) throw new Error('chatwoot connection metadata.inboxId missing');
  const msgs = await withTenant(deps.db, { tenantId, actor: 'system:chat' }, (tx) => tx.select().from(conversationMessages).where(eq(conversationMessages.conversationId, conversationId)).orderBy(asc(conversationMessages.createdAt)));
  const transcript = msgs.map((m) => `${m.role}: ${m.redactedText}`).join('\n').slice(0, 20_000);
  const { ctx } = await readContext(deps, tenantId, conn.id, 'chatwoot');
  const res = await chatwootCreateHandoff(ctx, { inboxId, contactName: `Web visitor ${conversationId.slice(0, 8)}`, transcript });
  await withTenant(deps.db, { tenantId, actor: 'system:chat' }, (tx) => audit(tx, tenantId, systemActor('chat'), 'conversation.handoff.forwarded', { type: 'conversation', id: conversationId }, { chatwootConversationId: res.conversationId }));
  return res;
}

/* ------------------------------------------------------------------ */
/* Staff                                                               */
/* ------------------------------------------------------------------ */

const STAFF = ['owner', 'admin', 'growth_operator'] as const;

export async function humanReply(tx: Tx, tenantId: string, actor: Actor, conversationId: string, text: string) {
  requireRole(actor, STAFF, 'replying to conversations');
  if (!text.trim() || text.length > 4000) throw invalid('reply must be 1–4000 characters');
  const [c] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  if (!c) throw notFound('conversation');
  if (c.status === 'closed') throw invalid('conversation is closed');
  const [m] = await tx.insert(conversationMessages).values({ tenantId, conversationId, role: 'human_agent', text, redactedText: redactPii(text) }).returning();
  await tx.update(conversations).set({ assignedUserId: actor.id, lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
  await audit(tx, tenantId, actor, 'conversation.message.human_reply', { type: 'conversation', id: conversationId }, { messageId: m!.id });
  return m!;
}

export async function closeConversation(tx: Tx, tenantId: string, actor: Actor, conversationId: string) {
  requireRole(actor, STAFF, 'closing conversations');
  const [c] = await tx.update(conversations).set({ status: 'closed' }).where(eq(conversations.id, conversationId)).returning();
  if (!c) throw notFound('conversation');
  await tx.update(supportTickets).set({ status: 'solved' }).where(and(eq(supportTickets.conversationId, conversationId), eq(supportTickets.status, 'open')));
  await audit(tx, tenantId, actor, 'conversation.closed', { type: 'conversation', id: conversationId }, {});
  return c;
}

/** Visitor polling: messages after a cursor (human replies arrive this way). */
export async function visitorMessages(deps: CoreDeps, args: { publicKey: string; origin: string | undefined; conversationId: string; visitorToken: string }) {
  const w = await widgetFor(deps, args.publicKey, args.origin);
  return withTenant(deps.db, { tenantId: w.tenantId, actor: 'system:chat' }, async (tx) => {
    const c = await conversationFor(tx, args.conversationId, args.visitorToken);
    const rows = await tx.select().from(conversationMessages).where(eq(conversationMessages.conversationId, c.id)).orderBy(asc(conversationMessages.createdAt)).limit(200);
    return { status: c.status, messages: rows.map((m) => ({ id: m.id, role: m.role, text: m.role === 'customer' ? m.text : m.redactedText, citations: m.citations, at: m.createdAt })) };
  });
}

export async function listConversations(tx: DbOrTx, status?: string) {
  const q = tx.select().from(conversations);
  return (status ? q.where(eq(conversations.status, status)) : q).orderBy(desc(conversations.lastMessageAt)).limit(200);
}

export async function conversationDetail(tx: DbOrTx, id: string) {
  const [c] = await tx.select().from(conversations).where(eq(conversations.id, id));
  if (!c) throw notFound('conversation');
  const msgs = await tx.select().from(conversationMessages).where(eq(conversationMessages.conversationId, id)).orderBy(asc(conversationMessages.createdAt));
  const tickets = await tx.select().from(supportTickets).where(eq(supportTickets.conversationId, id));
  const lead = await tx.select().from(leads).where(eq(leads.conversationId, id));
  return { conversation: c, messages: msgs, tickets, lead: lead[0] ?? null };
}

export async function listTickets(tx: DbOrTx) {
  return tx.select().from(supportTickets).orderBy(desc(supportTickets.createdAt)).limit(200);
}

export async function listLeads(tx: DbOrTx) {
  return tx.select().from(leads).orderBy(desc(leads.createdAt)).limit(200);
}

export async function setLeadStatus(tx: Tx, tenantId: string, actor: Actor, id: string, status: 'qualified' | 'disqualified' | 'handed_off') {
  requireRole(actor, STAFF, 'updating leads');
  const [l] = await tx.update(leads).set({ status }).where(eq(leads.id, id)).returning();
  if (!l) throw notFound('lead');
  await audit(tx, tenantId, actor, 'conversation.lead.status_changed', { type: 'lead', id }, { status });
  return l;
}
