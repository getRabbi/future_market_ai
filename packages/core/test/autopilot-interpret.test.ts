import { describe, expect, it } from 'vitest';
import { interpretGoal } from '../src/modules/autopilot/index.js';

const now = new Date('2026-10-31T09:00:00Z');
const engagement = { key: 'kpi.facebook.page_post_engagements', name: 'Facebook Page post engagements (EPS-topik-Bangla)', unit: 'engagements' };
const views = { key: 'kpi.facebook.page_media_view', name: 'Facebook Page content views (EPS-topik-Bangla)', unit: 'views' };
const signups = { key: 'kpi.smoke_signups', name: 'Smoke signups', unit: 'count' };

describe('Autopilot goal intake: Facebook Page KPIs', () => {
  it('maps organic Facebook engagement to the Page engagement series, never to an unrelated series', () => {
    const r = interpretGoal("Improve EPS TOPIK Bangla's organic Facebook engagement over the next 30 days with $0 advertising budget.", { now, series: [signups], market: 'BD' });
    expect(r.draft.kpi).toMatchObject({ metricKey: 'kpi.facebook.page_post_engagements', label: 'Facebook Page post engagements', unit: 'engagements', direction: 'increase' });
    expect(r.draft).toMatchObject({ channels: ['organic_social'], adBudget: { amountMicros: 0 }, market: 'BD' });
    expect(r.check).toContain('kpi');
    expect(r.assumptions.join(' ')).toMatch(/daily Page insights sync/);
    expect(r.assumptions.join(' ')).not.toMatch(/Smoke signups/);
  });

  it('uses the synced series when it exists, and never substitutes another Facebook metric', () => {
    const synced = interpretGoal('Grow engagement on our Facebook Page by 20% in 4 weeks', { now, series: [signups, views, engagement], market: 'BD' });
    expect(synced.draft.kpi).toMatchObject({ metricKey: engagement.key, label: engagement.name, targetChangePct: 20 });
    expect(synced.check).not.toContain('kpi');
    const onlyViews = interpretGoal('Grow engagement on our Facebook Page', { now, series: [views], market: 'BD' });
    expect(onlyViews.draft.kpi.metricKey).toBe(engagement.key);
    expect(onlyViews.check).toContain('kpi');
  });

  it('maps Page followers, and leaves engagement without a social context for the owner to choose', () => {
    expect(interpretGoal('Get more Facebook followers this month', { now, series: [], market: 'BD' }).draft.kpi.metricKey).toBe('kpi.facebook.page_daily_follows_unique');
    const app = interpretGoal('Improve in-app engagement over 30 days', { now, series: [signups], market: 'US' });
    expect(app.draft.kpi.metricKey).not.toMatch(/^kpi\.facebook\./);
    expect(app.check).toContain('kpi');
  });
});
