import { useMemo, useState } from 'react';
import { type ActivityKind, type AuditRow, activityFromAudit } from '../lib/dashboard.js';
import { formatDay, readableText, relativeTime, statusLabel } from '../lib/format.js';
import { GROUPS, PAGES, pageHref, pagesIn } from '../lib/nav.js';
import { type AutopilotStatus, SetupView } from './Autopilot.js';
import { KIND, OBJECTIVE, type PlanItem, type Program, type StudioOverview } from './ContentStudio.js';
import { INCIDENT_TITLES, REGISTRIES } from './Governance.js';
import { KIND_ICON, stamp } from './Home.js';
import { Ico } from './Icons.js';
import { JourneyHero, JourneyStepper, Pipeline, RankLadder, Roadmap } from './Journey.js';
import { GrowthSummary, HEADLINE, PERIODS, PerformancePanel, type PeriodKey, PeriodSelect, rangeText, useStoreOverview } from './Performance.js';
import { ResourcePanel } from './ResourcePanel.js';
import { isAdmin, listOrEmpty, useWorkspace } from './Shell.js';
import { Badge, EmptyState, ErrorNotice, LoadingRows, useApi } from './ui.js';

/* ------------------------------------------------------------------ */
/* Journey                                                             */
/* ------------------------------------------------------------------ */

export function JourneyPage() {
  return (
    <div className="stack">
      <section className="card journey-card">
        <JourneyStepper />
      </section>
      <JourneyHero />
      <div className="section-head">
        <h2>The seven steps</h2>
        <p className="small muted">Tasks tick themselves off from your live data — they are never ticked by hand. Every task earns XP; your rank rises as XP adds up. Open any step to see its tasks and where to do them.</p>
      </div>
      <Roadmap />
      <div className="section-head">
        <h2>Ranks</h2>
      </div>
      <RankLadder />
      <div className="section-head">
        <h2>How work flows through FUTUREGROW</h2>
        <p className="small muted">Every growth move follows the same path. Models propose; deterministic checks, a second person and an independent read-back decide.</p>
      </div>
      <Pipeline />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Onboarding & Setup                                                  */
/* ------------------------------------------------------------------ */

export function SetupPage() {
  const { me, autopilot, refreshAutopilot } = useWorkspace();
  return (
    <div className="stack">
      <section className="card journey-card">
        <header className="card-head">
          <h2 className="card-title">Where you are</h2>
          <a className="pill-link" href="/app/journey">
            View full journey <Ico name="arrow-right" size={15} />
          </a>
        </header>
        <JourneyStepper compact />
      </section>
      {autopilot?.available ? <SetupView me={me} status={autopilot} onStatus={() => void refreshAutopilot()} /> : <EmptyState title="The Autopilot is not available on this server">Setup of the individual modules continues in the Growth Journey.</EmptyState>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Content calendar                                                    */
/* ------------------------------------------------------------------ */

interface PostRow {
  id: string;
  platform: string;
  caption: string;
  scheduledAt: string;
  status: string;
  statusReason: string | null;
  externalUrl: string | null;
  verifiedAt: string | null;
  actionId: string | null;
}

const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dayTitle = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function postState(p: PostRow): { label: string; tone: string } {
  if (p.status === 'published_verified') return { label: 'Published and verified', tone: 'ok' };
  if (p.status === 'scheduled' || p.status === 'approval_required' || p.status === 'submitted') return { label: p.actionId ? 'Scheduled, waits for approval or its time' : 'Scheduled', tone: 'info' };
  if (p.status === 'draft') return { label: 'Draft', tone: 'muted' };
  if (p.status === 'cancelled' || p.status === 'discarded') return { label: statusLabel(p.status), tone: 'muted' };
  if (/fail|reject|denied/.test(p.status)) return { label: statusLabel(p.status), tone: 'danger' };
  return { label: statusLabel(p.status), tone: 'info' };
}

export function CalendarPage() {
  const programs = useApi<Program[]>('/v1/content/programs');
  const posts = useApi<PostRow[]>('/v1/social/posts');
  const [sel, setSel] = useState<string | null>(null);
  const program = programs.data?.find((p) => p.id === sel) ?? programs.data?.[0] ?? null;
  const ov = useApi<StudioOverview>(program ? `/v1/content/programs/${program.id}/overview` : null);
  const today = localDay(new Date().toISOString());
  const days = useMemo(() => [...Array(7).keys()].map((i) => localDay(new Date(Date.now() + i * 86_400_000).toISOString())), []);
  const list = posts.data ?? [];
  const byDay = (d: string) => list.filter((p) => localDay(p.scheduledAt) === d && p.status !== 'cancelled');
  const plan = (d: string) => (ov.data?.calendar ?? []).filter((i) => i.day === d);
  const upcoming = list.filter((p) => Date.parse(p.scheduledAt) >= Date.now() - 3_600_000 && !['cancelled', 'published_verified', 'discarded'].includes(p.status)).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const published = list.filter((p) => p.status === 'published_verified').sort((a, b) => Date.parse(b.verifiedAt ?? b.scheduledAt) - Date.parse(a.verifiedAt ?? a.scheduledAt));
  const loading = (!programs.data && !programs.error) || (!posts.data && !posts.error) || (program && !ov.data && !ov.error);
  return (
    <div className="stack">
      {programs.data && programs.data.length > 1 ? (
        <div className="toolbar">
          <label className="mini-select">
            Page program{' '}
            <select value={program?.id ?? ''} onChange={(e) => setSel(e.target.value)}>
              {programs.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.pack}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <ErrorNotice error={programs.error ?? posts.error ?? ov.error} />
      {loading ? (
        <LoadingRows label="Loading the calendar…" />
      ) : (
        <>
          <section className="card" aria-labelledby="cal-week">
            <header className="card-head">
              <h2 className="card-title" id="cal-week">
                <Ico name="calendar" size={19} /> Next seven days
              </h2>
              <span className="small muted">Times in your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone})</span>
            </header>
            {!program && !list.length ? (
              <EmptyState
                title="Nothing planned yet"
                action={
                  <a className="btn primary" href="/app/content">
                    Open Content Studio
                  </a>
                }
              >
                Enable daily lessons for a connected Facebook Page in Content Studio, or schedule a post in Organic social.
              </EmptyState>
            ) : (
              <ol className="week">
                {days.map((d) => {
                  const items = plan(d);
                  const ps = byDay(d);
                  return (
                    <li key={d} className={`week-day${d === today ? ' today' : ''}`} aria-label={`${dayTitle(d)}${d === today ? ' (today)' : ''}`}>
                      <div className="week-date">
                        {dayTitle(d)}
                        {d === today ? <span className="pill now">Today</span> : null}
                      </div>
                      {items.map((i) => (
                        <PlanChip key={i.id} item={i} />
                      ))}
                      {ps.map((p) => {
                        const st = postState(p);
                        return (
                          <div key={p.id} className={`cal-post ${st.tone}`}>
                            <span className="cal-time">{time(p.scheduledAt)}</span>
                            <span className="cal-caption">{readableText(p.caption).slice(0, 70)}</span>
                            <span className={`status-pill ${st.tone}`}>{st.label}</span>
                          </div>
                        );
                      })}
                      {!items.length && !ps.length ? <span className="small muted">Nothing planned</span> : null}
                    </li>
                  );
                })}
              </ol>
            )}
            {ov.data?.planNotes.length ? (
              <ul className="small muted tight">
                {ov.data.planNotes.map((n) => (
                  <li key={n}>{readableText(n)}</li>
                ))}
              </ul>
            ) : null}
          </section>
          <div className="grid-2">
            <section className="card" aria-labelledby="cal-up">
              <header className="card-head">
                <h2 className="card-title" id="cal-up">
                  Upcoming posts
                </h2>
                <span className="small muted">{upcoming.length}</span>
              </header>
              {upcoming.length ? (
                <ul className="row-list">
                  {upcoming.slice(0, 12).map((p) => {
                    const st = postState(p);
                    return (
                      <li key={p.id}>
                        <span>
                          <strong>
                            {dayTitle(localDay(p.scheduledAt))}, {time(p.scheduledAt)}
                          </strong>
                          <span className="small muted">
                            {' '}
                            · {statusLabel(p.platform)} · {readableText(p.caption).slice(0, 80)}
                          </span>
                        </span>
                        {p.actionId ? (
                          <a className={`status-pill ${st.tone}`} href={`/app/approvals?id=${p.actionId}`}>
                            {st.label}
                          </a>
                        ) : (
                          <span className={`status-pill ${st.tone}`}>{st.label}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="small muted">No posts are scheduled. Daily lessons are drafted and submitted by the Autopilot inside your posting window.</p>
              )}
            </section>
            <section className="card" aria-labelledby="cal-hist">
              <header className="card-head">
                <h2 className="card-title" id="cal-hist">
                  Published and verified
                </h2>
                <span className="small muted">{published.length}</span>
              </header>
              {published.length ? (
                <ul className="row-list">
                  {published.slice(0, 12).map((p) => (
                    <li key={p.id}>
                      <span>
                        <strong>{p.verifiedAt ? `${dayTitle(localDay(p.verifiedAt))}, ${time(p.verifiedAt)}` : dayTitle(localDay(p.scheduledAt))}</strong>
                        <span className="small muted"> · {readableText(p.caption).slice(0, 80)}</span>
                      </span>
                      {p.externalUrl ? (
                        <a className="link-btn" href={p.externalUrl} target="_blank" rel="noopener noreferrer">
                          View post <Ico name="external" size={14} />
                        </a>
                      ) : (
                        <span className="status-pill ok">Verified</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">Nothing published and verified yet. A post counts only after an independent read-back confirms it is live.</p>
              )}
            </section>
          </div>
          {ov.data?.history.length ? (
            <section className="card" aria-labelledby="cal-results">
              <header className="card-head">
                <h2 className="card-title" id="cal-results">
                  Lesson history and engagement
                </h2>
                <a className="link-btn" href="/app/content">
                  Content Studio <Ico name="arrow-right" size={15} />
                </a>
              </header>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Day</th>
                      <th scope="col">Lesson</th>
                      <th scope="col">Status</th>
                      <th scope="col">Engagement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ov.data.history.slice(0, 14).map((i) => (
                      <tr key={i.id}>
                        <td>{formatDay(i.day)}</td>
                        <td>
                          {KIND[i.kind] ?? i.kind}
                          {i.unit ? <span lang="ko"> · {i.unit.korean}</span> : null}
                        </td>
                        <td>
                          <Badge value={i.status} />
                        </td>
                        <td>{i.engagement === null ? <span className="muted">Not measured yet</span> : i.engagement}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="small muted">Engagement is reactions + comments + shares as read back from the Page; it stays “not measured” while any counter is unknown.</p>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function PlanChip({ item: i }: { item: PlanItem }) {
  return (
    <div className="cal-plan">
      <strong>{KIND[i.kind] ?? i.kind}</strong>
      {i.unit ? <span lang="ko">{i.unit.korean}</span> : null}
      <span className="small muted">
        {OBJECTIVE[i.objective] ?? i.objective} · {statusLabel(i.status)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Results                                                             */
/* ------------------------------------------------------------------ */

interface ExperimentRow {
  id: string;
  name?: string;
  title?: string;
  hypothesis?: string;
  status: string;
  createdAt: string;
}

export function ResultsPage() {
  const { attention } = useWorkspace();
  const [period, setPeriod] = useState<PeriodKey>('r28');
  const days = PERIODS.find((p) => p.key === period)!.days;
  const overview = useStoreOverview(days);
  const experiments = useApi<ExperimentRow[]>('/v1/experiments');
  const goals = listOrEmpty(attention.goals);
  const o = overview.data;
  const initialApp = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('app') : null;
  return (
    <div className="stack">
      <div className="toolbar">
        <PeriodSelect value={period} onChange={setPeriod} id="results-period" />
        <span className="small muted">{o ? (rangeText(o) ?? 'No reported days yet') : 'Checking report dates…'}</span>
      </div>
      <GrowthSummary overview={overview} />
      <PerformancePanel overview={overview} days={days} heading="KPI over time" variant="wide" initialApp={initialApp} />
      <div className="grid-2">
        <section className="card" aria-labelledby="res-goals">
          <header className="card-head">
            <h2 className="card-title" id="res-goals">
              Goal progress
            </h2>
            <a className="link-btn" href="/app/goals">
              All goals <Ico name="arrow-right" size={15} />
            </a>
          </header>
          {!goals ? (
            <LoadingRows />
          ) : goals.length === 0 ? (
            <p className="small muted">No goals yet. Progress appears once a goal has measured data.</p>
          ) : (
            <ul className="row-list">
              {goals.map((g) => {
                const m = g.memory.finalMeasurement ?? g.memory.lastMeasurement;
                return (
                  <li key={g.id}>
                    <span>
                      <a href={`/app/goals?id=${g.id}`}>
                        <strong>{g.title}</strong>
                      </a>
                      <span className="small muted"> · {g.kpi.label}</span>
                    </span>
                    <span className="small">
                      {m?.status === 'measured' ? (
                        [m.changeVsBaselinePct !== null ? `${m.changeVsBaselinePct >= 0 ? '+' : ''}${m.changeVsBaselinePct.toFixed(1)}% vs baseline` : null, m.progressPct !== null ? `${m.progressPct.toFixed(0)}% of target` : null, m.forecast ? `${m.forecast.position} forecast range` : 'no forecast yet']
                          .filter(Boolean)
                          .join(' · ')
                      ) : (
                        <span className="muted">Not measured yet</span>
                      )}
                    </span>
                    <Badge value={g.status} />
                  </li>
                );
              })}
            </ul>
          )}
          <p className="small muted">Changes are compared with the pre-goal baseline and the no-action forecast. They show association, not proof that an action caused them.</p>
        </section>
        <section className="card" aria-labelledby="res-cov">
          <header className="card-head">
            <h2 className="card-title" id="res-cov">
              Data quality and coverage
            </h2>
          </header>
          {!o ? (
            overview.error ? (
              <ErrorNotice error={overview.error} />
            ) : (
              <LoadingRows />
            )
          ) : o.apps.length === 0 ? (
            <p className="small muted">No store reports yet. Coverage appears once a developer account imports reports.</p>
          ) : (
            <ul className="row-list">
              {o.apps.map((a) => {
                const k = HEADLINE[a.platform][0]!;
                const m = a.metrics[k];
                return (
                  <li key={a.id}>
                    <span>
                      <a href={`/app/apps?app=${a.id}`}>
                        <strong>{a.displayName ?? a.appId}</strong>
                      </a>
                      <span className="small muted">
                        {' '}
                        · {a.platform === 'ios' ? 'iOS' : 'Android'} · reported through {a.freshness.latestDay ? formatDay(a.freshness.latestDay) : 'no day yet'}
                      </span>
                    </span>
                    <span className="small">{m ? `${m.daysWithData} of ${m.expectedDays} days` : '—'}</span>
                    <Badge value={a.coverage.worst ?? 'pending'} />
                  </li>
                );
              })}
            </ul>
          )}
          {o?.notes.length ? (
            <ul className="small muted tight">
              {o.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
      <section className="card" aria-labelledby="res-exp">
        <header className="card-head">
          <h2 className="card-title" id="res-exp">
            Experiments
          </h2>
          <a className="link-btn" href="/app/experiments">
            Open Experiments <Ico name="arrow-right" size={15} />
          </a>
        </header>
        {experiments.error ? <ErrorNotice error={experiments.error} /> : null}
        {!experiments.data && !experiments.error ? (
          <LoadingRows />
        ) : (experiments.data ?? []).length === 0 ? (
          <p className="small muted">No experiments yet. Outcomes appear here once an experiment has logged exposures and results.</p>
        ) : (
          <ul className="row-list">
            {(experiments.data ?? []).slice(0, 8).map((x) => (
              <li key={x.id}>
                <span>
                  <strong>{x.name ?? x.title ?? 'Experiment'}</strong>
                  {x.hypothesis ? <span className="small muted"> · {x.hypothesis.slice(0, 120)}</span> : null}
                </span>
                <Badge value={x.status} />
                <span className="small muted">{relativeTime(x.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Insights & learnings                                                */
/* ------------------------------------------------------------------ */

interface Signals {
  signals: { appId: string; platform: string; status: string; statement: string }[];
  qualityFlags: { appId: string; statement: string }[];
}
interface DecisionRow {
  id: string;
  objective: string;
  narrative: string | null;
  status: string;
  createdAt: string;
}

export function InsightsPage() {
  const { attention } = useWorkspace();
  const goals = listOrEmpty(attention.goals);
  const signals = useApi<Signals>('/v1/app-intelligence/signals');
  const decisions = useApi<DecisionRow[]>('/v1/brain/decisions');
  const programs = useApi<Program[]>('/v1/content/programs');
  const lessons = (goals ?? []).flatMap((g) => (g.memory.lessons ?? []).slice(0, 6).map((l) => ({ goal: g, lesson: l })));
  return (
    <div className="stack">
      <div className="grid-2">
        <section className="card" aria-labelledby="ins-lessons">
          <header className="card-head">
            <h2 className="card-title" id="ins-lessons">
              <Ico name="bulb" size={19} /> What the Autopilot learned
            </h2>
          </header>
          {!goals ? (
            <LoadingRows />
          ) : lessons.length ? (
            <ul className="row-list">
              {lessons.map(({ goal, lesson }) => (
                <li key={`${goal.id}-${lesson}`}>
                  <span>
                    {lesson}
                    <span className="small muted"> · {goal.title}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No lessons yet. They are recorded after cycles that measured a result.</p>
          )}
        </section>
        <section className="card" aria-labelledby="ins-signals">
          <header className="card-head">
            <h2 className="card-title" id="ins-signals">
              <Ico name="phone" size={19} /> Store signals
            </h2>
            <a className="link-btn" href="/app/apps">
              Apps <Ico name="arrow-right" size={15} />
            </a>
          </header>
          <p className="small muted">Changes in reported acquisition over the last 28 final days against the 28 before. Nothing is stated on stale or thin data, and a change is not attributed to a cause.</p>
          {signals.error ? <ErrorNotice error={signals.error} /> : null}
          {!signals.data && !signals.error ? (
            <LoadingRows />
          ) : signals.data && !signals.data.signals.length && !signals.data.qualityFlags.length ? (
            <p className="small muted">No signals yet. They appear once apps have imported enough final report days.</p>
          ) : (
            <ul className="row-list">
              {signals.data?.signals.map((s) => (
                <li key={`${s.appId}-${s.statement.slice(0, 40)}`}>
                  <span>{s.statement}</span>
                  <Badge value={s.status} />
                </li>
              ))}
              {signals.data?.qualityFlags.map((f) => (
                <li key={f.statement}>
                  <span>{f.statement}</span>
                  <Badge value="quality" />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="card" aria-labelledby="ins-decisions">
        <header className="card-head">
          <h2 className="card-title" id="ins-decisions">
            <Ico name="brain" size={19} /> Growth Brain decisions
          </h2>
          <a className="link-btn" href="/app/brain">
            Growth Brain <Ico name="arrow-right" size={15} />
          </a>
        </header>
        {decisions.error ? <ErrorNotice error={decisions.error} /> : null}
        {!decisions.data && !decisions.error ? (
          <LoadingRows />
        ) : (decisions.data ?? []).length === 0 ? (
          <p className="small muted">No decisions yet. The Growth Brain proposes decisions with their expected value and uncertainty, and abstains when unsure.</p>
        ) : (
          <ul className="row-list">
            {(decisions.data ?? []).slice(0, 10).map((d) => (
              <li key={d.id}>
                <span>
                  <strong>{readableText(d.objective)}</strong>
                  {d.narrative ? <span className="small muted"> — {readableText(d.narrative).slice(0, 200)}</span> : null}
                </span>
                <Badge value={d.status} />
                <span className="small muted">{relativeTime(d.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {programs.data?.[0] ? <StudioLearning program={programs.data[0]} /> : null}
    </div>
  );
}

function StudioLearning({ program }: { program: Program }) {
  const ov = useApi<StudioOverview>(`/v1/content/programs/${program.id}/overview`);
  return (
    <section className="card" aria-labelledby="ins-content">
      <header className="card-head">
        <h2 className="card-title" id="ins-content">
          <Ico name="layers" size={19} /> Content learning
        </h2>
        <a className="link-btn" href="/app/content">
          Content Studio <Ico name="arrow-right" size={15} />
        </a>
      </header>
      {ov.error ? <ErrorNotice error={ov.error} /> : null}
      {!ov.data && !ov.error ? (
        <LoadingRows />
      ) : ov.data ? (
        <>
          <p className="small">
            {ov.data.learning.measuredPosts} measured post{ov.data.learning.measuredPosts === 1 ? '' : 's'} · phase: {statusLabel(ov.data.learning.phase)} · {ov.data.measurement.publishedPosts} published
          </p>
          <ul className="small muted tight">
            {[...ov.data.learning.notes, ...ov.data.measurement.notes].map((n) => (
              <li key={n}>{readableText(n)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Incidents & alerts                                                  */
/* ------------------------------------------------------------------ */

export function IncidentsPage({ autopilot }: { autopilot: AutopilotStatus | null }) {
  const { attention } = useWorkspace();
  const engaged = (attention.killSwitches.data ?? []).filter((k) => k.engaged);
  return (
    <div className="stack">
      {autopilot?.stopped ? (
        <div className="notice error" role="alert">
          <strong>The Autopilot is stopped.</strong> {autopilot.stopped}. Release the emergency stop in <a href="/app/governance">Governance &amp; Security</a> to continue.
        </div>
      ) : null}
      <section className="card" aria-labelledby="inc-stops">
        <header className="card-head">
          <h2 className="card-title" id="inc-stops">
            <Ico name="shield" size={19} /> Emergency stops
          </h2>
          <a className="link-btn" href="/app/governance">
            Manage <Ico name="arrow-right" size={15} />
          </a>
        </header>
        {!attention.killSwitches.loaded ? (
          <LoadingRows />
        ) : engaged.length ? (
          <ul className="row-list">
            {engaged.map((k) => (
              <li key={k.id}>
                <span>
                  <strong>{k.scope === 'tenant' ? 'Everything in this organization' : `${statusLabel(k.scope)}: ${k.targetRef ?? ''}`}</strong>
                  {k.reason ? <span className="small muted"> · {k.reason}</span> : null}
                </span>
                <span className="status-pill danger">Engaged</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">No emergency stop is engaged.</p>
        )}
      </section>
      {REGISTRIES.filter((r) => INCIDENT_TITLES.includes(r.title)).map((r) => (
        <ResourcePanel key={r.title} resource={r} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Activity log                                                        */
/* ------------------------------------------------------------------ */

const KIND_FILTERS: { key: ActivityKind | 'all'; label: string }[] = [
  { key: 'all', label: 'Everything' },
  { key: 'publish', label: 'Publishing' },
  { key: 'content', label: 'Content' },
  { key: 'store', label: 'Store reports' },
  { key: 'approval', label: 'Approvals' },
  { key: 'governance', label: 'Governance' },
  { key: 'connection', label: 'Connections' },
];

export function ActivityPage() {
  const { me } = useWorkspace();
  const audit = useApi<AuditRow[]>('/v1/governance/audit?limit=500');
  const [kind, setKind] = useState<ActivityKind | 'all'>('all');
  const items = activityFromAudit(audit.data, me.userId, 500);
  const shown = (items ?? []).filter((i) => kind === 'all' || i.kind === kind);
  return (
    <div className="stack">
      <div className="toolbar">
        <fieldset className="seg">
          <legend className="sr-only">Filter activity</legend>
          {KIND_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={kind === f.key} className={`seg-btn${kind === f.key ? ' on' : ''}`} onClick={() => setKind(f.key)}>
              {f.label}
            </button>
          ))}
        </fieldset>
        <a className="link-btn" href="/app/audit">
          Verify the audit chain <Ico name="arrow-right" size={15} />
        </a>
      </div>
      <section className="card">
        {audit.error ? <ErrorNotice error={audit.error} /> : null}
        {!items && !audit.error ? (
          <LoadingRows label="Loading activity…" />
        ) : shown.length === 0 ? (
          <p className="small muted">Nothing recorded{kind === 'all' ? '' : ' of this kind'} yet.</p>
        ) : (
          <ul className="feed full">
            {shown.map((i) => (
              <li key={i.key} className="feed-item">
                <span className={`feed-icon ${i.kind}`}>
                  <Ico name={KIND_ICON[i.kind]} size={18} />
                </span>
                <span className="feed-body">
                  {i.href ? <a href={i.href}>{i.title}</a> : <strong>{i.title}</strong>}
                  <span className="feed-detail">{[i.actor, i.detail].filter(Boolean).join(' · ')}</span>
                  <details className="feed-tech">
                    <summary>Technical details</summary>
                    <code>
                      #{i.record.seq} · {i.record.action} · {i.record.subject_type}
                      {i.record.subject_id ? ` ${i.record.subject_id}` : ''} · {i.record.actor_type}:{i.record.actor_id}
                    </code>
                  </details>
                </span>
                <time className="feed-time" dateTime={i.at}>
                  {stamp(i.at)}
                </time>
                <span className={`status-pill ${i.status.tone}`}>{i.status.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* All tools                                                           */
/* ------------------------------------------------------------------ */

export function ToolsPage() {
  const { me } = useWorkspace();
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const match = (p: (typeof PAGES)[number]) => !term || `${p.title} ${p.summary} ${p.keywords.join(' ')} ${p.modules.join(' ')}`.toLowerCase().includes(term);
  return (
    <div className="stack">
      <div className="toolbar">
        <label className="filter-box">
          <Ico name="search" size={17} />
          <span className="sr-only">Filter tools</span>
          <input type="search" placeholder="Filter tools by name, purpose or module (e.g. M17)" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <span className="small muted">
          {PAGES.length - 1} tools · all 24 modules (M01–M24){isAdmin(me) ? '' : ' · some actions need an owner or admin'}
        </span>
      </div>
      {GROUPS.filter((g) => g.key !== 'home').map((g) => {
        const pages = pagesIn(g.key).filter(match);
        if (!pages.length) return null;
        return (
          <section key={g.key} className="tools-group" aria-labelledby={`tools-${g.key}`}>
            <h2 id={`tools-${g.key}`}>{g.title}</h2>
            <div className="tools-grid">
              {pages.map((p) => (
                <a key={p.slug} className="tool-card" href={pageHref(p.slug)}>
                  <span className="tool-icon">
                    <Ico name={p.icon} size={20} />
                  </span>
                  <span className="tool-body">
                    <strong>{p.title}</strong>
                    <span className="small muted">{p.summary}</span>
                    {p.modules.length ? <span className="tool-mods">{p.modules.join(' · ')}</span> : null}
                  </span>
                </a>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
