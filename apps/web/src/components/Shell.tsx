import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, CHANGED_EVENT, type Me, setTenant } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { type ActionLite, type AlertLite, type GoalLite, type InboxLite, type IncidentLite, type KillSwitchLite, notifications } from '../lib/dashboard.js';
import { relativeTime } from '../lib/format.js';
import { SECTION_FLOWS } from '../lib/journey.js';
import { breadcrumbs, GROUPS, type NavPage, PAGES, pageBySlug, pageHref, pagesIn } from '../lib/nav.js';
import type { AutopilotStatus } from './Autopilot.js';
import { Ico } from './Icons.js';
import { PageTasks, useJourney } from './Journey.js';
import { CommandPalette } from './Search.js';
import { Logo } from './ui.js';

export type Org = { id: string; name: string; slug: string };

/** Every API call the unified shell, Home and the new pages make (checked against the API routes in catalog.test.ts). */
export const UNIFIED_CALLS = [
  '/v1/actions',
  '/v1/autopilot/inbox',
  '/v1/governance/incidents',
  '/v1/governance/alerts',
  '/v1/governance/kill-switches',
  '/v1/governance/policy',
  '/v1/governance/audit',
  '/v1/autopilot/goals',
  '/v1/autopilot/goals/:id',
  '/v1/autopilot/activity',
  '/v1/autopilot/status',
  '/v1/app-intelligence/overview',
  '/v1/app-intelligence/apps/:id',
  '/v1/app-intelligence/accounts',
  '/v1/app-intelligence/signals',
  '/v1/analytics/series',
  '/v1/analytics/series/:id/points',
  '/v1/social/posts',
  '/v1/system/status',
  '/v1/connections',
  '/v1/brands',
  '/v1/brain/decisions',
  '/v1/experiments',
  '/v1/content/programs',
  '/v1/content/programs/:id/overview',
].map((path) => ({ method: 'GET', path }));

/* ------------------------------------------------------------------ */
/* Workspace data: loaded once, shared by header, sidebar and pages    */
/* ------------------------------------------------------------------ */

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  /** True once the request settled (data or error). */
  loaded: boolean;
}

export interface Attention {
  approvals: Loaded<ActionLite[]>;
  escalated: Loaded<ActionLite[]>;
  inbox: Loaded<InboxLite>;
  incidents: Loaded<IncidentLite[]>;
  alerts: Loaded<AlertLite[]>;
  killSwitches: Loaded<KillSwitchLite[]>;
  goals: Loaded<GoalLite[]>;
  at: number;
}

const pending = <T,>(): Loaded<T> => ({ data: null, error: null, loaded: false });
const EMPTY: Attention = { approvals: pending(), escalated: pending(), inbox: pending(), incidents: pending(), alerts: pending(), killSwitches: pending(), goals: pending(), at: 0 };

/** A list the role may not read (403) or an API without the feature (404) counts as empty; other failures stay errors. */
export function listOrEmpty<T>(l: Loaded<T[]>): T[] | null {
  if (!l.loaded) return null;
  if (l.data) return l.data;
  const s = l.error instanceof ApiError ? l.error.status : 0;
  return s === 403 || s === 404 ? [] : null;
}

export function failed(l: Loaded<unknown>): boolean {
  if (!l.loaded || !l.error) return false;
  const s = l.error instanceof ApiError ? l.error.status : 0;
  return s !== 403 && s !== 404;
}

interface Workspace {
  me: Me;
  orgs: Org[];
  autopilot: AutopilotStatus | null;
  refreshAutopilot: () => Promise<void>;
  attention: Attention;
  reloadAttention: () => Promise<void>;
  switchTenant: (id: string) => void;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error('useWorkspace outside WorkspaceProvider');
  return w;
}

const roleIn = (me: Me, roles: string[]) => me.roles.some((r) => roles.includes(r));
export const canEditGoals = (me: Me) => roleIn(me, ['owner', 'admin', 'growth_operator']);
export const isAdmin = (me: Me) => roleIn(me, ['owner', 'admin']);

export function WorkspaceProvider({ me, orgs, autopilot: initialAutopilot, children }: { me: Me; orgs: Org[]; autopilot: AutopilotStatus | null; children: ReactNode }) {
  const [autopilot, setAutopilot] = useState(initialAutopilot);
  const [attention, setAttention] = useState<Attention>(EMPTY);
  const busy = useRef(false);
  const reloadAttention = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const get = <T,>(path: string): Promise<Loaded<T>> =>
      api<T>('GET', path).then(
        (data) => ({ data, error: null, loaded: true }),
        (error) => ({ data: null, error, loaded: true }),
      );
    try {
      const [approvals, escalated, inbox, incidents, alerts, killSwitches, goals] = await Promise.all([
        get<ActionLite[]>('/v1/actions?status=APPROVAL_REQUIRED&limit=200'),
        get<ActionLite[]>('/v1/actions?status=ESCALATED,ROLLBACK_REQUIRED&limit=200'),
        get<InboxLite>('/v1/autopilot/inbox'),
        get<IncidentLite[]>('/v1/governance/incidents'),
        get<AlertLite[]>('/v1/governance/alerts'),
        get<KillSwitchLite[]>('/v1/governance/kill-switches'),
        get<GoalLite[]>('/v1/autopilot/goals'),
      ]);
      setAttention({ approvals, escalated, inbox, incidents, alerts, killSwitches, goals, at: Date.now() });
    } finally {
      busy.current = false;
    }
  }, []);
  const refreshAutopilot = useCallback(async () => {
    setAutopilot(await api<AutopilotStatus>('GET', '/v1/autopilot/status').catch(() => null));
  }, []);

  useEffect(() => {
    void reloadAttention();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reloadAttention(), 800);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void reloadAttention();
    };
    // A light refresh while the tab is visible, so new approvals reach the bell without a reload.
    const tick = window.setInterval(onVisible, 120_000);
    window.addEventListener(CHANGED_EVENT, onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      window.clearInterval(tick);
      window.removeEventListener(CHANGED_EVENT, onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadAttention]);

  const switchTenant = useCallback((id: string) => {
    setTenant(id);
    // A full reload drops every cached summary, search index and journey snapshot of the previous organization.
    window.location.href = '/app/';
  }, []);

  const value = useMemo<Workspace>(() => ({ me, orgs, autopilot, refreshAutopilot, attention, reloadAttention, switchTenant }), [me, orgs, autopilot, refreshAutopilot, attention, reloadAttention, switchTenant]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** Counts for sidebar badges; null while loading. */
export function useCounts(): { approvals: number | null; incidents: number | null } {
  const { attention: a } = useWorkspace();
  const approvals = a.approvals.loaded ? (a.approvals.data?.length ?? 0) + (a.inbox.data ? a.inbox.data.decisions.length + a.inbox.data.drafts.length + (a.inbox.data.postDrafts?.length ?? 0) : 0) : null;
  const incidents = a.incidents.loaded && a.alerts.loaded ? (a.incidents.data ?? []).filter((i) => i.status === 'open').length + (a.alerts.data?.length ?? 0) : null;
  return { approvals, incidents };
}

/* ------------------------------------------------------------------ */
/* Dismissable popovers                                                */
/* ------------------------------------------------------------------ */

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, ref, button };
}

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

function OrgSwitcher({ id }: { id: string }) {
  const { me, orgs, switchTenant } = useWorkspace();
  return (
    <div className="org-switch">
      <label htmlFor={id}>Organization</label>
      <div className="org-select">
        <Ico name="building" size={17} />
        <select id={id} value={me.tenantId} onChange={(e) => switchTenant(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <Ico name="chevron-down" size={16} className="org-chevron" />
      </div>
    </div>
  );
}

interface QuickAction {
  label: string;
  hint: string;
  href: string;
  icon: Parameters<typeof Ico>[0]['name'];
  roles?: string[];
}

export const QUICK_ACTIONS: QuickAction[] = [
  { label: 'New growth goal', hint: 'Describe it in one sentence', href: '/app/goals#new', icon: 'target', roles: ['owner', 'admin', 'growth_operator'] },
  { label: 'Review approvals', hint: 'Actions and drafts waiting', href: '/app/approvals', icon: 'check-circle' },
  { label: 'Plan content', hint: 'Content studio and calendar', href: '/app/content', icon: 'layers' },
  { label: 'Connect an account', hint: 'Meta, Google, Shopify…', href: '/app/connections', icon: 'plug', roles: ['owner', 'admin'] },
  { label: 'Connect a developer account', hint: 'Google Play or App Store Connect', href: '/app/apps?tab=accounts', icon: 'phone', roles: ['owner', 'admin'] },
  { label: 'Add evidence', hint: 'A report, dataset or document', href: '/app/evidence', icon: 'file' },
  { label: 'Invite a teammate', hint: 'A second person to approve', href: '/app/settings#members', icon: 'users', roles: ['owner', 'admin'] },
];

export const allowedQuickActions = (me: Me) => QUICK_ACTIONS.filter((q) => !q.roles || roleIn(me, q.roles));

function QuickActions() {
  const { me } = useWorkspace();
  const p = usePopover();
  const items = allowedQuickActions(me);
  return (
    <div className="popover-wrap" ref={p.ref}>
      <button type="button" ref={p.button} className="btn primary quick-btn" aria-haspopup="menu" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)}>
        <Ico name="plus" size={18} />
        <span className="quick-label">Quick action</span>
        <Ico name="chevron-down" size={16} className="quick-chevron" />
      </button>
      {p.open ? (
        <div className="popover menu" role="menu" aria-label="Quick actions">
          {items.map((q) => (
            <a key={q.label} role="menuitem" href={q.href} className="menu-item">
              <span className="menu-icon">
                <Ico name={q.icon} size={17} />
              </span>
              <span>
                <strong>{q.label}</strong>
                <span className="menu-hint">{q.hint}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Notifications() {
  const { me, attention: a } = useWorkspace();
  const p = usePopover();
  const loaded = a.approvals.loaded && a.escalated.loaded && a.incidents.loaded && a.alerts.loaded;
  const list = notifications({ approvals: a.approvals.data, escalated: a.escalated.data, inbox: a.inbox.data, incidents: a.incidents.data, alerts: a.alerts.data, userId: me.userId });
  const urgent = list.filter((n) => n.tone !== 'info').length;
  const label = !loaded ? 'Notifications (checking…)' : list.length ? `Notifications: ${list.length} item${list.length === 1 ? '' : 's'}${urgent ? `, ${urgent} need you` : ''}` : 'Notifications: nothing new';
  return (
    <div className="popover-wrap" ref={p.ref}>
      <button type="button" ref={p.button} className="icon-btn" aria-label={label} aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)}>
        <Ico name="bell" size={21} />
        {loaded && list.length ? <span className={`dot${urgent ? '' : ' quiet'}`} aria-hidden="true" /> : null}
      </button>
      {p.open ? (
        <div className="popover notif" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <strong>Notifications</strong>
            <a href="/app/activity">Activity log</a>
          </div>
          {!loaded ? (
            <p className="popover-empty">Checking for approvals and alerts…</p>
          ) : list.length === 0 ? (
            <p className="popover-empty">
              <Ico name="check-circle" size={18} /> Nothing needs you right now.
            </p>
          ) : (
            <ul className="notif-list">
              {list.slice(0, 12).map((n) => (
                <li key={n.id}>
                  <a href={n.href} className={`notif-item ${n.tone}`}>
                    <span className="notif-mark" aria-hidden="true" />
                    <span className="notif-body">
                      <strong>{n.title}</strong>
                      {n.detail ? <span className="notif-detail">{n.detail}</span> : null}
                      <span className="notif-time">{relativeTime(n.at)}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {list.length > 12 ? (
            <a className="popover-foot" href="/app/approvals">
              See everything waiting ({list.length})
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Help({ page }: { page: NavPage }) {
  const p = usePopover();
  const flow = SECTION_FLOWS[page.slug];
  return (
    <div className="popover-wrap" ref={p.ref}>
      <button type="button" ref={p.button} className="icon-btn" aria-label="Help for this page" aria-haspopup="dialog" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)}>
        <Ico name="help" size={21} />
      </button>
      {p.open ? (
        <div className="popover help" role="dialog" aria-label="Help">
          <div className="popover-head">
            <strong>{page.title}</strong>
          </div>
          <p className="small">{page.summary}</p>
          {flow ? (
            <>
              <div className="eyebrow">How this works</div>
              <ol className="help-steps">
                {flow.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          ) : null}
          <div className="eyebrow">Shortcuts</div>
          <ul className="help-keys small">
            <li>
              <kbd>Ctrl</kbd> + <kbd>K</kbd> (<kbd>⌘</kbd> + <kbd>K</kbd> on Mac) — search everything
            </li>
            <li>
              <kbd>Esc</kbd> — close menus and dialogs
            </li>
          </ul>
          <div className="help-links">
            <a href="/app/journey">Growth Journey</a>
            <a href="/app/tools">All tools</a>
            <a href="/app/setup">Onboarding &amp; Setup</a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const initials = (me: Me) => {
  const base = (me.email ?? 'FG').split('@')[0]!.replace(/[^a-z0-9]/gi, '');
  return (base.slice(0, 2) || 'FG').toUpperCase();
};

function UserMenu() {
  const { me } = useWorkspace();
  const p = usePopover();
  const signOut = async () => {
    await authClient.signOut();
    window.location.href = '/login';
  };
  return (
    <div className="popover-wrap" ref={p.ref}>
      <button type="button" ref={p.button} className="user-btn" aria-label={`Account menu for ${me.email ?? 'you'}`} aria-haspopup="menu" aria-expanded={p.open} onClick={() => p.setOpen(!p.open)}>
        <span className="avatar" aria-hidden="true">
          {initials(me)}
        </span>
        <Ico name="chevron-down" size={16} />
      </button>
      {p.open ? (
        <div className="popover menu user" role="menu" aria-label="Account">
          <div className="user-card">
            <span className="avatar lg" aria-hidden="true">
              {initials(me)}
            </span>
            <span>
              <strong>{me.email ?? 'Signed in'}</strong>
              <span className="menu-hint">
                Roles: <span className="who">{me.roles.join(', ')}</span>
              </span>
              <span className="menu-hint">{me.mfaVerified ? 'Two-factor session' : 'Two-factor not active'}</span>
            </span>
          </div>
          <a role="menuitem" className="menu-item" href="/app/settings">
            <span className="menu-icon">
              <Ico name="lock" size={17} />
            </span>
            <span>
              <strong>Account &amp; security</strong>
            </span>
          </a>
          <a role="menuitem" className="menu-item" href="/app/governance">
            <span className="menu-icon">
              <Ico name="shield" size={17} />
            </span>
            <span>
              <strong>Governance &amp; Security</strong>
            </span>
          </a>
          <button type="button" role="menuitem" className="menu-item" onClick={() => void signOut()}>
            <span className="menu-icon">
              <Ico name="logout" size={17} />
            </span>
            <span>
              <strong>Sign out</strong>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Header({ page, onMenu, menuOpen, onSearch }: { page: NavPage; onMenu: () => void; menuOpen: boolean; onSearch: () => void }) {
  return (
    <header className="app-header">
      <div className="header-brand">
        <button type="button" className="icon-btn menu-toggle" aria-label="Menu" aria-expanded={menuOpen} aria-controls="app-nav" onClick={onMenu}>
          <Ico name="menu" size={22} />
        </button>
        <a className="brand" href="/app/" aria-label="FUTUREGROW home">
          <Logo size={38} />
          <span className="brand-text">
            <span className="brand-name">FUTUREGROW</span>
            <span className="brand-sub">Growth Operating System</span>
          </span>
        </a>
      </div>
      <div className="header-main">
        <div className="header-org">
          <OrgSwitcher id="org" />
        </div>
        <button type="button" className="search-box" onClick={onSearch} aria-label="Search goals, content, apps, reports and settings (Ctrl+K)">
          <Ico name="search" size={19} />
          <span className="search-placeholder">Search goals, content, apps, reports, settings…</span>
          <span className="search-keys" aria-hidden="true">
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </span>
        </button>
        <div className="header-actions">
          <button type="button" className="icon-btn search-mobile" aria-label="Search" onClick={onSearch}>
            <Ico name="search" size={21} />
          </button>
          <QuickActions />
          <Notifications />
          <Help page={page} />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

const MORE_KEY = 'fg.nav.more';

function readOpenGroups(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MORE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function Sidebar({ current, open, onClose }: { current: string; open: boolean; onClose: () => void }) {
  const counts = useCounts();
  const { autopilot } = useWorkspace();
  const currentPage = pageBySlug(current);
  const [expanded, setExpanded] = useState<string[]>(() => readOpenGroups());
  const toggle = (key: string) => {
    const next = expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key];
    setExpanded(next);
    try {
      localStorage.setItem(MORE_KEY, JSON.stringify(next));
    } catch {
      /* the choice is simply not remembered */
    }
  };
  const badge = (p: NavPage) => {
    if (p.badge === 'approvals' || p.slug === 'approvals')
      return (
        <span className={`nav-count${counts.approvals ? ' on' : ''}`}>
          <span aria-hidden="true">{counts.approvals ?? '·'}</span>
          <span className="sr-only">{counts.approvals === null ? '(checking)' : `(${counts.approvals} waiting)`}</span>
        </span>
      );
    if (p.badge === 'incidents')
      return (
        <span className={`nav-count${counts.incidents ? ' warn' : ''}`}>
          <span aria-hidden="true">{counts.incidents ?? '·'}</span>
          <span className="sr-only">{counts.incidents === null ? '(checking)' : `(${counts.incidents} open)`}</span>
        </span>
      );
    if (p.badge === 'auto') return <span className={`nav-pill${autopilot?.enabled ? '' : ' off'}`}>{autopilot?.enabled ? (autopilot.stopped ? 'Stopped' : 'Auto') : 'Off'}</span>;
    return null;
  };
  const link = (p: NavPage) => (
    <a key={p.slug} href={pageHref(p.slug)} className="nav-link" aria-current={p.slug === current ? 'page' : undefined}>
      <Ico name={p.icon} size={19} />
      <span className="nav-title">{p.title}</span>
      {badge(p)}
    </a>
  );
  return (
    <nav id="app-nav" className={`app-nav${open ? ' open' : ''}`} aria-label="Main">
      <div className="nav-mobile-head">
        <OrgSwitcher id="org-mobile" />
        <button type="button" className="icon-btn" aria-label="Close menu" onClick={onClose}>
          <Ico name="x" size={20} />
        </button>
      </div>
      {GROUPS.map((g) => {
        const pages = pagesIn(g.key);
        const primary = pages.filter((p) => p.primary);
        const more = pages.filter((p) => !p.primary);
        const isOpen = expanded.includes(g.key) || (currentPage?.group === g.key && !currentPage.primary);
        return (
          <div key={g.key} className="nav-group">
            {g.key !== 'home' ? <div className="nav-heading">{g.title}</div> : null}
            {primary.map(link)}
            {more.length ? (
              <>
                {isOpen ? more.map(link) : null}
                <button type="button" className="nav-more" aria-expanded={isOpen} onClick={() => toggle(g.key)}>
                  <Ico name={isOpen ? 'chevron-down' : 'chevron-right'} size={15} />
                  {isOpen ? 'Fewer' : `More ${g.title.toLowerCase()} tools (${more.length})`}
                </button>
              </>
            ) : null}
          </div>
        );
      })}
      <a className="nav-all" href="/app/tools">
        <Ico name="grid" size={18} /> All tools ({PAGES.length - 1})
      </a>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Page frame                                                          */
/* ------------------------------------------------------------------ */

function PageHeader({ page }: { page: NavPage }) {
  const crumbs = breadcrumbs(page.slug);
  return (
    <div className="page-head">
      <nav aria-label="Breadcrumb" className="crumbs">
        <ol>
          {crumbs.map((c, i) => (
            <li key={c.title}>{c.href ? <a href={c.href}>{c.title}</a> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined}>{c.title}</span>}</li>
          ))}
        </ol>
      </nav>
      <h1>{page.title}</h1>
      <p className="page-summary">{page.summary}</p>
    </div>
  );
}

/** "How this works" and the journey steps done on this page, folded away once done. */
function PageGuide({ slug }: { slug: string }) {
  const flow = SECTION_FLOWS[slug];
  const j = useJourney();
  const tasks = j ? j.view.stages.flatMap((s) => s.stage.tasks).filter((t) => t.section === slug) : [];
  const nextHere = Boolean(j?.loaded && j.view.next?.section === slug);
  if (!flow && !tasks.length) return null;
  return (
    <details className="page-guide" open={nextHere}>
      <summary>
        <Ico name="info" size={17} />
        <span>How this works{tasks.length ? ' · journey steps on this page' : ''}</span>
        {nextHere ? <span className="pill now">Your next step is here</span> : null}
        <Ico name="chevron-down" size={16} className="guide-chevron" />
      </summary>
      {flow ? (
        <ol className="flow" aria-label="How this works">
          {flow.map((s, i) => (
            <li key={s}>
              <span className="flow-step">
                <span className="flow-n">{i + 1}</span>
                <span>{s}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {tasks.length ? <PageTasks slug={slug} /> : null}
    </details>
  );
}

export function AppShell({ slug, children }: { slug: string; children: ReactNode }) {
  const page = pageBySlug(slug) ?? PAGES[0]!;
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    document.body.classList.toggle('nav-locked', menuOpen);
  }, [menuOpen]);

  return (
    <div className="app">
      <Header page={page} menuOpen={menuOpen} onMenu={() => setMenuOpen((v) => !v)} onSearch={() => setSearchOpen(true)} />
      <div className="app-body">
        <Sidebar current={page.slug} open={menuOpen} onClose={() => setMenuOpen(false)} />
        {menuOpen ? <button type="button" className="nav-backdrop" aria-label="Close menu" tabIndex={-1} onClick={() => setMenuOpen(false)} /> : null}
        <main className={`app-main${page.slug ? '' : ' home'}`} id="content">
          {page.slug ? (
            <>
              <PageHeader page={page} />
              <PageGuide slug={page.slug} />
            </>
          ) : null}
          {children}
        </main>
      </div>
      {searchOpen ? <CommandPalette onClose={() => setSearchOpen(false)} /> : null}
    </div>
  );
}

export { OrgSwitcher };
