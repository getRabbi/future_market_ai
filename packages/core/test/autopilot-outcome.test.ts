import { describe, expect, it } from 'vitest';
import { classifyCycle, cycleView } from '../src/modules/autopilot/outcome.js';

/** How a finished cycle reads (D-047): a missing forecast never turns a verified post into a blocked or failed publication. */
const task = (kind: string, status: string, over: Partial<{ needs: string | null; detail: string | null; output: Record<string, unknown> }> = {}) => ({ id: `t-${kind}`, kind, status, title: `${kind} step`, needs: over.needs ?? null, detail: over.detail ?? `${kind} detail`, output: over.output ?? {} });
const FORECAST_NO_DATA = task('forecast', 'blocked', { needs: 'data', detail: 'There is no Facebook Page post engagements series yet (read_insights).' });
const studioCycle = (trackStatus: string) => [
  task('observe', 'completed'),
  FORECAST_NO_DATA,
  task('research', 'completed'),
  task('ideas', 'skipped'),
  task('decide', 'skipped'),
  task('content', 'completed'),
  task('submit', 'completed', { output: { postId: 'p1', actionId: 'a1' } }),
  task('track', 'completed', { output: { actionId: 'a1', status: trackStatus } }),
  task('measure', 'completed'),
  task('learn', 'completed', { detail: 'Bootstrap cycle: a post went to the execution gateway and is verified.' }),
];

describe('Autopilot cycle reading', () => {
  it('completes a cycle whose post M23 verified, listing the forecast without data as unavailable', () => {
    const r = classifyCycle(studioCycle('VERIFIED'));
    expect(r).toMatchObject({ status: 'completed', delivered: true, actionStatus: 'VERIFIED', blocked: [], attention: [] });
    expect(r.unavailable).toEqual([{ taskId: 't-forecast', kind: 'forecast', needs: 'data', title: 'forecast step', detail: FORECAST_NO_DATA.detail }]);
    expect(r.summary).toMatch(/^Bootstrap cycle: a post went to the execution gateway and is verified\. Not available yet \(not blocking\): forecast step — /);
    expect(r.summary).not.toMatch(/Needs attention/);
  });

  it('keeps a missing forecast a blocker when nothing was delivered', () => {
    const r = classifyCycle([task('observe', 'completed'), FORECAST_NO_DATA, task('ideas', 'blocked', { needs: 'evidence' }), task('decide', 'skipped'), task('submit', 'skipped'), task('track', 'skipped'), task('learn', 'completed')]);
    expect(r.status).toBe('blocked');
    expect(r.unavailable).toEqual([]);
    expect(r.blocked.map((b) => b.kind)).toEqual(['forecast', 'ideas']);
    expect(r.summary).toMatch(/^Needs attention: forecast step — .* \| ideas step — /);
  });

  it('keeps real execution failures and failed steps visible', () => {
    for (const s of ['FAILED', 'ROLLED_BACK', 'ESCALATED']) {
      const r = classifyCycle(studioCycle(s));
      expect(r.status).toBe('failed');
      expect(r.attention.map((a) => a.kind)).toEqual(['track', 'forecast']);
      expect(r.summary).toMatch(/^Needs attention: track step/);
    }
    // A post still waiting for approval or refused by policy is not a delivery: the forecast stays a blocker.
    expect(classifyCycle(studioCycle('DENIED')).status).toBe('blocked');
    const failedStep = classifyCycle([...studioCycle('VERIFIED').filter((t) => t.kind !== 'measure'), task('measure', 'failed')]);
    expect(failedStep.status).toBe('failed');
    expect(failedStep.attention.map((a) => a.kind)).toEqual(['measure']);
    // A blocker other than a forecast without data stays a blocker even next to a verified post.
    const claims = classifyCycle([...studioCycle('VERIFIED'), task('content', 'blocked', { needs: 'claims' })]);
    expect(claims.status).toBe('blocked');
  });

  it('reads stored cycles the same way and keeps the recorded status for diagnostics', () => {
    const stored = { id: 'c6', status: 'blocked', summary: 'Needs attention: Forecast …' };
    expect(cycleView(stored, studioCycle('VERIFIED'))).toMatchObject({ id: 'c6', status: 'completed', recordedStatus: 'blocked', recordedSummary: 'Needs attention: Forecast …', unavailable: [{ kind: 'forecast' }] });
    expect(cycleView({ id: 'c7', status: 'running', summary: null }, studioCycle('VERIFIED'))).toMatchObject({ status: 'running', recordedStatus: 'running', unavailable: [] });
    expect(cycleView({ id: 'c8', status: 'cancelled', summary: 'Cancelled with the goal.' }, [])).toMatchObject({ status: 'cancelled', summary: 'Cancelled with the goal.' });
  });
});
