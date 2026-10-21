import { describe, expect, it } from 'vitest';
import { SECTION_GROUPS, SECTIONS, sectionBySlug } from '../src/lib/catalog.js';
import { canDo, DAILY_SECTIONS, evaluate, JOURNEY_ORDER, neighbours, PIPELINE, type Progress, RANKS, SECTION_FLOWS, STAGES, stageOf, TASKS, TOTAL_XP } from '../src/lib/journey.js';

const all = (done: boolean): Progress => Object.fromEntries(TASKS.map((t) => [t.id, done]));

describe('growth journey', () => {
  it('places every section exactly once, in navigation order', () => {
    const slugs = [...DAILY_SECTIONS, ...STAGES.flatMap((s) => s.sections)];
    expect(new Set(slugs).size).toBe(slugs.length);
    expect([...slugs].sort()).toEqual(SECTIONS.map((s) => s.slug).sort());
    expect(SECTION_GROUPS.flatMap((g) => g.slugs)).toEqual(JOURNEY_ORDER);
    expect(STAGES.map((s) => s.n)).toEqual(STAGES.map((_, i) => i + 1));
  });

  it('points every task, flow and pipeline step at a real section', () => {
    for (const t of TASKS) expect(sectionBySlug(t.section), t.id).toBeDefined();
    for (const p of PIPELINE) expect(sectionBySlug(p.section), p.label).toBeDefined();
    for (const slug of Object.keys(SECTION_FLOWS)) expect(sectionBySlug(slug), slug).toBeDefined();
    // Every section except the overview explains how it works.
    expect(SECTIONS.filter((s) => s.slug !== 'overview' && !SECTION_FLOWS[s.slug]).map((s) => s.slug)).toEqual([]);
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
  });

  it('ranks rise one per completed stage, from Seed to the top at full XP', () => {
    expect(RANKS).toHaveLength(STAGES.length + 1);
    expect(RANKS[0]!.minXp).toBe(0);
    expect(RANKS.at(-1)!.minXp).toBe(TOTAL_XP);
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i]!.minXp).toBeGreaterThan(RANKS[i - 1]!.minXp);

    let progress: Progress = {};
    STAGES.forEach((stage, i) => {
      expect(evaluate(progress, ['owner']).rank.level).toBe(i + 1);
      progress = { ...progress, ...Object.fromEntries(stage.tasks.map((t) => [t.id, true])) };
    });
    const done = evaluate(all(true), ['owner']);
    expect(done).toMatchObject({ done: TASKS.length, xp: TOTAL_XP, next: null, nextRank: null });
    expect(done.rank.level).toBe(RANKS.length);
    expect(done.stages.every((s) => s.state === 'done')).toBe(true);
  });

  it('suggests the first unfinished task, skipping ones the role cannot do', () => {
    const fresh = evaluate({}, ['owner']);
    expect(fresh.next?.id).toBe('mfa');
    expect(fresh.stages.map((s) => s.state)).toEqual(['current', ...STAGES.slice(1).map(() => 'upcoming')]);

    // Unknown (null) counts as not done; a viewer is pointed past admin-only steps.
    const viewer = evaluate({ mfa: true, team: null, policy: false }, ['viewer']);
    expect(viewer.next?.id).toBe('healthy');
    expect(canDo(TASKS.find((t) => t.id === 'policy')!, ['viewer'])).toBe(false);
    // When nothing is left that the role can do, the first open task is still shown.
    const onlyAdminLeft = evaluate({ ...all(true), team: false }, ['viewer']);
    expect(onlyAdminLeft.next?.id).toBe('team');
  });

  it('links each section to its neighbours and stage', () => {
    expect(neighbours('overview')).toEqual({ prev: null, next: 'approvals' });
    expect(neighbours(JOURNEY_ORDER.at(-1)!).next).toBeNull();
    expect(neighbours('settings')).toEqual({ prev: 'approvals', next: 'governance' });
    expect(stageOf('connections')?.n).toBe(3);
    expect(stageOf('overview')).toBeUndefined();
  });
});
