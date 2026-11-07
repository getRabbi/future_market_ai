import { MODULES } from '@futuregrow/contracts';
import { describe, expect, it } from 'vitest';
import { allowedQuickActions, QUICK_ACTIONS } from '../src/components/Shell.js';
import { SECTIONS } from '../src/lib/catalog.js';
import { coverage, dailyFromPoints, dayRange, fillDays, formatCompact, labelIndices, niceTicks, pctChange, segments } from '../src/lib/chart.js';
import { type AuditRow, actionName, activityFromAudit, blockers, describeAudit, type GoalLite, glance, type NextActionInput, nextBestAction, notifications, verifiedTitle } from '../src/lib/dashboard.js';
import { TASKS } from '../src/lib/journey.js';
import { breadcrumbs, GROUPS, legacyRedirect, PAGES, pageBySlug, pagesIn } from '../src/lib/nav.js';
import { approvalItems, rank, score, staticItems } from '../src/lib/search.js';

const me = { userId: 'u1', roles: ['owner'] };

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

describe('unified navigation', () => {
  it('places every catalog section and all 24 modules in exactly one group', () => {
    const slugs = PAGES.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(SECTIONS.map((s) => s.slug).filter((s) => !slugs.includes(s))).toEqual([]);
    const modules = new Set(PAGES.flatMap((p) => p.modules));
    expect(MODULES.map((m) => m.id).filter((id) => !modules.has(id))).toEqual([]);
    for (const p of PAGES) expect(GROUPS.map((g) => g.key)).toContain(p.group);
  });

  it('follows the approved information architecture', () => {
    expect(GROUPS.map((g) => g.title)).toEqual(['Home', 'Journey', 'Goals', 'Content', 'Channels', 'Apps & Intelligence', 'Results', 'Reviews', 'Settings']);
    const primary = (k: Parameters<typeof pagesIn>[0]) =>
      pagesIn(k)
        .filter((p) => p.primary)
        .map((p) => p.title);
    expect(primary('journey')).toEqual(['Growth Journey', 'Onboarding & Setup']);
    expect(primary('goals')).toEqual(['Goals & OKRs', 'Autopilot (Growth Engine)']);
    expect(primary('content')).toEqual(['Content Studio', 'Content Calendar']);
    expect(primary('intelligence')).toEqual(['Apps & Store Reports', 'Growth Brain', 'Market & Competitors', 'Forecasts & Analytics']);
    expect(primary('reviews')).toContain('Approvals');
    expect(primary('settings')).toEqual(['Organization & Team', 'Governance & Security']);
    // Catalog titles match the navigation, so the page heading is the link people clicked.
    for (const s of SECTIONS) expect(pageBySlug(s.slug)?.title, s.slug).toBe(s.title);
  });

  it('builds breadcrumbs and keeps old Autopilot and Advanced links working', () => {
    expect(breadcrumbs('brain').map((c) => c.title)).toEqual(['Home', 'Apps & Intelligence', 'Growth Brain']);
    expect(breadcrumbs('').map((c) => c.title)).toEqual(['Home']);
    expect(legacyRedirect('/app/', '?view=goals')).toBe('/app/goals');
    expect(legacyRedirect('/app/', '?view=brands')).toBe('/app/channels');
    expect(legacyRedirect('/app/', '?view=activity')).toBe('/app/autopilot');
    expect(legacyRedirect('/app/advanced', '')).toBe('/app/tools');
    expect(legacyRedirect('/app/', '')).toBeNull();
    expect(legacyRedirect('/app/goals', '?view=goals')).toBeNull();
  });

  it('offers quick actions only to roles that can do them', () => {
    const viewer = allowedQuickActions({ ...me, roles: ['approver'] } as never).map((q) => q.label);
    expect(viewer).not.toContain('New growth goal');
    expect(viewer).not.toContain('Connect an account');
    expect(viewer).toContain('Review approvals');
    expect(allowedQuickActions({ ...me, roles: ['owner'] } as never)).toHaveLength(QUICK_ACTIONS.length);
  });
});

/* ------------------------------------------------------------------ */
/* Home: at a glance, next best action, blockers, activity             */
/* ------------------------------------------------------------------ */

const goal = (over: Partial<GoalLite> = {}): GoalLite => ({ id: 'g1', title: 'Grow installs', status: 'active', statusReason: null, nextRunAt: null, kpi: { label: 'Installs', metricKey: 'play.daily_user_installs' }, memory: {}, latestCycle: null, ...over });

const base = (over: Partial<NextActionInput> = {}): NextActionInput => ({
  stopped: null,
  killSwitches: [],
  escalated: [],
  approvals: [],
  inbox: { approvals: [], decisions: [], drafts: [], postDrafts: [] },
  incidents: [],
  goals: [],
  journeyNext: null,
  journeyLoaded: true,
  userId: 'u1',
  pageTitle: (s) => s,
  ...over,
});

describe('home dashboard logic', () => {
  it('separates "not measured yet" from real problems', () => {
    const g = glance([
      goal({ id: 'a' }),
      goal({ id: 'b', latestCycle: { id: 'c', seq: 6, status: 'completed', summary: null, finishedAt: null, startedAt: '2026-11-06T00:00:00Z', unavailable: [{ taskId: 't', kind: 'forecast', title: 'Forecast', detail: 'no data' }] } }),
      goal({ id: 'c', latestCycle: { id: 'd', seq: 2, status: 'blocked', summary: null, finishedAt: null, startedAt: '2026-11-06T00:00:00Z' } }),
      goal({ id: 'p', status: 'paused' }),
    ]);
    // A completed cycle whose forecast had no data is on track, not a problem.
    expect(g).toEqual({ active: 3, paused: 1, onTrack: 2, attention: 1, notMeasured: 3 });
    expect(glance(null)).toBeNull();
  });

  it('waits for every input before deciding (no premature "on track")', () => {
    expect(nextBestAction(base({ approvals: null }))).toBeNull();
    expect(nextBestAction(base({ goals: null }))).toBeNull();
    expect(nextBestAction(base({ journeyLoaded: false }))).toBeNull();
    expect(nextBestAction(base())?.tone).toBe('calm');
    expect(nextBestAction(base())?.title).toBe("You're on track");
  });

  it('picks the most important real action and links the exact item', () => {
    const appr = { id: 'a-old', actionType: 'social.facebook.publish_post', status: 'APPROVAL_REQUIRED', statusReason: null, createdAt: '2026-11-05T10:00:00Z', params: { scheduledAt: '2026-11-07T13:00:00Z' } };
    const newer = { ...appr, id: 'a-new', createdAt: '2026-11-06T10:00:00Z' };
    const a = nextBestAction(base({ approvals: [newer, appr] }))!;
    expect(a.tone).toBe('action');
    expect(a.title).toBe('Review a Facebook post');
    expect(a.primary).toEqual({ label: 'Review & approve (2)', href: '/app/approvals?id=a-old' });
    // No approval button when nothing waits; setup comes next.
    const s = nextBestAction(base({ journeyNext: TASKS[0]! }))!;
    expect(s.tone).toBe('setup');
    expect(s.primary.href).toBe('/app/settings');
    // Escalations and emergency stops outrank approvals.
    const esc = nextBestAction(base({ approvals: [appr], escalated: [{ ...appr, id: 'e1', status: 'ESCALATED' }] }))!;
    expect(esc.tone).toBe('critical');
    expect(esc.primary.href).toBe('/app/approvals?id=e1');
    expect(nextBestAction(base({ stopped: 'Kill switch engaged', approvals: [appr] }))!.primary.href).toBe('/app/governance');
    // A blocked goal is the next thing when nothing waits for approval.
    const blocked = nextBestAction(base({ goals: [goal({ latestCycle: { id: 'c', seq: 3, status: 'blocked', summary: null, finishedAt: null, startedAt: '2026-11-06T00:00:00Z', attention: [{ taskId: 't', kind: 'observe', title: 'Connect App Store Connect', detail: null }] } })] }))!;
    expect(blocked.primary.href).toBe('/app/goals?id=g1');
  });

  it('grades blockers: optional provider limits are never critical', () => {
    const list = blockers({
      killSwitches: [{ id: 'k', scope: 'connector', targetRef: 'meta', engaged: true, reason: 'drill' }],
      incidents: [],
      goals: [],
      storeAccounts: [{ id: 's', displayName: 'Play', status: 'active', health: 'ok', consecutiveFailures: 0, warnings: [{ code: 'PLAY_REPORTING_API_SERVICE_DISABLED', title: 'Optional Google Play Developer Reporting API: not enabled', detail: 'Enable it', action: 'Enable' }] }],
      connections: [],
      policyConfigured: true,
      userId: 'u1',
    })!;
    expect(list.map((b) => b.level)).toEqual(['critical', 'optional']);
    expect(list[1]!.title).toBe('Google Play Developer Reporting API: not enabled');
    expect(list[1]!.impact).toMatch(/not affected/);
    expect(blockers({ killSwitches: null, incidents: [], goals: [], storeAccounts: [], connections: [], policyConfigured: true, userId: 'u1' })).toBeNull();
  });

  it('writes audit records as sentences and drops internal steps', () => {
    const row = (action: string, payload: Record<string, unknown> = {}, subject_type = 'action'): AuditRow => ({ seq: 1, occurred_at: '2026-11-06T13:00:00Z', actor_type: 'system', actor_id: 'system:autopilot', action, subject_type, subject_id: '5f1d3c2e-0000-4000-8000-000000000001', payload });
    expect(describeAudit(row('action.preflight.evaluated'), 'u1')).toBeNull();
    const v = describeAudit(row('action.request.transitioned', { to: 'VERIFIED' }), 'u1')!;
    expect(v).toMatchObject({ title: 'Action verified', status: { label: 'Verified', tone: 'ok' }, actor: 'The Autopilot', href: '/app/approvals?id=5f1d3c2e-0000-4000-8000-000000000001' });
    expect(describeAudit(row('studio.post.superseded', {}, 'social_post'), 'u1')!.title).toBe('Studio draft closed (superseded)');
    expect(describeAudit({ ...row('auth.password_changed'), actor_type: 'user', actor_id: 'u1' }, 'u1')!.actor).toBe('You');
    // No raw ids in the sentence.
    const items = activityFromAudit([row('creator.contract.signed')], 'u1')!;
    expect(items[0]!.title).toBe('Creator contract signed');
    expect(JSON.stringify(items.map((i) => [i.title, i.detail]))).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('names actions and notifications in plain language', () => {
    expect(actionName('social.facebook.publish_post')).toBe('Facebook post');
    expect(verifiedTitle('social.facebook.publish_post')).toBe('Facebook post published and verified');
    expect(verifiedTitle('ads.meta.update_campaign_budget')).toBe('Meta Ads budget change verified');
    const n = notifications({
      approvals: [{ id: 'a', actionType: 'email.send', status: 'APPROVAL_REQUIRED', statusReason: null, createdAt: '2026-11-06T00:00:00Z' }],
      escalated: [],
      inbox: null,
      incidents: [{ id: 'i', severity: 'sev1', title: 'Spend spike', status: 'open', openedAt: '2026-11-05T00:00:00Z' }],
      alerts: [],
      userId: 'u1',
    });
    expect(n.map((x) => x.href)).toEqual(['/app/incidents', '/app/approvals?id=a']);
    expect(n[1]!.title).toBe('Email send needs your approval');
  });
});

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */

describe('chart honesty rules', () => {
  it('keeps unknown days as gaps, never zero', () => {
    const pts = fillDays(
      '2026-11-01',
      '2026-11-04',
      new Map([
        ['2026-11-01', 5],
        ['2026-11-03', 0],
      ]),
    );
    expect(pts.map((p) => p.value)).toEqual([5, null, 0, null]);
    expect(segments(pts.map((p) => p.value))).toEqual([[0], [2]]);
    expect(dayRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('states a total only when every day is reported, and a change only against a known previous period', () => {
    expect(coverage(fillDays('2026-11-01', '2026-11-03', new Map([['2026-11-01', 4]])))).toMatchObject({ total: null, daysWithData: 1, expectedDays: 3, complete: false, through: '2026-11-01' });
    expect(
      coverage([
        { x: 'a', value: 1 },
        { x: 'b', value: 2 },
      ]).total,
    ).toBe(3);
    expect(coverage([{ x: 'a', value: 1, partial: true }]).total).toBeNull();
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(120, null)).toBeNull();
    expect(pctChange(120, 0)).toBeNull();
    expect(pctChange(null, 100)).toBeNull();
  });

  it('sums KPI points per day inside the window and leaves other days unknown', () => {
    const pts = dailyFromPoints(
      [
        { ts: '2026-11-01T03:00:00Z', value: 2 },
        { ts: '2026-11-01T09:00:00Z', value: 3 },
        { ts: '2026-10-01T09:00:00Z', value: 99 },
      ],
      '2026-11-01',
      '2026-11-02',
    );
    expect(pts.map((p) => p.value)).toEqual([5, null]);
  });

  it('draws readable axes', () => {
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(labelIndices(28, 7)[0]).toBe(0);
    expect(labelIndices(28, 7).at(-1)).toBe(27);
    expect(formatCompact(1234)).toBe('1.2K');
    expect(formatCompact(null)).toBe('—');
    expect(formatCompact(0)).toBe('0');
  });
});

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

describe('global search', () => {
  const items = staticItems(['owner'], QUICK_ACTIONS);
  it('finds every page by its name and module id', () => {
    for (const p of PAGES) {
      const hit = rank(items, p.title).flatMap((g) => g.items);
      expect(
        hit.some((i) => i.href.endsWith(p.slug ? `/app/${p.slug}` : '/app/')),
        p.title,
      ).toBe(true);
    }
    expect(rank(items, 'M17').flatMap((g) => g.items)[0]?.title).toBe('Campaigns & paid media');
    expect(
      rank(items, 'password')
        .flatMap((g) => g.items)
        .some((i) => i.href === '/app/settings'),
    ).toBe(true);
  });

  it('requires every word, ranks titles first and groups by kind', () => {
    const groups = rank([...items, ...approvalItems([{ id: 'x', actionType: 'social.facebook.publish_post', statusReason: 'Policy requires approval' }])], 'facebook post');
    expect(groups.find((g) => g.kind === 'Approvals')?.items[0]?.href).toBe('/app/approvals?id=x');
    expect(score({ id: '1', kind: 'Pages', title: 'Approvals', detail: '', href: '', terms: '' }, 'zzz')).toBe(0);
    expect(score({ id: '1', kind: 'Pages', title: 'Approvals', detail: '', href: '', terms: '' }, 'approvals')).toBeGreaterThan(score({ id: '2', kind: 'Pages', title: 'Audit trail', detail: '', href: '', terms: 'approvals' }, 'approvals'));
  });

  it('does not offer restricted actions or tasks to roles that cannot do them', () => {
    const approver = staticItems(['approver'], allowedQuickActions({ roles: ['approver'] } as never));
    expect(approver.some((i) => i.title === 'New growth goal')).toBe(false);
    expect(approver.some((i) => i.title === 'Configure the autonomy policy')).toBe(false);
  });
});
