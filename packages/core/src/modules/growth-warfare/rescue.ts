import { randomBytes } from 'node:crypto';
import { acquisitionTools, claims, type DbOrTx, fraudFlags, growthCampaigns, growthChannelTasks, offers, referralConversions, type Tx } from '@futuregrow/db';
import { conflict, identifierHash, notFound, sha256Hex } from '@futuregrow/observability';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { record, requireRole } from '../../util.js';
import { getBrand } from '../brands/index.js';
import { channelReadiness } from './channels.js';
import { type BrandConfig, getBrandConfig, requireFeature, requireOperator } from './settings.js';

/**
 * F5 Conversion Rescue & Viral Growth Loops (D-054). Funnels are computed from first-party M02
 * events only, per brand-defined stage. Recovery is consent-aware: only people with a current
 * marketing_email consent who are not suppressed are counted as contactable, and contacting them
 * still goes through M20 templates/journeys (frequency limits, unsubscribe) and M23. Referral
 * loops use M22 records; rewards are checked for eligibility, never paid from here.
 */
const DAY = 86_400_000;
export const MIN_STEP_SAMPLE = 30;

export interface StageCount {
  key: string;
  label: string;
  events: string[];
  reached: number;
  conversionFromPrevious: number | null;
  interval95: [number, number] | null;
  sufficient: boolean;
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, Math.round((centre - half) * 1000) / 1000), Math.min(1, Math.round((centre + half) * 1000) / 1000)];
}

/** Ordered funnel over unit first-event times (pure, for tests). */
export function computeFunnel(stages: BrandConfig['funnel'], firstTimes: Map<string, Map<string, number>>, stallMs: number, now: number) {
  const reachedAt = new Map<string, number[]>(); // unit -> time per stage (NaN = not reached)
  for (const [unit, events] of firstTimes) {
    const times: number[] = [];
    let prev = Number.NEGATIVE_INFINITY;
    for (const st of stages) {
      const t = Math.min(...st.events.map((e) => events.get(e) ?? Number.POSITIVE_INFINITY));
      if (!Number.isFinite(t) || t < prev || Number.isNaN(prev)) {
        times.push(Number.NaN);
        prev = Number.NaN;
      } else {
        times.push(t);
        prev = t;
      }
    }
    if (!Number.isNaN(times[0]!)) reachedAt.set(unit, times);
  }
  const counts: StageCount[] = stages.map((st, i) => {
    const reached = [...reachedAt.values()].filter((ts) => !Number.isNaN(ts[i]!)).length;
    const before = i === 0 ? null : [...reachedAt.values()].filter((ts) => !Number.isNaN(ts[i - 1]!)).length;
    return { key: st.key, label: st.label, events: st.events, reached, conversionFromPrevious: before ? Math.round((reached / before) * 1000) / 1000 : null, interval95: before ? wilson(reached, before) : null, sufficient: before === null ? reached >= MIN_STEP_SAMPLE : before >= MIN_STEP_SAMPLE };
  });
  const steps = counts.slice(1).map((c, i) => ({ from: counts[i]!.key, to: c.key, index: i + 1, rate: c.conversionFromPrevious, sufficient: c.sufficient, lost: counts[i]!.reached - c.reached }));
  const candidates = steps.filter((s) => s.sufficient && s.rate !== null);
  const bottleneck = candidates.sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1) || b.lost - a.lost)[0] ?? null;
  const stalled = bottleneck ? [...reachedAt.entries()].filter(([, ts]) => !Number.isNaN(ts[bottleneck.index - 1]!) && Number.isNaN(ts[bottleneck.index]!) && now - ts[bottleneck.index - 1]! >= stallMs).map(([u]) => u) : [];
  return { counts, steps, bottleneck, stalled };
}

export async function diagnoseFunnel(t: DbOrTx, brandId: string, opts: { windowDays?: number; stallDays?: number; now: Date }) {
  const { config } = await getBrandConfig(t, brandId);
  const windowDays = opts.windowDays ?? 30;
  const stallDays = opts.stallDays ?? 3;
  if (config.funnel.length < 2) return { status: 'not_configured' as const, note: 'Define at least two funnel stages (event names) in the brand growth profile.', counts: [], steps: [], bottleneck: null, abandoned: null };
  const events = [...new Set(config.funnel.flatMap((s) => s.events))];
  const since = new Date(opts.now.getTime() - windowDays * DAY);
  const rows = (
    await t.execute<{ unit: string; profile_id: string | null; event_name: string; first: string }>(sql`
      select coalesce(profile_id::text, anonymous_id) as unit, max(profile_id::text) as profile_id, event_name, min(occurred_at) as first
      from customer_events
      where event_name in (${sql.join(
        events.map((e) => sql`${e}`),
        sql`, `,
      )}) and occurred_at >= ${since} and coalesce(profile_id::text, anonymous_id) is not null
      group by 1, 3 limit 200000`)
  ).rows;
  const first = new Map<string, Map<string, number>>();
  const profileOf = new Map<string, string>();
  for (const r of rows) {
    const m = first.get(r.unit) ?? new Map<string, number>();
    m.set(r.event_name, new Date(r.first).getTime());
    first.set(r.unit, m);
    if (r.profile_id) profileOf.set(r.unit, r.profile_id);
  }
  const f = computeFunnel(config.funnel, first, stallDays * DAY, opts.now.getTime());
  let abandoned: { stalled: number; contactable: number; withProfile: number; stallDays: number } | null = null;
  if (f.bottleneck) {
    const profiles = f.stalled.map((u) => profileOf.get(u)).filter((x): x is string => Boolean(x));
    let contactable = 0;
    if (profiles.length) {
      const r = await t.execute<{ n: number }>(sql`
        select count(*)::int as n from customer_profiles p
        where p.id in (${sql.join(
          profiles.map((x) => sql`${x}::uuid`),
          sql`, `,
        )}) and p.deleted_at is null
          and exists (select 1 from consent_state c where c.profile_id = p.id and c.purpose = 'marketing_email' and c.status = 'granted' and (c.expires_at is null or c.expires_at > now()))
          and not exists (select 1 from identity_identifiers ii join suppressions s on s.identifier_hash = ii.value_hash and s.channel in ('email', 'all') where ii.profile_id = p.id and ii.kind = 'email')`);
      contactable = r.rows[0]?.n ?? 0;
    }
    abandoned = { stalled: f.stalled.length, withProfile: profiles.length, contactable, stallDays };
  }
  return {
    status: f.bottleneck ? ('diagnosed' as const) : rows.length ? ('insufficient_data' as const) : ('no_events' as const),
    windowDays,
    counts: f.counts,
    steps: f.steps,
    bottleneck: f.bottleneck,
    abandoned,
    note: f.bottleneck
      ? `Lowest step conversion with at least ${MIN_STEP_SAMPLE} people entering it. Observational: it shows where people stop, not why.`
      : rows.length
        ? `No step has ${MIN_STEP_SAMPLE}+ people entering it in ${windowDays} days yet; no bottleneck is claimed.`
        : `No first-party events for these stages in ${windowDays} days. Send them with the M02 events API or SDK.`,
  };
}

/** Consent-aware recovery options for the diagnosed bottleneck. Nothing here contacts anyone. */
export async function recoveryPlan(t: DbOrTx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, brandId: string, diag: Awaited<ReturnType<typeof diagnoseFunnel>>) {
  if (!diag.bottleneck) return { actions: [], note: diag.note };
  const { getSettings } = await import('./settings.js');
  const s = await getSettings(t, tenantId);
  const readiness = await channelReadiness(t, deps, brandId, s);
  const email = readiness.find((r) => r.channel === 'email');
  const tools = await t.select({ id: acquisitionTools.id, title: acquisitionTools.title, template: acquisitionTools.template, status: acquisitionTools.status }).from(acquisitionTools).where(eq(acquisitionTools.brandId, brandId));
  const from = diag.counts.find((c) => c.key === diag.bottleneck!.from)!;
  const to = diag.counts.find((c) => c.key === diag.bottleneck!.to)!;
  const actions = [
    {
      kind: 'email_journey',
      available: Boolean(email?.available) && (diag.abandoned?.contactable ?? 0) > 0,
      why: email?.available ? `${diag.abandoned?.contactable ?? 0} of ${diag.abandoned?.stalled ?? 0} stalled people have current e-mail consent and are not suppressed.` : (email?.reason ?? 'e-mail is not connected'),
      journey: { trigger: from.events, exitOn: to.events, delayHours: 24, maxMessagesPer7Days: 2, audience: 'marketing_email consent granted, not suppressed, reached the from-stage but not the next stage', path: 'M20 template (approved) → journey (activated by a person) → M23 email.send per message' },
    },
    {
      kind: 'personalized_onboarding',
      available: true,
      why: `Make the step from “${from.label}” to “${to.label}” easier in the product; suggest the next best action in-app.`,
      nextBestAction: tools.find((x) => x.status === 'published') ? { tool: tools.find((x) => x.status === 'published')!.title } : { tool: null, hint: 'An acquisition tool (F4) can be the next step for people who stall here.' },
    },
    { kind: 'friction_experiment', available: true, why: 'Test one change at this step against the current flow (F6) so the effect can be measured, not assumed.', area: 'onboarding', kpi: to.events[0] },
  ];
  return { actions, note: 'Suppressions, consent expiry and frequency limits are enforced again by M20/M23 at send time.' };
}

/** Prepare (once per brand and bottleneck) a rescue campaign: package, email task and onboarding task. */
export async function prepareRescue(t: Tx, deps: Pick<CoreDeps, 'clock'>, tenantId: string, actor: Actor, brandId: string) {
  requireOperator(actor, 'preparing conversion rescue campaigns');
  const s = await requireFeature(t, tenantId, 'F5', brandId);
  const now = deps.clock.now();
  const diag = await diagnoseFunnel(t, brandId, { now });
  if (!diag.bottleneck) throw conflict(diag.note);
  const key = `${diag.bottleneck.from}->${diag.bottleneck.to}`;
  const [existing] = await t.execute<{ id: string }>(sql`select id from growth_campaigns where brand_id = ${brandId} and kind = 'rescue' and status in ('draft','ready_for_review','approved','in_flight','blocked') and package->>'bottleneckKey' = ${key} limit 1`).then((r) => r.rows);
  if (existing) {
    const [c] = await t.select().from(growthCampaigns).where(eq(growthCampaigns.id, existing.id));
    return { campaign: c!, created: false };
  }
  const plan = await recoveryPlan(t, deps, tenantId, brandId, diag);
  const b = await getBrand(t, brandId);
  const ids = b.approvedClaims.map((c) => c.id);
  const usable = (
    ids.length
      ? await t
          .select()
          .from(claims)
          .where(and(inArray(claims.id, ids), eq(claims.status, 'approved')))
      : []
  ).filter((c) => !c.expiresAt || c.expiresAt > now);
  const { config } = await getBrandConfig(t, brandId);
  const code = `gw${randomBytes(4).toString('hex')}`;
  const link = config.landingUrl ? `${config.landingUrl}${config.landingUrl.includes('?') ? '&' : '?'}utm_source=futuregrow&utm_medium=email&utm_campaign=${code}` : null;
  const to = diag.counts.find((c) => c.key === diag.bottleneck!.to)!;
  const blockers = [...(usable.length ? [] : ['No approved claim to write the reminder with.'])];
  const [c] = await t
    .insert(growthCampaigns)
    .values({
      tenantId,
      brandId,
      kind: 'rescue',
      title: `Rescue: ${diag.counts.find((x) => x.key === diag.bottleneck!.from)?.label} → ${to.label}`.slice(0, 300),
      status: blockers.length ? 'blocked' : 'ready_for_review',
      package: { schema: 'rescue/1', campaignCode: code, bottleneckKey: key, diagnosis: diag, plan, blockers, generatedAt: now.toISOString() } as unknown as Record<string, unknown>,
      claimIds: usable.slice(0, 2).map((x) => x.id),
      approval: {
        required: [
          { code: 'campaign_review', who: ['owner', 'admin', 'approver'], why: 'A person approves contacting stalled people.' },
          { code: 'template_approval', who: ['M20'], why: 'The e-mail template is approved in Lifecycle before any journey can use it.' },
        ],
        acknowledged: [],
        approvedBy: null,
        approvedAt: null,
      },
      goals: [{ event: to.events[0], metric: `step conversion ${diag.bottleneck.from} → ${diag.bottleneck.to} for people entering after approval`, attribution: 'pre/post observational unless a Darwin experiment holds out a control group', baseline: diag.bottleneck.rate }],
      expiresAt: new Date(now.getTime() + 30 * DAY),
      createdBy: actorRef(actor),
    })
    .returning();
  if (usable.length) {
    const content = {
      name: `gw-${code}-rescue`,
      category: 'commercial',
      subject: usable[0]!.text.slice(0, 120),
      bodyText: `${usable
        .slice(0, 2)
        .map((x) => x.text)
        .join('\n\n')}\n\n${link ?? ''}`.trim(),
      claimIds: usable.slice(0, 2).map((x) => x.id),
      journey: (plan.actions[0] as { journey: unknown }).journey,
    };
    const hash = sha256Hex(JSON.stringify(content));
    await t
      .insert(growthChannelTasks)
      .values({
        tenantId,
        campaignId: c!.id,
        brandId,
        channel: 'email',
        status: plan.actions[0]!.available ? 'planned' : 'blocked',
        statusReason: plan.actions[0]!.available ? null : plan.actions[0]!.why,
        content,
        contentHash: hash,
        dedupKey: `${c!.id}:email:${hash.slice(0, 24)}`,
        rules: { path: 'm23', consent: 'marketing_email', frequency: '≤2 per 7 days' },
      })
      .onConflictDoNothing();
  }
  await record(t, tenantId, actor, 'growth.campaign.prepared', { type: 'growth_campaign', id: c!.id }, { kind: 'rescue', bottleneck: key, contactable: diag.abandoned?.contactable ?? 0, aggression: s.aggression });
  return { campaign: c!, created: true };
}

/* ------------------------------------------------------------------ */
/* Viral & referral loops                                              */
/* ------------------------------------------------------------------ */

/**
 * Brand viral loop from first-party invite events. Each invitee counts once (first sign-up); a
 * sign-up whose inviterId is the invitee's own profile id or own anonymous id (compared as the
 * peppered hash M02 stores) is a self-referral and is excluded.
 */
export async function referralLoop(t: DbOrTx, opts: { windowDays?: number; now: Date; pepper: string }) {
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(opts.now.getTime() - windowDays * DAY);
  const inv = await t.execute<{ inviters: number; invites: number }>(sql`
    select count(distinct coalesce(profile_id::text, anonymous_id))::int as inviters, count(*)::int as invites
    from customer_events where event_name = 'referral_invite_sent' and occurred_at >= ${since}`);
  const rows = (
    await t.execute<{ unit: string; profile_id: string | null; anon: string | null; inviter: string | null; at: string }>(sql`
      select coalesce(profile_id::text, anonymous_id) as unit, profile_id::text as profile_id, anonymous_id as anon, properties->>'inviterId' as inviter, occurred_at as at
      from customer_events where event_name = 'referral_signup' and occurred_at >= ${since} order by occurred_at limit 50000`)
  ).rows;
  const first = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.unit && !first.has(r.unit)) first.set(r.unit, r);
  let converted = 0;
  let self = 0;
  let unattributed = 0;
  for (const r of first.values()) {
    if (!r.inviter) unattributed++;
    else if (r.inviter === r.profile_id || (r.anon && identifierHash(opts.pepper, 'anonymous_id', r.inviter) === r.anon)) self++;
    else converted++;
  }
  const inviters = inv.rows[0]?.inviters ?? 0;
  const invites = inv.rows[0]?.invites ?? 0;
  const sufficient = inviters >= MIN_STEP_SAMPLE && invites >= MIN_STEP_SAMPLE;
  return {
    windowDays,
    inviters,
    invites,
    invitedSignups: converted,
    selfReferralsExcluded: self,
    unattributedSignups: unattributed,
    invitesPerInviter: inviters ? Math.round((invites / inviters) * 100) / 100 : null,
    inviteConversion: invites ? Math.round((converted / invites) * 1000) / 1000 : null,
    kFactor: inviters && invites ? Math.round((invites / inviters) * (converted / invites) * 1000) / 1000 : null,
    sufficient,
    note: sufficient ? 'K-factor = invites per inviter × sign-ups per invite (first sign-up per invitee only). Observational; incremental effect needs a holdout experiment (F6).' : `Fewer than ${MIN_STEP_SAMPLE} inviters or invites in ${windowDays} days; the loop is reported but not interpreted.`,
    events: 'Send referral_invite_sent and referral_signup (properties.inviterId) as first-party events.',
  };
}

/** Whether a referral conversion may earn a reward. Checks only; no payout is created here. */
export async function rewardEligibility(t: DbOrTx, conversionId: string, now: Date, refundWindowDays = 14) {
  const [cv] = await t.select().from(referralConversions).where(eq(referralConversions.id, conversionId));
  if (!cv) throw notFound('referral conversion');
  const flags = await t
    .select()
    .from(fraudFlags)
    .where(and(eq(fraudFlags.linkId, cv.linkId), eq(fraudFlags.status, 'open')));
  const dup = cv.customerHash ? await t.execute<{ n: number }>(sql`select count(distinct link_id)::int as n from referral_conversions where customer_hash = ${cv.customerHash}`) : { rows: [{ n: 1 }] };
  const reasons = [
    ...(cv.status === 'confirmed' ? [] : [`conversion is ${cv.status.replaceAll('_', ' ')}`]),
    ...(now.getTime() - cv.occurredAt.getTime() < refundWindowDays * DAY ? [`inside the ${refundWindowDays}-day refund window`] : []),
    ...flags.map((f) => `open fraud flag: ${f.kind.replaceAll('_', ' ')}`),
    ...((dup.rows[0]?.n ?? 1) > 1 ? ['the same customer converted through more than one link (double count)'] : []),
  ];
  return { conversionId, eligible: reasons.length === 0, reasons, note: 'Eligibility only. Payouts are proposed in Creators › Payouts and approved through M23.' };
}

/** A referral campaign package from a template; rewards are only approved offers. */
export async function prepareReferralCampaign(t: Tx, deps: Pick<CoreDeps, 'clock' | 'config'>, tenantId: string, actor: Actor, brandId: string, template: 'give_get' | 'invite_unlock' | 'creator_code') {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'preparing referral campaigns');
  await requireFeature(t, tenantId, 'F5', brandId);
  const now = deps.clock.now();
  const b = await getBrand(t, brandId);
  const { config } = await getBrandConfig(t, brandId);
  const live = (await t.select().from(offers).where(eq(offers.status, 'approved'))).filter((o) => (!o.endsAt || o.endsAt > now) && (!o.startsAt || o.startsAt <= now));
  const loop = await referralLoop(t, { now, pepper: deps.config.identifierPepper });
  const code = `gw${randomBytes(4).toString('hex')}`;
  const share = b.approvedClaims[0]?.text ?? null;
  const reward = live[0] ? { offerId: live[0].id, name: live[0].name, kind: live[0].kind } : null;
  const [c] = await t
    .insert(growthCampaigns)
    .values({
      tenantId,
      brandId,
      kind: 'referral',
      title: `Referral (${template.replaceAll('_', ' ')}): ${b.brand.name}`,
      status: share ? 'ready_for_review' : 'blocked',
      package: {
        schema: 'referral/1',
        campaignCode: code,
        template,
        shareJourney: { shareText: share, link: config.landingUrl ? `${config.landingUrl}${config.landingUrl.includes('?') ? '&' : '?'}utm_source=referral&utm_medium=share&utm_campaign=${code}` : null, events: ['referral_invite_sent', 'referral_signup'] },
        reward: reward ?? { offerId: null, note: 'No approved offer: the campaign promises no reward. Approve an offer in Offers first to add one.' },
        eligibility: ['verified first-party conversion', `outside the 14-day refund window`, 'no open fraud flag on the link', 'not a self-referral', 'one reward per referred customer'],
        fraudRules: ['click velocity', 'self referral', 'refund rate', 'duplicate customer across links'],
        prohibited: ['rewards for reviews or ratings', 'paying for installs', 'reward claims beyond the approved offer'],
        baseline: loop,
        measurement: { method: 'holdout: half of eligible users see the share prompt (Darwin experiment); incremental sign-ups = treated − holdout', fallback: 'without a holdout, results are observational only' },
        blockers: share ? [] : ['No approved claim to share.'],
      } as unknown as Record<string, unknown>,
      claimIds: b.approvedClaims.slice(0, 1).map((x) => x.id),
      approval: { required: [{ code: 'campaign_review', who: ['owner', 'admin', 'approver'], why: 'A person approves the referral terms.' }], acknowledged: [], approvedBy: null, approvedAt: null },
      goals: [{ event: 'referral_signup', metric: 'invited sign-ups (first per invitee, self-referrals excluded)', attribution: 'observational unless a holdout runs' }],
      expiresAt: new Date(now.getTime() + 60 * DAY),
      createdBy: actorRef(actor),
    })
    .returning();
  await record(t, tenantId, actor, 'growth.campaign.prepared', { type: 'growth_campaign', id: c!.id }, { kind: 'referral', template });
  return c!;
}
