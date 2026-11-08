import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, getTenant, type Me, setTenant } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { sectionBySlug } from '../lib/catalog.js';
import { legacyRedirect, pageBySlug } from '../lib/nav.js';
import { AppConversions } from './AppConversions.js';
import { AppIntelligenceView } from './AppIntelligence.js';
import { Approvals } from './Approvals.js';
import { ApprovalsInbox, AutopilotCenter, AutopilotOffer, type AutopilotStatus, GoalsView } from './Autopilot.js';
import { BrandStudioView } from './BrandStudio.js';
import { CampaignDrafts, SocialAnalytics } from './ChannelGrowth.js';
import { Connections, IntegrationStatus } from './Connections.js';
import { ContentStudioView } from './ContentStudio.js';
import { Governance } from './Governance.js';
import { GroundTruth } from './GroundTruth.js';
import { Home } from './Home.js';
import { JourneyProvider } from './Journey.js';
import { MediaStudio } from './MediaStudio.js';
import { ActivityPage, CalendarPage, IncidentsPage, InsightsPage, JourneyPage, ResultsPage, SetupPage, ToolsPage } from './Pages.js';
import { ComplianceChecklist, ResearchSandbox } from './Readiness.js';
import { ResourcePanel } from './ResourcePanel.js';
import { AppShell, isAdmin, type Org, useWorkspace, WorkspaceProvider } from './Shell.js';
import { ErrorNotice, Logo } from './ui.js';
import { AssetUpload, Audit, Settings } from './Views.js';

/**
 * The whole signed-in product (D-048): one shell — header, sidebar, search, breadcrumbs — for
 * the Home dashboard, the Autopilot and every module section. `section` is the page slug
 * ('' or 'overview' is Home).
 */
export function ControlPlane({ section }: { section: string; mode?: 'auto' | 'classic' }) {
  const [me, setMe] = useState<Me | null>(null);
  const [autopilot, setAutopilot] = useState<AutopilotStatus | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const slug = section === 'overview' ? '' : section;

  /**
   * Who is signed in, in which organization. `/v1/me` answers both (it carries every membership),
   * so an ordinary page load makes no call to the rate-limited /api/auth routes. The organization
   * list is read only when no organization is selected yet (or the stored one is no longer valid),
   * and a failed list is an error with a retry, never "you have no organization".
   */
  const boot = useCallback(async () => {
    setError(null);
    const toLogin = () => {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    };
    const fetchStatus = () => api<AutopilotStatus>('GET', '/v1/autopilot/status').catch(() => null);
    // Asked in parallel only when the organization is already known; otherwise after it is resolved.
    const startTenant = getTenant();
    const early = startTenant ? fetchStatus() : null;
    const readMe = () =>
      api<Me>('GET', '/v1/me').then(
        (m) => m,
        (err: unknown) => err as Error,
      );
    let result = await readMe();
    if (result instanceof ApiError && result.status === 401) return toLogin();
    if (result instanceof ApiError && (result.status === 400 || result.status === 403)) {
      // No organization selected, or the stored one is not this user's: choose from the list.
      setTenant(null);
      const list = await authClient.organization.list();
      if (list.error) {
        if (list.error.status === 401) return toLogin();
        setError(new ApiError(list.error.message ?? 'Your organizations could not be loaded. Try again in a moment.', list.error.status ?? 0, null, null));
        return;
      }
      const all = (list.data ?? []) as Org[];
      if (all.length === 0) {
        setOrgs([]);
        return;
      }
      setTenant(all[0]!.id);
      result = await readMe();
    }
    if (result instanceof Error) {
      setError(result);
      return;
    }
    const m = result as Me;
    setTenant(m.tenantId);
    setOrgs(m.memberships.map((x) => ({ id: x.organizationId, name: x.name, slug: x.slug })));
    // An API without the Autopilot (older deploy) simply has no Autopilot pages content.
    setAutopilot(await (early && startTenant === m.tenantId ? early : fetchStatus()));
    setMe(m);
  }, []);

  useEffect(() => {
    // Old links (/app/?view=goals, /app/advanced) land on the same screens in the unified shell.
    const to = legacyRedirect(window.location.pathname, window.location.search);
    if (to) {
      window.location.replace(to);
      return;
    }
    void boot();
  }, [boot]);

  const switchTenant = (id: string) => {
    setTenant(id);
    window.location.href = '/app/';
  };

  if (orgs && orgs.length === 0) return <NoOrganization onCreated={switchTenant} />;
  if (!me) {
    return (
      <main className="auth-box" id="content">
        <div className="auth-brand">
          <Logo /> FUTUREGROW
        </div>
        {error ? (
          <>
            <ErrorNotice error={error} />
            <button type="button" className="primary" onClick={() => void boot()}>
              Try again
            </button>
          </>
        ) : (
          <p className="muted loading">Loading your workspace…</p>
        )}
      </main>
    );
  }
  return (
    <WorkspaceProvider me={me} orgs={orgs ?? []} autopilot={autopilot}>
      <JourneyProvider me={me}>
        <AppShell slug={pageBySlug(slug) ? slug : ''}>
          <PageContent slug={slug} onBoot={() => void boot()} />
        </AppShell>
      </JourneyProvider>
    </WorkspaceProvider>
  );
}

function PageContent({ slug, onBoot }: { slug: string; onBoot: () => void }) {
  const { me, autopilot, refreshAutopilot, switchTenant, reloadAttention } = useWorkspace();
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const enabled = () => {
    void refreshAutopilot();
    void reloadAttention();
  };
  switch (slug) {
    case '':
      return <Home />;
    case 'journey':
      return <JourneyPage />;
    case 'setup':
      return <SetupPage />;
    case 'goals':
      return <GoalsView me={me} autopilot={autopilot} onEnabled={enabled} />;
    case 'autopilot':
      return (
        <>
          {autopilot?.available && !autopilot.enabled && !isAdmin(me) ? <AutopilotOffer me={me} onEnabled={enabled} /> : null}
          <AutopilotCenter me={me} status={autopilot} onStatus={enabled} />
        </>
      );
    case 'content':
      return <ContentStudioView me={me} />;
    case 'calendar':
      return <CalendarPage />;
    case 'channels':
      return <BrandStudioView me={me} />;
    case 'apps':
      return <AppIntelligenceView me={me} initialApp={params.get('app')} initialTab={params.get('tab') === 'accounts' ? 'accounts' : 'apps'} />;
    case 'results':
      return (
        <>
          <ResultsPage />
          <SocialAnalytics me={me} />
        </>
      );
    case 'insights':
      return <InsightsPage />;
    case 'incidents':
      return <IncidentsPage autopilot={autopilot} />;
    case 'activity':
      return <ActivityPage />;
    case 'tools':
      return <ToolsPage />;
    case 'approvals':
      return (
        <div className="stack">
          <ApprovalsInbox me={me} onChange={() => void reloadAttention()} withActions={false} />
          <div className="section-head">
            <h2>Actions</h2>
            <p className="small muted">Approving signs off the exact action (it is bound to its hash) and needs a two-factor session. Whoever proposed an action can never approve it.</p>
          </div>
          <Approvals initialId={params.get('id')} initialTab={params.get('tab')} />
        </div>
      );
    default:
      return <SectionContent slug={slug} onBoot={onBoot} onTenant={switchTenant} />;
  }
}

function SectionContent({ slug, onBoot, onTenant }: { slug: string; onBoot: () => void; onTenant: (id: string) => void }) {
  const { me } = useWorkspace();
  const s = sectionBySlug(slug);
  if (!s) return <ErrorNotice error={new Error('This page does not exist. Use search (Ctrl+K) or All tools to find what you need.')} />;
  return (
    <div className="content">
      {s.custom === 'governance' ? (
        <>
          <Governance />
          <ComplianceChecklist me={me} />
        </>
      ) : null}
      {s.slug === 'market' ? <ResearchSandbox me={me} /> : null}
      {s.custom === 'audit' ? <Audit /> : null}
      {s.custom === 'settings' ? <Settings me={me} onTenant={onTenant} onChanged={onBoot} /> : null}
      {s.custom === 'assets' ? (
        <>
          <AssetUpload />
          <MediaStudio />
        </>
      ) : null}
      {s.custom === 'connections' ? (
        <>
          <IntegrationStatus />
          <Connections me={me} />
        </>
      ) : null}
      {s.slug === 'app' ? <AppConversions /> : null}
      {s.slug === 'ads' ? <CampaignDrafts me={me} /> : null}
      {s.custom === 'knowledge' ? <GroundTruth /> : s.resources.map((r) => <ResourcePanel key={r.title} resource={r} />)}
    </div>
  );
}

function NoOrganization({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<unknown>(null);
  const create = async () => {
    const r = await authClient.organization.create({ name, slug });
    if (r.error) return setError(new Error(r.error.message ?? 'could not create organization'));
    if (r.data?.id) onCreated(r.data.id);
  };
  return (
    <main className="auth-box" id="content">
      <div className="auth-brand">
        <Logo /> FUTUREGROW
      </div>
      <h1>Create your organization</h1>
      <p className="small muted">You are not a member of any organization yet. Ask an owner for an invitation, or create one. Your growth journey starts right after.</p>
      <div className="field">
        <label htmlFor="n">Name</label>
        <input id="n" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="s">Slug</label>
        <input id="s" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
      </div>
      <ErrorNotice error={error} />
      <button type="button" className="primary" disabled={!name || slug.length < 3} onClick={() => void create()}>
        Create organization
      </button>
    </main>
  );
}
