/**
 * Unified navigation (D-048): one information architecture for the whole product. Every page —
 * the Home dashboard, the Autopilot views and all 24 module sections — lives in one shell with
 * one sidebar, breadcrumbs and search. Navigation groups are a reading model only: they never
 * rename or remove backend modules, and every catalog section keeps its /app/<slug> address.
 */
import { SECTIONS } from './catalog.js';

export type GroupKey = 'home' | 'journey' | 'goals' | 'content' | 'channels' | 'intelligence' | 'results' | 'reviews' | 'settings';

export type IconName =
  | 'home'
  | 'journey'
  | 'setup'
  | 'target'
  | 'autopilot'
  | 'layers'
  | 'calendar'
  | 'share'
  | 'megaphone'
  | 'message'
  | 'phone'
  | 'chart'
  | 'compass'
  | 'trend'
  | 'bulb'
  | 'flask'
  | 'check-circle'
  | 'shield'
  | 'alert'
  | 'file-check'
  | 'gear'
  | 'plug'
  | 'grid'
  | 'clock'
  | 'pen'
  | 'image'
  | 'user'
  | 'book'
  | 'mail'
  | 'chat'
  | 'users'
  | 'search'
  | 'tag'
  | 'file'
  | 'brain';

export interface NavGroup {
  key: GroupKey;
  title: string;
}

export interface NavPage {
  slug: string;
  title: string;
  /** One sentence under the page title. */
  summary: string;
  group: GroupKey;
  icon: IconName;
  /** Shown in the sidebar without expanding "More". */
  primary: boolean;
  /** M01–M24 modules this page operates (for the All tools explorer and coverage checks). */
  modules: string[];
  /** Extra words people search for. */
  keywords: string[];
  /** Small sidebar marker. */
  badge?: 'approvals' | 'incidents' | 'auto';
}

export const GROUPS: NavGroup[] = [
  { key: 'home', title: 'Home' },
  { key: 'journey', title: 'Journey' },
  { key: 'goals', title: 'Goals' },
  { key: 'content', title: 'Content' },
  { key: 'channels', title: 'Channels' },
  { key: 'intelligence', title: 'Apps & Intelligence' },
  { key: 'results', title: 'Results' },
  { key: 'reviews', title: 'Reviews' },
  { key: 'settings', title: 'Settings' },
];

const section = (slug: string) => {
  const s = SECTIONS.find((x) => x.slug === slug);
  if (!s) throw new Error(`unknown catalog section ${slug}`);
  return s;
};

/** A catalog section placed in the navigation (its title and summary come from here). */
function fromSection(slug: string, group: GroupKey, icon: IconName, primary: boolean, title: string, keywords: string[], summary?: string): NavPage {
  const s = section(slug);
  return { slug, title, summary: summary ?? s.summary, group, icon, primary, modules: s.modules, keywords };
}

export const PAGES: NavPage[] = [
  { slug: '', title: 'Home', summary: 'Your growth at a glance: the journey, what needs you, performance, blockers and recent work.', group: 'home', icon: 'home', primary: true, modules: [], keywords: ['dashboard', 'overview', 'start', 'today'] },

  { slug: 'journey', title: 'Growth Journey', summary: 'Seven steps from a secure workspace to a verified growth loop. Steps tick themselves off from your live data.', group: 'journey', icon: 'journey', primary: true, modules: [], keywords: ['rank', 'xp', 'progress', 'steps', 'getting started', 'roadmap'] },
  {
    slug: 'setup',
    title: 'Onboarding & Setup',
    summary: 'What the Autopilot can use: connections, data, evidence, claims, AI and your rules — and the switch that turns it on.',
    group: 'journey',
    icon: 'setup',
    primary: true,
    modules: ['M23', 'M24'],
    keywords: ['readiness', 'onboarding', 'enable autopilot', 'checklist', 'first steps'],
  },

  {
    slug: 'goals',
    title: 'Goals & OKRs',
    summary: 'Say what you want to achieve. Each goal shows its KPI, progress, forecast availability, decisions and execution timeline.',
    group: 'goals',
    icon: 'target',
    primary: true,
    modules: ['M07', 'M08'],
    keywords: ['okr', 'objective', 'kpi', 'target', 'new goal', 'goal history', 'timeline'],
  },
  {
    slug: 'autopilot',
    title: 'Autopilot (Growth Engine)',
    summary: 'The growth engine: what it is doing now, what waits for data or approval, what it finished, and when it runs next.',
    group: 'goals',
    icon: 'autopilot',
    primary: true,
    modules: ['M07', 'M23'],
    keywords: ['engine', 'cycles', 'ai activity', 'run now', 'pause', 'resume', 'blocked'],
    badge: 'auto',
  },
  {
    slug: 'growth-warfare',
    title: 'Growth Warfare',
    summary: 'One control room for market signals, competitor conquest, growth blitzes, acquisition tools, conversion rescue, experiments and learning — every switch starts off.',
    group: 'goals',
    icon: 'target',
    // Under "More" in Goals so the approved sidebar (D-048) is unchanged; reachable from All tools and search.
    primary: false,
    modules: ['M05', 'M07', 'M10', 'M18', 'M20', 'M22', 'M23'],
    keywords: ['growth warfare', 'control room', 'opportunities', 'signals', 'competitor conquest', 'blitz', 'acquisition tools', 'conversion rescue', 'referrals', 'darwin', 'experiments', 'emergency stop', 'aggression'],
  },

  {
    slug: 'content',
    title: 'Content Studio',
    summary: 'Daily lesson posts for your Facebook Page: the plan, each card, what went out and how it did, and community groups.',
    group: 'content',
    icon: 'layers',
    primary: true,
    modules: ['M13', 'M16'],
    keywords: ['studio', 'lessons', 'eps', 'drafts', 'posts', 'curriculum', 'community'],
  },
  { slug: 'calendar', title: 'Content Calendar', summary: "Today's planned content, upcoming posts and the verified publishing history, by day.", group: 'content', icon: 'calendar', primary: true, modules: ['M16'], keywords: ['schedule', 'upcoming', 'published', 'history', 'week', 'plan'] },
  fromSection('creative', 'content', 'pen', false, 'Creative briefs', ['brief', 'copy', 'messages']),
  fromSection('assets', 'content', 'image', false, 'Asset studio', ['media', 'upload', 'rights', 'render', 'video', 'image']),
  fromSection('personas', 'content', 'user', false, 'Synthetic personas', ['persona', 'character', 'disclosure']),
  fromSection('knowledge', 'content', 'book', false, 'Knowledge & claims', ['claims', 'facts', 'brand rules', 'copy check', 'ground truth']),

  {
    slug: 'channels',
    title: 'Channels & Accounts',
    summary: 'Your brands, the accounts and apps each one owns, what every platform can really do now, and which image sources are available.',
    group: 'channels',
    icon: 'share',
    primary: true,
    modules: ['M16', 'M14'],
    keywords: ['brands', 'platforms', 'facebook', 'instagram', 'linkedin', 'x', 'reddit', 'accounts'],
  },
  fromSection('social', 'channels', 'message', true, 'Organic social', ['posts', 'schedule', 'facebook', 'publishing', 'interactions']),
  fromSection('ads', 'channels', 'megaphone', true, 'Campaigns & paid media', ['ads', 'campaigns', 'budget', 'spend', 'paid']),
  fromSection('lifecycle', 'channels', 'mail', false, 'Lifecycle messaging', ['email', 'journeys', 'templates', 'sms']),
  fromSection('conversations', 'channels', 'chat', false, 'Conversations', ['chat', 'widget', 'leads', 'tickets', 'support']),
  fromSection('creators', 'channels', 'users', false, 'Creators & referrals', ['creators', 'influencers', 'referral', 'commission']),
  fromSection('discovery', 'channels', 'search', false, 'SEO, ASO & AI discovery', ['seo', 'aso', 'store listing', 'keywords', 'audit']),
  fromSection('offers', 'channels', 'tag', false, 'Offers & CRO', ['discount', 'pricing', 'conversion', 'cro']),
  {
    slug: 'catalog',
    title: 'Product catalog',
    summary: 'Your Shopify products, prices and stock as of the last sync, which brand each belongs to, and whether each shop can be synced.',
    group: 'channels',
    icon: 'tag',
    primary: false,
    modules: ['M12', 'M03'],
    keywords: ['shopify', 'products', 'inventory', 'stock', 'catalog', 'prices', 'shop', 'sync'],
  },
  {
    slug: 'payouts',
    title: 'Creator payouts',
    summary: 'Creator and affiliate balances, payout readiness, requests, finance approval and reconciliation. Payouts stay off until legal and provider authorization.',
    group: 'channels',
    icon: 'users',
    primary: false,
    modules: ['M22', 'M23'],
    keywords: ['payouts', 'commission', 'affiliate', 'balance', 'paypal', 'kyc', 'tax form', 'finance', 'reconciliation'],
  },
  {
    slug: 'search-console',
    title: 'Search Console',
    summary: 'Google Search Console: the property you read, sync state, clicks, impressions, queries and pages for one reported period, and opportunities to review.',
    group: 'channels',
    icon: 'search',
    primary: false,
    modules: ['M18'],
    keywords: ['google search console', 'gsc', 'seo', 'queries', 'pages', 'impressions', 'clicks', 'ctr', 'position', 'property'],
  },

  {
    slug: 'apps',
    title: 'Apps & Store Reports',
    summary: 'Installs, store listing acquisitions, sources, campaigns and quality for every app, from official Google Play and App Store reports.',
    group: 'intelligence',
    icon: 'phone',
    primary: true,
    modules: ['M19'],
    keywords: ['app intelligence', 'google play', 'app store', 'installs', 'downloads', 'acquisitions', 'developer account', 'reports'],
  },
  fromSection('brain', 'intelligence', 'brain', true, 'Growth Brain', ['decisions', 'agent runs', 'ai', 'expected value']),
  fromSection('market', 'intelligence', 'compass', true, 'Market & Competitors', ['competitors', 'trends', 'ideas', 'backlog']),
  fromSection('analytics', 'intelligence', 'trend', true, 'Forecasts & Analytics', ['forecast', 'mmm', 'media mix', 'metric series', 'kpi']),
  fromSection('app', 'intelligence', 'phone', false, 'App attribution & cohorts', ['install events', 'cohorts', 'attribution', 'app growth', 'conversions']),
  {
    slug: 'attribution',
    title: 'Attribution report',
    summary: 'Store-reported acquisitions beside consented app telemetry for each campaign, per app and brand — never added, with coverage, freshness and what is missing.',
    group: 'intelligence',
    icon: 'trend',
    primary: false,
    modules: ['M19'],
    keywords: ['attribution', 'campaigns', 'utm', 'funnel', 'installs', 'activations', 'store report', 'telemetry', 'first open'],
  },
  fromSection('audiences', 'intelligence', 'users', false, 'Audiences', ['segments', 'snapshots', 'propensity']),
  fromSection('customers', 'intelligence', 'user', false, 'Customers & consent', ['customers', 'consent', 'privacy', 'dsar', 'ingestion key', 'first-party data']),
  fromSection('evidence', 'intelligence', 'file', false, 'Evidence', ['sources', 'reports', 'documents', 'rights', 'freshness']),

  {
    slug: 'results',
    title: 'Performance & Reports',
    summary: 'What improved, what is still uncertain and why: KPIs, charts, goal progress, published content and report coverage.',
    group: 'results',
    icon: 'chart',
    primary: true,
    modules: ['M08', 'M19'],
    keywords: ['performance', 'reports', 'kpi', 'results', 'outcomes', 'coverage'],
  },
  { slug: 'insights', title: 'Insights & Learnings', summary: 'What the Autopilot learned, store signals, Growth Brain decisions and content learning — with their limits stated.', group: 'results', icon: 'bulb', primary: true, modules: ['M07', 'M19'], keywords: ['learnings', 'lessons', 'signals', 'insights'] },
  fromSection('experiments', 'results', 'flask', true, 'Experiments', ['a/b test', 'srm', 'variants', 'outcomes']),

  fromSection(
    'approvals',
    'reviews',
    'check-circle',
    true,
    'Approvals',
    ['approve', 'reject', 'actions', 'verification', 'escalated', 'inbox', 'drafts', 'decisions'],
    'Everything that changes the outside world waits here for a person. Approving signs off the exact action; it only counts as done once an independent check confirms it.',
  ),
  { slug: 'incidents', title: 'Incidents & Alerts', summary: 'Open incidents, unacknowledged alerts and emergency stops, with how to resolve each.', group: 'reviews', icon: 'alert', primary: true, modules: ['M24'], keywords: ['alerts', 'incidents', 'kill switch', 'emergency stop', 'problems'], badge: 'incidents' },
  fromSection('audit', 'reviews', 'file-check', true, 'Audit trail', ['audit', 'log', 'hash chain', 'evidence', 'verify']),
  { slug: 'activity', title: 'Activity log', summary: 'Everything that happened in this organization, in plain language, newest first. Technical records stay one click away.', group: 'reviews', icon: 'clock', primary: false, modules: ['M24'], keywords: ['history', 'events', 'recent', 'timeline'] },

  fromSection('settings', 'settings', 'users', true, 'Organization & Team', ['account', 'security', 'two-factor', '2fa', 'password', 'members', 'invite', 'team', 'organization', 'sign out']),
  fromSection('governance', 'settings', 'shield', true, 'Governance & Security', ['policy', 'autonomy', 'kill switch', 'ai budget', 'models', 'sender identity', 'licences', 'spending limit']),
  fromSection('connections', 'settings', 'plug', false, 'Connections & Credentials', ['connect', 'credentials', 'meta', 'google', 'shopify', 'tokens', 'oauth']),
  { slug: 'tools', title: 'All tools', summary: 'Every FUTUREGROW tool and module in one place, grouped by what it is for.', group: 'settings', icon: 'grid', primary: false, modules: [], keywords: ['advanced', 'modules', 'workspace', 'm01', 'everything'] },
];

export const pageBySlug = (slug: string): NavPage | undefined => PAGES.find((p) => p.slug === slug);

export const pageHref = (slug: string): string => (slug ? `/app/${slug}` : '/app/');

export const groupOf = (key: GroupKey): NavGroup => GROUPS.find((g) => g.key === key)!;

export const pagesIn = (key: GroupKey): NavPage[] => PAGES.filter((p) => p.group === key);

/** Home › Group › Page. */
export function breadcrumbs(slug: string): { title: string; href: string | null }[] {
  const p = pageBySlug(slug);
  if (!p?.slug) return [{ title: 'Home', href: null }];
  const g = groupOf(p.group);
  const first = pagesIn(p.group)[0]!;
  return [
    { title: 'Home', href: '/app/' },
    { title: g.title, href: first.slug === p.slug ? null : pageHref(first.slug) },
    { title: p.title, href: null },
  ];
}

/**
 * Old Autopilot links (`/app/?view=…`) and the former Advanced workspace keep working: they
 * resolve to the same screens in the unified shell.
 */
export const LEGACY_VIEWS: Record<string, string> = {
  setup: 'setup',
  goals: 'goals',
  content: 'content',
  brands: 'channels',
  apps: 'apps',
  activity: 'autopilot',
  approvals: 'approvals',
  results: 'results',
};

export function legacyRedirect(pathname: string, search: string): string | null {
  const view = new URLSearchParams(search).get('view');
  const path = pathname.replace(/\/+$/, '');
  if (path === '/app' && view && LEGACY_VIEWS[view]) return pageHref(LEGACY_VIEWS[view]!);
  if (path === '/app/advanced') return pageHref('tools');
  return null;
}
