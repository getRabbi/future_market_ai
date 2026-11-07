/**
 * How a finished Autopilot cycle reads (pure, no I/O). Used when a cycle finishes and when stored
 * cycles are shown, so cycles recorded before this rule read the same way without rewriting them.
 *
 * - A failed step, or an action that ended in an execution failure, fails the cycle.
 * - A step that could not run blocks the cycle, except a forecast that lacks data in a cycle whose
 *   action M23 executed and independently verified: the forecast is then "unavailable", listed as
 *   a non-blocking limitation, and the cycle is completed. A missing forecast never turns a
 *   verified post into a failed or blocked publication; without a verified action it still blocks.
 */
export interface CycleTaskLike {
  id: string;
  kind: string;
  status: string;
  needs: string | null;
  title: string;
  detail: string | null;
  output: Record<string, unknown> | null;
}

export interface CycleNote {
  taskId: string;
  kind: string;
  needs: string | null;
  title: string;
  detail: string | null;
}

/** Action outcomes that are execution failures (not a person's decision). */
const EXECUTION_FAILURES = ['FAILED', 'ROLLED_BACK', 'ESCALATED'];
const FINISHED = ['completed', 'blocked', 'failed'];

const note = (t: CycleTaskLike): CycleNote => ({ taskId: t.id, kind: t.kind, needs: t.needs, title: t.title, detail: t.detail });

export function classifyCycle(tasks: CycleTaskLike[]) {
  const failed = tasks.filter((t) => t.status === 'failed');
  const track = tasks.find((t) => t.kind === 'track' && t.status === 'completed');
  const actionStatus = typeof track?.output?.status === 'string' ? track.output.status : null;
  const delivered = actionStatus === 'VERIFIED';
  const executionFailed = track && actionStatus && EXECUTION_FAILURES.includes(actionStatus) ? track : null;
  const stuck = tasks.filter((t) => t.status === 'blocked');
  const unavailable = delivered ? stuck.filter((t) => t.kind === 'forecast' && t.needs === 'data') : [];
  const blocked = stuck.filter((t) => !unavailable.includes(t));
  const attention = [...failed, ...(executionFailed ? [executionFailed] : []), ...blocked];
  const status: 'completed' | 'blocked' | 'failed' = failed.length || executionFailed ? 'failed' : blocked.length ? 'blocked' : 'completed';
  const learn = tasks.find((t) => t.kind === 'learn');
  const summary = attention.length
    ? `Needs attention: ${attention.map((t) => `${t.title} — ${t.detail ?? t.status}`).join(' | ')}`.slice(0, 2000)
    : `${learn?.detail ?? 'Cycle finished.'}${unavailable.length ? ` Not available yet (not blocking): ${unavailable.map((t) => `${t.title} — ${t.detail ?? 'no data'}`).join(' | ')}` : ''}`.slice(0, 2000);
  return { status, summary, delivered, actionStatus, blocked: blocked.map(note), unavailable: unavailable.map(note), attention: attention.map(note) };
}

/**
 * A stored cycle as the API shows it: the reading above for finished cycles, with the stored
 * status and summary kept as `recordedStatus` / `recordedSummary` for diagnostics.
 */
export function cycleView<C extends { status: string; summary: string | null }>(cycle: C, tasks: CycleTaskLike[]) {
  if (!FINISHED.includes(cycle.status) || !tasks.length) return { ...cycle, recordedStatus: cycle.status, recordedSummary: cycle.summary, unavailable: [] as CycleNote[], attention: [] as CycleNote[] };
  const r = classifyCycle(tasks);
  return { ...cycle, status: r.status, summary: r.summary, recordedStatus: cycle.status, recordedSummary: cycle.summary, unavailable: r.unavailable, attention: r.attention };
}
