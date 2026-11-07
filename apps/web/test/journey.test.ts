import { describe, expect, it } from 'vitest';
import { SECTIONS, sectionBySlug } from '../src/lib/catalog.js';
import { canDo, evaluate, PIPELINE, type Progress, RANK_THRESHOLDS, RANKS, SECTION_FLOWS, STAGES, stageOf, TASKS, TOTAL_XP } from '../src/lib/journey.js';
import { pageBySlug } from '../src/lib/nav.js';

const all = (done: boolean): Progress => Object.fromEntries(TASKS.map((t) => [t.id, done]));

describe('growth journey (seven product steps, D-048)', () => {
  it('has the seven steps in order, over the same 18 live-checked tasks', () => {
    expect(STAGES.map((s) => s.key)).toEqual(['setup', 'connect', 'plan', 'create', 'launch', 'measure', 'improve']);
    expect(STAGES.map((s) => s.title)).toEqual(['Setup', 'Connect', 'Plan', 'Create', 'Launch', 'Measure', 'Improve']);
    expect(STAGES.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(TASKS.map((t) => t.id).sort()).toEqual(['mfa', 'team', 'policy', 'aiLimit', 'connected', 'healthy', 'evidence', 'claim', 'customerData', 'competitor', 'series', 'idea', 'decision', 'brief', 'asset', 'experiment', 'launch', 'verified'].sort());
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    // A step's pages are exactly where its tasks are done.
    for (const s of STAGES) expect([...s.sections].sort()).toEqual([...new Set(s.tasks.map((t) => t.section))].sort());
  });

  it('points every task, flow and pipeline step at a real page', () => {
    for (const t of TASKS) expect(sectionBySlug(t.section), t.id).toBeDefined();
    for (const t of TASKS) expect(pageBySlug(t.section), t.id).toBeDefined();
    for (const p of PIPELINE) expect(sectionBySlug(p.section), p.label).toBeDefined();
    for (const slug of Object.keys(SECTION_FLOWS)) expect(sectionBySlug(slug), slug).toBeDefined();
    // Every catalog section explains how it works.
    expect(SECTIONS.filter((s) => !SECTION_FLOWS[s.slug]).map((s) => s.slug)).toEqual([]);
  });

  it('keeps every earned rank: thresholds are frozen at the original stage totals, the top rank needs every task', () => {
    expect(TOTAL_XP).toBe(410);
    expect([...RANK_THRESHOLDS]).toEqual([0, 40, 80, 130, 190, 270, 330, 410]);
    expect(RANKS.map((r) => r.minXp)).toEqual([...RANK_THRESHOLDS]);
    expect(RANKS.map((r) => r.name)).toEqual(['Seed', 'Sprout', 'Sapling', 'Rooted', 'Branching', 'Blooming', 'Fruitful', 'Evergreen']);
    // The same XP gives the same rank as before the regrouping (e.g. 10 of 18 tasks done = Branching).
    const ten: Progress = { mfa: true, team: true, policy: true, aiLimit: true, connected: true, healthy: true, evidence: true, claim: true, customerData: true, competitor: true };
    const v = evaluate(ten, ['owner']);
    expect(v.xp).toBe(200);
    expect(v.rank.name).toBe('Branching');
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
    expect(viewer.stages[1]!.state).toBe('current');
    expect(canDo(TASKS.find((t) => t.id === 'policy')!, ['viewer'])).toBe(false);
    const onlyAdminLeft = evaluate({ ...all(true), team: false }, ['viewer']);
    expect(onlyAdminLeft.next?.id).toBe('team');
  });

  it('maps pages to their step', () => {
    expect(stageOf('connections')?.key).toBe('connect');
    expect(stageOf('experiments')?.key).toBe('improve');
    expect(stageOf('governance')?.key).toBe('setup');
    expect(stageOf('tools')).toBeUndefined();
  });
});
