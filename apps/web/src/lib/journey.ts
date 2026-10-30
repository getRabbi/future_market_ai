/**
 * Growth journey: the recommended order for setting up and running FUTUREGROW. Seven stages,
 * each a group of sections in the navigation, with tasks that are checked against live data
 * (never ticked by hand). XP from completed tasks sets the organization's rank; the thresholds
 * are the cumulative XP of each stage, so working in order levels up one rank per stage. Rank
 * meanings describe the amount of progress, never a particular stage, since tasks can be done
 * in any order.
 */

export type ProbeKey = 'mfa' | 'team' | 'policy' | 'aiLimit' | 'connected' | 'healthy' | 'evidence' | 'claim' | 'customerData' | 'competitor' | 'series' | 'idea' | 'decision' | 'brief' | 'asset' | 'experiment' | 'launch' | 'verified';

export interface Task {
  id: ProbeKey;
  title: string;
  /** Why this matters, in one sentence. */
  why: string;
  /** Where to do it on the target section. */
  how: string;
  section: string;
  xp: number;
  /** Only these roles can complete it (others are told to ask). */
  roles?: string[];
}

export interface Stage {
  n: number;
  title: string;
  tagline: string;
  sections: string[];
  tasks: Task[];
}

const ADMINS = ['owner', 'admin'];

export const STAGES: Stage[] = [
  {
    n: 1,
    title: 'Secure your workspace',
    tagline: 'Two-factor sign-in and a second person, so every consequential action gets a real review.',
    sections: ['settings'],
    tasks: [
      { id: 'mfa', title: 'Turn on two-factor sign-in', why: 'Approvals, kill switches, policy changes and connections all require a two-factor session.', how: 'Two-factor authentication → Turn on two-factor, scan the QR code with an authenticator app and enter its code.', section: 'settings', xp: 20 },
      { id: 'team', title: 'Add a teammate who can approve', why: 'Whoever proposes an action can never approve it, so you need at least two people.', how: 'Members → Invite someone with the approver role; it counts once they join.', section: 'settings', xp: 20, roles: ADMINS },
    ],
  },
  {
    n: 2,
    title: 'Set the guardrails',
    tagline: 'Decide what may run on its own, within which limits, and what always needs a human.',
    sections: ['governance', 'audit'],
    tasks: [
      { id: 'policy', title: 'Configure the autonomy policy', why: 'Until it is configured, every consequential action waits for human approval.', how: 'Autonomy policy → choose who approves each kind of action, tick “Policy is on”, then Save policy.', section: 'governance', xp: 30, roles: ADMINS },
      { id: 'aiLimit', title: 'Set a monthly AI spending limit', why: 'Agents abstain instead of overspending once the limit would be exceeded.', how: 'Autonomy policy → Limits → Monthly AI spending limit, then Save policy.', section: 'governance', xp: 10, roles: ADMINS },
    ],
  },
  {
    n: 3,
    title: 'Connect your channels',
    tagline: 'Link the accounts FUTUREGROW reads from and acts on, and prove the credentials work.',
    sections: ['connections'],
    tasks: [
      { id: 'connected', title: 'Connect your first account', why: 'Posting, ads, messaging and reporting all run through official provider APIs.', how: 'Pick a provider → Test credentials → Save connection.', section: 'connections', xp: 30, roles: ADMINS },
      { id: 'healthy', title: 'Get a healthy, active connection', why: 'Queued actions wait while a connection is failing or needs re-authorisation.', how: 'Connected accounts → Test connection.', section: 'connections', xp: 20 },
    ],
  },
  {
    n: 4,
    title: 'Build your ground truth',
    tagline: 'Evidence, approved claims and consented customer data that every later step relies on.',
    sections: ['evidence', 'knowledge', 'customers'],
    tasks: [
      { id: 'evidence', title: 'Admit your first evidence', why: 'Ideas, claims and decisions must trace back to evidence with known rights and freshness.', how: 'Evidence → Add evidence: what it is, where it comes from and whether you may use it.', section: 'evidence', xp: 20 },
      { id: 'claim', title: 'Approve a product claim', why: 'Copy, briefs and templates may only state claims that were approved against evidence.', how: 'Claims step → Propose a claim and pick its evidence; a colleague approves it.', section: 'knowledge', xp: 20 },
      { id: 'customerData', title: 'Start collecting first-party data', why: 'Audiences, journeys and forecasts are built on consented events from your own product.', how: 'Collect customer data → Create a key, then send events from your site or app.', section: 'customers', xp: 20 },
    ],
  },
  {
    n: 5,
    title: 'Discover opportunities',
    tagline: 'Watch the market, measure what matters and turn evidence into ranked ideas and decisions.',
    sections: ['market', 'analytics', 'brain', 'audiences'],
    tasks: [
      { id: 'competitor', title: 'Track a competitor', why: 'Lawful competitor observations feed the idea backlog and feature-gap analysis.', how: 'Competitors → Add a competitor.', section: 'market', xp: 10 },
      { id: 'series', title: 'Define a KPI metric series', why: 'Forecasts, experiments and decisions are measured against these series.', how: 'Metrics → Define a metric.', section: 'analytics', xp: 20 },
      { id: 'idea', title: 'Generate growth ideas', why: 'The AI proposes evidence-backed ideas and abstains when the evidence is thin.', how: 'Ideas → Generate ideas with AI.', section: 'market', xp: 20 },
      { id: 'decision', title: 'Turn an idea into a decision', why: 'Decisions carry expected value and uncertainty; accepting one proposes actions, it never runs them.', how: 'Decisions → Propose a decision from a queued idea.', section: 'brain', xp: 30 },
    ],
  },
  {
    n: 6,
    title: 'Create & test',
    tagline: 'Produce rights-cleared creative and test it properly before scaling anything.',
    sections: ['creative', 'assets', 'offers', 'personas', 'experiments'],
    tasks: [
      { id: 'brief', title: 'Generate a creative brief', why: 'Briefs map every message to an approved claim, so creative stays truthful.', how: 'Briefs → Draft a brief with AI.', section: 'creative', xp: 20 },
      { id: 'asset', title: 'Upload source media', why: 'Only assets with a complete rights manifest become publish-eligible.', how: 'Upload source media → choose a file → Upload.', section: 'assets', xp: 10 },
      { id: 'experiment', title: 'Design an experiment', why: 'Pre-registered experiments with SRM checks tell you what actually worked.', how: 'Experiments → Design an experiment.', section: 'experiments', xp: 30 },
    ],
  },
  {
    n: 7,
    title: 'Launch & verify',
    tagline: 'Publish through the channels, approve the exact action, and count it only once it is verified.',
    sections: ['social', 'ads', 'lifecycle', 'discovery', 'app', 'conversations', 'creators'],
    tasks: [
      { id: 'launch', title: 'Schedule a post or a journey', why: 'Channel work is proposed as an action and published only through the approval flow.', how: 'Posts → Schedule a post, or Lifecycle messaging → New journey.', section: 'social', xp: 30 },
      { id: 'verified', title: 'Get your first VERIFIED action', why: 'Success means an independent read-back confirmed the result, never just a 200 response.', how: 'Actions & approvals → a different person approves the exact action.', section: 'approvals', xp: 50 },
    ],
  },
];

export const TASKS: Task[] = STAGES.flatMap((s) => s.tasks);
export const TOTAL_XP = TASKS.reduce((n, t) => n + t.xp, 0);

/** Sections outside the stages, pinned above them in the navigation. */
export const DAILY_SECTIONS = ['overview', 'approvals'];

export interface Rank {
  level: number;
  name: string;
  /** What reaching this rank means. */
  meaning: string;
  minXp: number;
}

const RANK_NAMES: [string, string][] = [
  ['Seed', 'Just getting started'],
  ['Sprout', 'First steps taken'],
  ['Sapling', 'Finding your footing'],
  ['Rooted', 'Foundations in place'],
  ['Branching', 'Reaching into the market'],
  ['Blooming', 'Ideas turning into plans'],
  ['Fruitful', 'Testing what works'],
  ['Evergreen', 'Verified growth loop'],
];

export const RANKS: Rank[] = RANK_NAMES.map(([name, meaning], i) => ({
  level: i + 1,
  name,
  meaning,
  minXp: STAGES.slice(0, i).reduce((n, s) => n + s.tasks.reduce((m, t) => m + t.xp, 0), 0),
}));

/** Task id → done (true / false) or unknown (null: not loaded, or not readable with this role). */
export type Progress = Partial<Record<ProbeKey, boolean | null>>;

export type StageState = 'done' | 'current' | 'upcoming';

export interface JourneyView {
  done: number;
  total: number;
  xp: number;
  rank: Rank;
  nextRank: Rank | null;
  /** First unfinished task in journey order that this user can do (else the first unfinished). */
  next: Task | null;
  stages: { stage: Stage; done: number; state: StageState }[];
}

export function canDo(task: Task, roles: string[]): boolean {
  return !task.roles || task.roles.some((r) => roles.includes(r));
}

export function evaluate(progress: Progress, roles: string[]): JourneyView {
  const isDone = (t: Task) => progress[t.id] === true;
  const done = TASKS.filter(isDone);
  const xp = done.reduce((n, t) => n + t.xp, 0);
  const rank = [...RANKS].reverse().find((r) => xp >= r.minXp) ?? RANKS[0]!;
  const open = TASKS.filter((t) => !isDone(t));
  const next = open.find((t) => canDo(t, roles)) ?? open[0] ?? null;
  const currentStage = next ? STAGES.find((s) => s.tasks.includes(next)) : undefined;
  return {
    done: done.length,
    total: TASKS.length,
    xp,
    rank,
    nextRank: RANKS.find((r) => r.level === rank.level + 1) ?? null,
    next,
    stages: STAGES.map((stage) => {
      const n = stage.tasks.filter(isDone).length;
      return { stage, done: n, state: n === stage.tasks.length ? 'done' : stage === currentStage ? 'current' : 'upcoming' };
    }),
  };
}

export function stageOf(slug: string): Stage | undefined {
  return STAGES.find((s) => s.sections.includes(slug));
}

/** Every section in navigation order: daily first, then the stages. */
export const JOURNEY_ORDER: string[] = [...DAILY_SECTIONS, ...STAGES.flatMap((s) => s.sections)];

export function neighbours(slug: string): { prev: string | null; next: string | null } {
  const i = JOURNEY_ORDER.indexOf(slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: JOURNEY_ORDER[i - 1] ?? null, next: JOURNEY_ORDER[i + 1] ?? null };
}

/** "How this works": the order things happen in on each section. */
export const SECTION_FLOWS: Record<string, string[]> = {
  approvals: ['An agent or a person proposes an action', 'Policy checks evidence, limits and kill switches', 'A different person approves the exact action hash', 'It runs through the official API', 'An independent read-back marks it VERIFIED'],
  settings: ['Turn on two-factor sign-in', 'Scan the QR code and enter the code from your app', 'Change the starter password', 'Invite teammates with the right roles'],
  governance: ['Choose who approves each kind of action', 'Set an AI spending limit', 'Save the sender identity for email', 'Engage a kill switch the moment anything looks wrong'],
  audit: ['Every change writes an audit record', 'Each record is hash-chained to the previous one', 'Verify the chain at any time'],
  connections: ['Pick a provider', 'Test the credentials with a read-only call', 'Save with a two-factor session', 'Re-test whenever a connection needs attention'],
  evidence: ['Add evidence: what it is, its source and whether you may use it', 'Anything uncertain waits for review', 'A reviewer releases or rejects it', 'Ready evidence backs claims, facts and decisions'],
  knowledge: ['Add evidence', 'Index documents and record facts (optional)', 'Propose claims; a colleague approves them', 'Add brand rules, then check copy before it ships'],
  customers: ['Create an ingestion key', 'Events build consent-aware profiles', 'Record consent and suppressions', 'Answer data-subject requests before they are due'],
  market: ['Add competitors and lawful sources', 'Trends and observations arrive', 'Generate ideas (AI)', 'Queue the strongest ideas for testing'],
  analytics: ['Define a metric series', 'Points arrive from admitted evidence', 'Queue a forecast or media-mix job', 'Read the intervals and backtests'],
  brain: ['Start from a queued idea', 'Propose a decision with its uncertainty', 'Accepting proposes actions; nothing runs by itself', 'Review agent runs and their cost'],
  audiences: ['Define a segment on lawful attributes', 'Take a snapshot', 'Use it in journeys and experiments'],
  creative: ['Approve claims first', 'Generate a brief (AI)', 'Check the evidence map', 'Approve the brief'],
  assets: ['Upload source media', 'Record the rights for every component', 'Request a render', 'Publish-eligible assets can be posted'],
  offers: ['Set price guardrails', 'Draft an offer inside them', 'Approve the offer', 'Test it with CRO hypotheses'],
  personas: ['Write the persona bible', 'Add the disclosure copy', 'Approve the persona', 'Suspend it at any time'],
  experiments: ['Create it with a hypothesis and variants', 'Propose start; it goes through approval', 'Exposures and outcomes are logged', 'Analyze with SRM checks'],
  social: ['Connect Meta, TikTok or YouTube', 'Schedule a post', 'Approve it in Actions & approvals', 'A read-back verifies it went live'],
  ads: ['Connect an ad account', 'Campaigns sync in', 'Propose budget or status changes', 'Reconcile reported spend'],
  lifecycle: ['Save the sender identity in Governance', 'Create and approve templates', 'Build a journey on a trigger event', 'Activate it and watch delivery'],
  discovery: ['Audit your site', 'Review query opportunities', 'Validate and draft store listings', 'Approve, then push'],
  app: ['Send install events', 'Sync App Store reports', 'Compare cohorts by attribution method'],
  conversations: ['Index public help documents in Knowledge', 'Create a chat widget', 'The assistant answers with sources', 'Hand-offs come to your team'],
  creators: ['Add a creator', 'Record the signed contract', 'Create referral links', 'Review submissions and fraud flags'],
};

/** The end-to-end path one idea takes, shown on the overview. */
export const PIPELINE: { label: string; detail: string; section: string }[] = [
  { label: 'Evidence', detail: 'Sources with rights and freshness', section: 'evidence' },
  { label: 'Idea', detail: 'Ranked by evidence strength', section: 'market' },
  { label: 'Decision', detail: 'Expected value and uncertainty', section: 'brain' },
  { label: 'Action', detail: 'Proposed, never auto-run', section: 'approvals' },
  { label: 'Policy check', detail: 'Limits, budgets, kill switches', section: 'governance' },
  { label: 'Approval', detail: 'A second person, exact hash', section: 'approvals' },
  { label: 'Execution', detail: 'Through official APIs', section: 'connections' },
  { label: 'Verified', detail: 'Independent read-back', section: 'audit' },
];
