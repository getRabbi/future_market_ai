import { randomUUID } from 'node:crypto';
import type { ModelProvider, ProviderOutcome, StructuredRequest } from '@futuregrow/agent-kernel';
import { PROMPTS } from '@futuregrow/agent-kernel';
import { actionRequests, commissionLedger, consentState, conversationMessages, conversations, creatorSubmissions, customerProfiles, fraudFlags, journeyEnrollments, leads, messages, referralClicks, referralConversions, supportTickets, suppressions, withTenant } from '@futuregrow/db';
import { identifierHash } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type CoreHarness, createCoreHarness } from '../../../test/helpers/core.js';
import { FixtureServer } from '../../../test/helpers/fixture-server.js';
import { clearModelCache, createModelGateway } from '../src/agents.js';
import { createConnection } from '../src/modules/connections.js';
import { admitEvidence } from '../src/modules/m01-evidence/index.js';
import { ingestEvents, recordConsent } from '../src/modules/m02-customers/index.js';
import { ingestDocument } from '../src/modules/m03-knowledge/index.js';
import * as life from '../src/modules/m20-lifecycle/index.js';
import * as conv from '../src/modules/m21-conversations/index.js';
import * as cre from '../src/modules/m22-creators/index.js';
import { executeAction, verifyAction } from '../src/modules/m23-execution/gateway.js';
import { approveModel, seedModelRegistry, setSenderIdentity, setTenantPolicy, upsertJurisdictionRules } from '../src/modules/m24-governance/index.js';
import { ingestWebhook, processWebhook } from '../src/modules/webhooks.js';

class ScriptedProvider implements ModelProvider {
  readonly name = 'anthropic';
  responders = new Map<string, (req: StructuredRequest<unknown>) => unknown>();
  requests: StructuredRequest<unknown>[] = [];
  async generateStructured<T>(req: StructuredRequest<T>): Promise<ProviderOutcome<T>> {
    this.requests.push(req as StructuredRequest<unknown>);
    const r = this.responders.get(req.system);
    if (!r) throw new Error('no scripted response');
    return { kind: 'ok', output: r(req as StructuredRequest<unknown>) as T, servedBy: 'claude-opus-5-5', usage: { inputTokens: 300, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'end_turn', requestId: 'req_s' };
  }
}

const server = new FixtureServer();
let h: CoreHarness;
let provider: ScriptedProvider;
let resendConn: string;
const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(h.t.handle.db, { tenantId: h.tenantId, actor: 'user:test' }, fn);

async function evidence(kind: string, content: Record<string, unknown> = {}) {
  return tx((t) =>
    admitEvidence(
      t,
      h.tenantId,
      h.users.owner,
      {
        sourceType: 'internal',
        sourceOwner: 'acme',
        sourceUriOrObjectId: `doc://${randomUUID()}`,
        retrievedAt: h.clock.now().toISOString(),
        licenseOrUsageRights: 'first-party',
        schemaVersion: '1',
        piiClassification: 'none',
        confidence: 1,
        freshnessSlaHours: 24 * 365,
        permittedUses: ['analytics', 'creative_generation', 'publishing'],
        kind,
        content: { ...content, n: randomUUID() },
      } as never,
      { now: h.clock.now() },
    ),
  );
}

async function profile(email: string, opts: { consent?: boolean; country?: string } = {}) {
  const userId = `u-${randomUUID().slice(0, 8)}`;
  const r = await ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'identify', timestamp: h.clock.now().toISOString(), userId, email, context: { country: opts.country ?? 'US', timezone: 'UTC' } }], { verifiedEmail: true });
  const profileId = r.profileIds[0]!;
  await tx((t) => t.update(customerProfiles).set({ displayName: 'Dana <Ops>' }).where(eq(customerProfiles.id, profileId)));
  if (opts.consent !== false) {
    await tx((t) => recordConsent(t, h.tenantId, h.users.owner, { profileId, purpose: 'marketing_email', status: 'granted', lawfulBasis: 'consent', source: 'signup_form', capturedAt: h.clock.now().toISOString() }));
  }
  return { profileId, userId };
}

let emailCount = 0;
const sent: { id: string; body: Record<string, any> }[] = [];
function mountResend() {
  server.on('POST', '/emails', (req) => {
    const id = `em_${++emailCount}`;
    sent.push({ id, body: req.json as Record<string, any> });
    return { json: { id } };
  });
  server.on('GET', /^\/emails\/em_\d+$/, (req) => ({ json: { id: req.path.split('/').pop(), last_event: 'delivered' } }));
}

beforeAll(async () => {
  await server.start();
  h = await createCoreHarness({ endpointBase: server.baseUrl });
  await seedModelRegistry(h.t.handle.db);
  await approveModel(h.t.handle.db, { userId: h.users.owner.id }, { provider: 'anthropic', modelId: 'claude-opus-5-5', trainingOnCustomerData: 'no', dataRetentionTerms: 'reviewed', inputUsdPerMtok: 4, outputUsdPerMtok: 20 });
  clearModelCache();
  provider = new ScriptedProvider();
  h.deps.models = createModelGateway(h.deps, { anthropic: provider });
  await upsertJurisdictionRules(h.t.handle.db, { userId: h.users.owner.id }, { jurisdiction: 'US', domain: 'messaging', rules: { canSpam: true }, sourceRefs: ['https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business'], approve: true });
  await tx((t) =>
    setTenantPolicy(t, h.tenantId, h.users.owner, {
      configured: true,
      currency: 'USD',
      approvedJurisdictions: ['US'],
      messaging: { maxCommercialMessagesPerProfilePerWeek: 3, quietHours: { startHour: 22, endHour: 7, timezone: 'UTC' } },
      categories: { MESSAGING: { autonomy: 'pre_authorized_within_limits', approverRoles: ['approver'], requiresDistinctApprover: true, maxAudienceSize: 1 } },
    }),
  );
  await tx((t) => setSenderIdentity(t, h.tenantId, h.users.owner, { fromName: 'Acme', fromEmail: 'hello@acme.test', postalAddress: '1 Market St, San Francisco, CA 94105, USA' }));
  resendConn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'resend', externalAccountId: 'acme.test', displayName: 'Resend', grantedScopes: [], credentials: { apiKey: 're_test' } })).id;
});

afterAll(async () => {
  await h?.close();
  await server.stop();
});

beforeEach(() => {
  server.reset();
  provider.responders.clear();
  provider.requests.length = 0;
});

/* ------------------------------------------------------------------ */

describe('M20 lifecycle messaging', () => {
  let welcomeId: string;
  let followId: string;
  let journeyId: string;

  it('rejects unsafe templates, renders a CAN-SPAM footer and escapes personalisation', async () => {
    await expect(tx((t) => life.createTemplate(t, h.deps, h.tenantId, h.users.operator, { name: 'promo', category: 'commercial', subject: 'Hi {{email}}', bodyText: 'b' }))).rejects.toThrow(/unknown variable/);
    await expect(tx((t) => life.createTemplate(t, h.deps, h.tenantId, h.users.operator, { name: 'promo', category: 'commercial', subject: 'RE: your order', bodyText: 'b' }))).rejects.toThrow(/deceptive/);
    await expect(tx((t) => life.createTemplate(t, h.deps, h.tenantId, h.users.operator, { name: 'promo', category: 'commercial', subject: 'Hi', bodyText: 'b', bodyHtml: '<p onclick="x()">b</p>' }))).rejects.toThrow(/event handlers/);
    const r = life.renderEmail({ subject: 'Hi {{first_name}}', bodyText: 'Hello {{display_name}}', bodyHtml: '<p>Hello {{display_name}}</p>', category: 'commercial' }, { displayName: 'Dana <Ops>' }, { fromName: 'Acme', fromEmail: 'a@acme.test', postalAddress: '1 Market St, SF' }, 'https://api/u/t');
    expect(r.subject).toBe('Hi Dana');
    expect(r.html).toContain('Hello Dana &lt;Ops&gt;');
    expect(r.text).toContain('1 Market St, SF');
    expect(r.text).toContain('Unsubscribe: https://api/u/t');
    expect(() => life.renderEmail({ subject: 's', bodyText: 'b', bodyHtml: null, category: 'commercial' }, { displayName: null }, { fromName: 'A', fromEmail: 'a@a.t', postalAddress: 'x' }, null)).toThrow(/unsubscribe/);
  });

  it('signs unsubscribe tokens with the identifier pepper', () => {
    const t = life.unsubscribeToken('pepper', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    expect(life.parseUnsubscribeToken('pepper', t)).toEqual({ tenantId: '11111111-1111-4111-8111-111111111111', messageId: '22222222-2222-4222-8222-222222222222' });
    expect(life.parseUnsubscribeToken('other', t)).toBeNull();
    expect(life.parseUnsubscribeToken('pepper', `${t.slice(0, -1)}${t.endsWith('a') ? 'b' : 'a'}`)).toBeNull();
  });

  it('runs a triggered journey: evidence-backed, policy pre-authorized, rendered at the boundary, verified', async () => {
    const welcome = await tx((t) =>
      life.createTemplate(t, h.deps, h.tenantId, h.users.operator, { name: 'welcome', category: 'commercial', subject: 'Welcome, {{first_name}}', bodyText: 'Thanks for joining {{company_name}}. Connect your first data source from Settings.', bodyHtml: '<p>Thanks for joining {{company_name}}.</p>' }),
    );
    const follow = await tx((t) => life.createTemplate(t, h.deps, h.tenantId, h.users.operator, { name: 'follow-up', category: 'commercial', subject: 'Need a hand?', bodyText: 'Reply to this email and our team will help you set up.' }));
    await expect(tx((t) => life.approveTemplate(t, h.deps, h.tenantId, { ...h.users.operator, roles: ['admin'] }, welcome.id))).rejects.toThrow(/author/);
    welcomeId = (await tx((t) => life.approveTemplate(t, h.deps, h.tenantId, h.users.approver, welcome.id))).id;
    followId = (await tx((t) => life.approveTemplate(t, h.deps, h.tenantId, h.users.approver, follow.id))).id;

    const j = await tx((t) =>
      life.createJourney(t, h.tenantId, h.users.operator, {
        name: 'Onboarding',
        triggerEvent: 'signup',
        connectionId: resendConn,
        steps: [
          { type: 'send_email', templateId: welcomeId },
          { type: 'wait', hours: 24 },
          { type: 'exit_if_event', eventName: 'integration_connected' },
          { type: 'send_email', templateId: followId },
        ],
      }),
    );
    journeyId = j.id;
    await expect(tx((t) => life.activateJourney(t, h.tenantId, { ...h.users.operator, roles: ['admin'] }, j.id))).rejects.toThrow(/designer/);
    await tx((t) => life.activateJourney(t, h.tenantId, h.users.approver, j.id));

    const { profileId, userId } = await profile('dana@example.com');
    await ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'signup', timestamp: h.clock.now().toISOString(), userId }]);
    expect(await life.enrollFromEvents(h.deps, h.tenantId)).toEqual({ enrolled: 1 });
    expect(await life.enrollFromEvents(h.deps, h.tenantId)).toEqual({ enrolled: 0 }); // trigger consumed once

    const tick = await life.tickJourneys(h.deps, h.tenantId);
    expect(tick).toEqual([{ enrollmentId: expect.any(String), outcome: 'waiting' }]);
    const [m] = await tx((t) => t.select().from(messages).where(eq(messages.journeyId, j.id)));
    expect(m).toMatchObject({ status: 'submitted', category: 'commercial', profileId });
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, m!.actionId!)));
    expect(a).toMatchObject({ status: 'APPROVED', proposedByType: 'system', proposedById: `journey:${j.id}` });
    expect(a!.evidenceIds).toHaveLength(1);
    expect(a!.params).not.toHaveProperty('to'); // the address is resolved only at the boundary

    mountResend();
    expect(await executeAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'EXECUTED_UNVERIFIED' });
    const mail = sent.at(-1)!.body;
    expect(mail.to).toEqual(['dana@example.com']);
    expect(mail.from).toBe('Acme <hello@acme.test>');
    expect(mail.subject).toBe('Welcome, Dana');
    expect(mail.text).toContain('1 Market St, San Francisco');
    expect(mail.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.futuregrow\.test\/u\/.+>$/);
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(server.find('POST', '/emails')[0]!.headers['idempotency-key']).toBe(`email:${m!.id}`);
    expect(await verifyAction(h.deps, h.tenantId, a!.id)).toMatchObject({ status: 'VERIFIED' });
    const [delivered] = await tx((t) => t.select().from(messages).where(eq(messages.id, m!.id)));
    expect(delivered).toMatchObject({ status: 'delivered', providerMessageId: 'em_1' });

    // The goal event arrives during the wait: the journey exits without the follow-up.
    await ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'integration_connected', timestamp: new Date(h.clock.now().getTime() + 3_600_000).toISOString(), userId }]);
    h.clock.advance(25 * 3_600_000);
    expect((await life.tickJourneys(h.deps, h.tenantId))[0]!.outcome).toBe('goal_reached');
    expect(await tx((t) => t.select().from(messages).where(eq(messages.journeyId, j.id)))).toHaveLength(1);
  });

  it('honours one-click unsubscribe immediately: the next commercial send is denied by policy', async () => {
    const [m] = await tx((t) => t.select().from(messages).where(eq(messages.journeyId, journeyId)));
    const url = sent.at(-1)!.body.headers['List-Unsubscribe'].slice(1, -1) as string;
    const token = url.split('/u/')[1]!;
    expect(await life.processUnsubscribe(h.deps, `${token}x`)).toEqual({ ok: false });
    expect(await life.processUnsubscribe(h.deps, token)).toEqual({ ok: true });
    expect(await life.processUnsubscribe(h.deps, token)).toEqual({ ok: true }); // idempotent
    const [c] = await tx((t) =>
      t
        .select()
        .from(consentState)
        .where(and(eq(consentState.profileId, m!.profileId), eq(consentState.purpose, 'marketing_email'))),
    );
    expect(c!.status).toBe('withdrawn');
    const again = await life.sendOneOff(h.deps, h.tenantId, h.users.operator, { profileId: m!.profileId, templateId: followId, connectionId: resendConn });
    expect(again.status).toBe('DENIED');
    const [row] = await tx((t) => t.select().from(messages).where(eq(messages.id, again.messageId)));
    expect(row!.status).toBe('suppressed');
  });

  it('applies Resend bounce webhooks: message bounced, address suppressed', async () => {
    const { profileId } = await profile('bouncy@example.com');
    mountResend();
    const r = await life.sendOneOff(h.deps, h.tenantId, h.users.operator, { profileId, templateId: welcomeId, connectionId: resendConn, evidenceIds: [(await evidence('document')).evidenceId] });
    expect(r.status).toBe('APPROVED'); // human proposal with evidence, pre-authorized for an audience of 1
    await executeAction(h.deps, h.tenantId, r.actionId);
    const emailId = `em_${emailCount}`;
    const payload = { type: 'email.bounced', created_at: h.clock.now().toISOString(), data: { email_id: emailId, bounce: { type: 'Permanent' } } };
    const raw = JSON.stringify(payload);
    const inbox = await ingestWebhook(h.t.handle.db, { provider: 'resend', providerEventId: `svix_${randomUUID()}`, topic: payload.type, signatureValid: true, headers: {}, rawBody: raw, payload, accountRef: null });
    expect(await processWebhook(h.deps, inbox.id)).toBe('processed');
    const [msg] = await tx((t) => t.select().from(messages).where(eq(messages.id, r.messageId)));
    expect(msg!.status).toBe('bounced');
    const sup = await tx((t) =>
      t
        .select()
        .from(suppressions)
        .where(eq(suppressions.identifierHash, identifierHash(h.deps.config.identifierPepper, 'email', 'bouncy@example.com'))),
    );
    expect(sup[0]!.reason).toBe('bounce');
  });

  it('denies sends without consent and blocks journeys that are paused', async () => {
    const { profileId } = await profile('noconsent@example.com', { consent: false });
    const r = await life.sendOneOff(h.deps, h.tenantId, h.users.operator, { profileId, templateId: welcomeId, connectionId: resendConn });
    expect(r.status).toBe('DENIED');
    const [a] = await tx((t) => t.select().from(actionRequests).where(eq(actionRequests.id, r.actionId)));
    expect(a!.statusReason).toMatch(/NO_MARKETING_CONSENT/);
    await tx((t) => life.pauseJourney(t, h.tenantId, h.users.approver, journeyId, 'copy review'));
    const { userId } = await profile('later@example.com');
    await ingestEvents(h.deps, h.tenantId, 'test', [{ messageId: `m-${randomUUID()}`, event: 'signup', timestamp: h.clock.now().toISOString(), userId }]);
    expect(await life.enrollFromEvents(h.deps, h.tenantId)).toEqual({ enrolled: 0 });
    const stats = await tx((t) => life.journeyStats(t, journeyId));
    expect(stats.enrollments).toEqual([{ state: 'completed', n: 1 }]);
    expect(await tx((t) => t.select().from(journeyEnrollments).where(eq(journeyEnrollments.state, 'active')))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */

describe('M21 conversational support', () => {
  const ORIGIN = 'https://shop.acme.test';
  let key: string;
  let chunkIds: string[] = [];

  beforeAll(async () => {
    await expect(tx((t) => conv.createWidget(t, h.tenantId, h.users.admin, { allowedOrigins: [ORIGIN], disclosureText: 'Chat with our helpful team member' }))).rejects.toThrow(/AI/);
    const w = await tx((t) => conv.createWidget(t, h.tenantId, h.users.admin, { allowedOrigins: [ORIGIN] }));
    key = w.publicKey;
    const ev = await evidence('document', { title: 'help' });
    await tx((t) => ingestDocument(t, h.deps, h.tenantId, h.users.owner, { title: 'Importing data', text: 'You can import contacts from a CSV file. Open Settings, choose Import, and upload the file. Imports up to 50,000 rows are supported.', evidenceId: ev.evidenceId, visibility: 'public' }));
    await tx((t) => ingestDocument(t, h.deps, h.tenantId, h.users.owner, { title: 'Internal pricing notes', text: 'Sales may offer a discount to enterprise prospects importing contacts.', evidenceId: ev.evidenceId, visibility: 'internal' }));
  });

  const ask = async (text: string) => {
    const s = await conv.startConversation(h.deps, key, ORIGIN);
    const reply = await conv.postCustomerMessage(h.deps, { publicKey: key, origin: ORIGIN, conversationId: s.conversationId, visitorToken: s.visitorToken, text });
    return { s, reply };
  };

  it('requires an allow-listed origin and the visitor token', async () => {
    await expect(conv.startConversation(h.deps, key, 'https://evil.test')).rejects.toThrow(/origin/);
    const s = await conv.startConversation(h.deps, key, ORIGIN);
    expect(s.disclosure).toMatch(/AI assistant/);
    await expect(conv.postCustomerMessage(h.deps, { publicKey: key, origin: ORIGIN, conversationId: s.conversationId, visitorToken: 'wrong-token-value-123', text: 'hi' })).rejects.toThrow(/not found/);
  });

  it('answers from public knowledge only, with resolvable citations and redacted PII', async () => {
    provider.responders.set(PROMPTS.supportAnswer.system, (req) => {
      const content = req.messages[0]!.content;
      chunkIds = [...content.matchAll(/\[([0-9a-f-]{36})\]/g)].map((m) => m[1]!);
      return { answer: 'Yes. Open Settings, choose Import, and upload your CSV file.', citedChunkIds: chunkIds.slice(0, 1), confidence: 0.9, handoff: false, handoffReason: '', lead: { interestedInPurchase: true, useCase: 'CRM migration', companySize: '50', askedAboutPricing: false } };
    });
    const { s, reply } = await ask('Can I import a CSV of contacts? My email is pat@corp.example');
    expect(reply).toMatchObject({ role: 'assistant', handoff: false });
    expect(reply.citations).toHaveLength(1);
    expect(reply.citations[0]!.title).toBe('Importing data');
    const sentToModel = provider.requests[0]!.messages[0]!.content;
    expect(sentToModel).not.toContain('pat@corp.example');
    expect(sentToModel).toContain('[email]');
    expect(sentToModel).not.toContain('Internal pricing notes');
    const msgs = await tx((t) => t.select().from(conversationMessages).where(eq(conversationMessages.conversationId, s.conversationId)));
    expect(msgs.find((m) => m.role === 'customer')!.redactedText).toContain('[email]');
    expect(msgs.find((m) => m.role === 'assistant')!.modelInfo).toMatchObject({ servedBy: 'claude-opus-5-5' });
    const [lead] = await tx((t) => t.select().from(leads).where(eq(leads.conversationId, s.conversationId)));
    expect(lead!.score).toBeCloseTo(0.8);
  });

  it('hands off when the answer cites nothing real, makes an unsupported commitment, or the model is unavailable', async () => {
    provider.responders.set(PROMPTS.supportAnswer.system, () => ({ answer: 'Upload the CSV under Settings.', citedChunkIds: ['00000000-0000-4000-8000-000000000000'], confidence: 0.9, handoff: false, handoffReason: '', lead: { interestedInPurchase: false, useCase: '', companySize: '', askedAboutPricing: false } }));
    const bad = await ask('How do I import contacts from a CSV?');
    expect(bad.reply).toMatchObject({ role: 'system', handoff: true });
    const [t1] = await tx((t) => t.select().from(supportTickets).where(eq(supportTickets.conversationId, bad.s.conversationId)));
    expect(t1).toBeDefined();
    const [c1] = await tx((t) => t.select().from(conversations).where(eq(conversations.id, bad.s.conversationId)));
    expect(c1!.status).toBe('handoff');

    provider.responders.set(PROMPTS.supportAnswer.system, (req) => {
      const ids = [...req.messages[0]!.content.matchAll(/\[([0-9a-f-]{36})\]/g)].map((m) => m[1]!);
      return { answer: 'You can import contacts, and I can offer a refund if it fails.', citedChunkIds: ids.slice(0, 1), confidence: 0.95, handoff: false, handoffReason: '', lead: { interestedInPurchase: false, useCase: '', companySize: '', askedAboutPricing: false } };
    });
    const promise = await ask('Can I import contacts from a CSV file?');
    expect(promise.reply.handoff).toBe(true);
    const [sys] = await tx((t) =>
      t
        .select()
        .from(conversationMessages)
        .where(and(eq(conversationMessages.conversationId, promise.s.conversationId), eq(conversationMessages.role, 'system')))
        .orderBy(conversationMessages.createdAt)
        .offset(1),
    );
    expect(sys!.handoffReason).toMatch(/commitment/);

    const noKnowledge = await ask('What is the weather on Mars?');
    expect(noKnowledge.reply.handoff).toBe(true);

    const models = h.deps.models;
    h.deps.models = undefined;
    const down = await ask('How do I import contacts from a CSV?');
    h.deps.models = models;
    expect(down.reply.handoff).toBe(true);
    // Once handed off, the AI stays out of the conversation.
    const after = await conv.postCustomerMessage(h.deps, { publicKey: key, origin: ORIGIN, conversationId: down.s.conversationId, visitorToken: down.s.visitorToken, text: 'hello?' });
    expect(after).toMatchObject({ role: 'system', handoff: true });
    await tx((t) => conv.humanReply(t, h.tenantId, h.users.operator, down.s.conversationId, 'Hi, this is Sam from Acme. Happy to help.'));
    const visible = await conv.visitorMessages(h.deps, { publicKey: key, origin: ORIGIN, conversationId: down.s.conversationId, visitorToken: down.s.visitorToken });
    expect(visible.messages.at(-1)).toMatchObject({ role: 'human_agent' });
  });

  it('validates answers deterministically', () => {
    const chunks = [{ chunkId: 'a', documentId: 'd', title: 't', text: 'Refunds are available within 30 days.', evidenceId: 'e', score: 1, ftsRank: 1, vectorRank: null }];
    const base = { answer: 'Refunds are available within 30 days.', citedChunkIds: ['a'], confidence: 0.8, handoff: false, handoffReason: '', lead: { interestedInPurchase: false, useCase: '', companySize: '', askedAboutPricing: false } };
    expect(conv.validateAnswer(base, chunks, true).usable).toBe(true);
    expect(conv.validateAnswer({ ...base, confidence: 0.3 }, chunks, true).usable).toBe(false);
    expect(conv.validateAnswer({ ...base, answer: "I'm a real person, refunds are available." }, chunks, true).reasons.join()).toMatch(/human/);
    expect(conv.validateAnswer(base, chunks, false).usable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe('M22 creators, affiliates and referrals', () => {
  let creatorId: string;
  let contractId: string;
  let code: string;

  it('requires evidence-backed contracts with disclosure and rejects sentiment-conditioned terms', async () => {
    await expect(tx((t) => cre.createCreator(t, h.tenantId, h.users.operator, { name: 'Riley', contactEmail: 'riley@creator.example' }))).rejects.toThrow(/consent/);
    const consentEv = await evidence('consent', { creator: 'riley' });
    const c = await tx((t) => cre.createCreator(t, h.tenantId, h.users.operator, { name: 'Riley', handles: { instagram: '@riley' }, contactEmail: 'riley@creator.example', contactConsentEvidenceId: consentEv.evidenceId }));
    creatorId = c.id;
    const contractEv = await evidence('contract', { signed: true });
    const base = { creatorId, materialRelationship: 'affiliate_commission', commissionFraction: 0.1, currency: 'usd', requiredDisclosures: ['#ad'], startsAt: new Date(h.clock.now().getTime() - 86_400_000).toISOString(), signedEvidenceId: contractEv.evidenceId };
    await expect(tx((t) => cre.createContract(t, h.tenantId, h.users.admin, { ...base, terms: 'Bonus paid only for 5-star reviews.' }))).rejects.toThrow(/sentiment/);
    await expect(tx((t) => cre.createContract(t, h.tenantId, h.users.admin, { ...base, requiredDisclosures: [] }))).rejects.toThrow();
    await expect(tx((t) => cre.createContract(t, h.tenantId, h.users.admin, { ...base, signedEvidenceId: consentEv.evidenceId }))).rejects.toThrow(/contract/);
    const k = await tx((t) => cre.createContract(t, h.tenantId, h.users.admin, base));
    contractId = k.id;
    expect(k.currency).toBe('USD');
    await expect(tx((t) => cre.createReferralLink(t, h.tenantId, h.users.operator, { creatorId, contractId, destinationUrl: 'http://shop.acme.test' }))).rejects.toThrow(/https/);
    const link = await tx((t) => cre.createReferralLink(t, h.tenantId, h.users.operator, { creatorId, contractId, destinationUrl: 'https://shop.acme.test/products/sync?x=1' }));
    code = link.code;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
  });

  it('tracks clicks with hashed identifiers and flags click velocity', async () => {
    const dest = await cre.trackClick(h.deps, code, { ip: '203.0.113.9', userAgent: 'Mozilla/5.0' });
    expect(dest).toBe(`https://shop.acme.test/products/sync?x=1&fg_ref=${code}`);
    expect(await cre.trackClick(h.deps, 'NOPE1234', { ip: '1.1.1.1', userAgent: 'x' })).toBeNull();
    const clicks = await tx((t) => t.select().from(referralClicks));
    expect(JSON.stringify(clicks)).not.toContain('203.0.113.9');
    // One more than the hourly threshold from the same address.
    for (let i = 0; i <= cre.CLICK_VELOCITY_PER_HOUR; i++) await cre.trackClick(h.deps, code, { ip: '198.51.100.1', userAgent: 'bot' });
    const flags = await tx((t) => t.select().from(fraudFlags).where(eq(fraudFlags.kind, 'click_velocity')));
    expect(flags).toHaveLength(1);
  });

  it('attributes Shopify orders, accrues commission, claws back refunds proportionally, and flags self-referral', async () => {
    const order = { id: 9001, email: 'buyer@example.com', created_at: h.clock.now().toISOString(), currency: 'USD', subtotal_price: '200.00', note_attributes: [{ name: 'fg_ref', value: code }] };
    const deliver = async (topic: string, payload: unknown) => {
      const raw = JSON.stringify(payload);
      await createConnectionOnce();
      const r = await ingestWebhook(h.t.handle.db, { provider: 'shopify', providerEventId: `wh_${randomUUID()}`, topic, signatureValid: true, headers: {}, rawBody: raw, payload, accountRef: 'acme.myshopify.com' });
      return processWebhook(h.deps, r.id);
    };
    expect(await deliver('orders/create', order)).toBe('processed');
    expect(await deliver('orders/create', order)).toBe('ignored'); // duplicate order id
    const [conv1] = await tx((t) => t.select().from(referralConversions).where(eq(referralConversions.orderRef, 'shopify:9001')));
    expect(conv1).toMatchObject({ amountMicros: 200_000_000, currency: 'USD' });
    let ledger = await tx((t) => t.select().from(commissionLedger));
    expect(ledger).toEqual([expect.objectContaining({ kind: 'accrual', amountMicros: 20_000_000 })]);

    expect(await deliver('refunds/create', { id: 77, order_id: 9001, created_at: h.clock.now().toISOString(), transactions: [{ kind: 'refund', status: 'success', amount: '50.00' }] })).toBe('processed');
    ledger = await tx((t) => t.select().from(commissionLedger).where(eq(commissionLedger.kind, 'clawback')));
    expect(ledger[0]!.amountMicros).toBe(-5_000_000);
    const [conv2] = await tx((t) => t.select().from(referralConversions).where(eq(referralConversions.orderRef, 'shopify:9001')));
    expect(conv2).toMatchObject({ refundedMicros: 50_000_000, status: 'partially_refunded' });
    // Ledger is append-only.
    await expect(tx((t) => t.update(commissionLedger).set({ amountMicros: 0 }).where(eq(commissionLedger.creatorId, creatorId)))).rejects.toThrow();

    expect(await deliver('orders/create', { ...order, id: 9002, email: 'RILEY@creator.example' })).toBe('processed');
    expect(await tx((t) => t.select().from(fraudFlags).where(eq(fraudFlags.kind, 'self_referral')))).toHaveLength(1);
    expect(await tx((t) => t.select().from(commissionLedger).where(eq(commissionLedger.kind, 'accrual')))).toHaveLength(1);
  });

  it('makes commission payable only after the refund window; payouts stay blocked (B-015)', async () => {
    const now = h.clock.now();
    const early = await tx((t) => cre.creatorBalance(t, creatorId, now));
    expect(early[0]).toMatchObject({ accrued: 20_000_000, clawed: -5_000_000, payable: 0 });
    const later = await tx((t) => cre.creatorBalance(t, creatorId, new Date(now.getTime() + 31 * 86_400_000)));
    expect(later[0]!.payable).toBe(15_000_000);
    h.clock.advance(31 * 86_400_000);
    const view = await cre.proposePayout(h.deps, h.tenantId, h.users.finance, creatorId);
    expect(view.status).toBe('DENIED');
    expect(view.statusReason).toMatch(/UNSUPPORTED|B-015|not supported/i);
  });

  it('fails content closed when the disclosure is missing or buried', async () => {
    const missing = await tx((t) => cre.submitContent(t, h.tenantId, h.users.operator, { creatorId, contractId, contentText: 'Loving this sync tool, five stars, I recommend it!' }));
    expect(missing.status).toBe('rejected_missing_disclosure');
    const buried = await tx((t) => cre.submitContent(t, h.tenantId, h.users.operator, { creatorId, contractId, contentText: `${'Here is my honest walkthrough of the import flow. '.repeat(8)} #ad` }));
    expect(buried.status).toBe('rejected_missing_disclosure');
    const ok = await tx((t) => cre.submitContent(t, h.tenantId, h.users.operator, { creatorId, contractId, contentText: '#ad Here is how I import my CSV contacts in one step.' }));
    expect(ok.status).toBe('pending_review');
    await expect(tx((t) => cre.reviewSubmission(t, h.tenantId, h.users.approver, missing.id, 'approved'))).rejects.toThrow();
    expect((await tx((t) => cre.reviewSubmission(t, h.tenantId, h.users.approver, ok.id, 'approved'))).status).toBe('approved');
    expect(await tx((t) => t.select().from(fraudFlags).where(eq(fraudFlags.kind, 'incentivized_review')))).toHaveLength(1);
    expect(await tx((t) => t.select().from(creatorSubmissions))).toHaveLength(3);
  });
});

let shopifyConn: string | null = null;
async function createConnectionOnce() {
  if (shopifyConn) return shopifyConn;
  shopifyConn = (await createConnection(h.deps, h.tenantId, h.users.owner, { provider: 'shopify', externalAccountId: 'acme.myshopify.com', displayName: 'Shop', grantedScopes: ['write_discounts'], credentials: { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' } })).id;
  return shopifyConn;
}
