import { useCallback, useEffect, useState } from 'react';
import { api, getTenant, type Me, setTenant } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { SECTION_GROUPS, SECTIONS, sectionBySlug } from '../lib/catalog.js';
import { STAGES, stageOf } from '../lib/journey.js';
import { Approvals } from './Approvals.js';
import { Connections } from './Connections.js';
import { Governance } from './Governance.js';
import { GroundTruth } from './GroundTruth.js';
import { Icon, JourneyProvider, SectionPager, SidebarRank, StageBanner, sectionHref, sectionState, useJourney } from './Journey.js';
import { ResourcePanel } from './ResourcePanel.js';
import { ErrorNotice, Logo } from './ui.js';
import { AssetUpload, Audit, Overview, Settings } from './Views.js';

type Org = { id: string; name: string; slug: string };

export function ControlPlane({ section }: { section: string }) {
  const [me, setMe] = useState<Me | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const current = sectionBySlug(section) ?? SECTIONS[0]!;

  const boot = useCallback(async () => {
    setError(null);
    const session = await authClient.getSession();
    if (!session.data) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      return;
    }
    const list = await authClient.organization.list();
    const all = (list.data ?? []) as Org[];
    setOrgs(all);
    if (all.length === 0) return;
    const chosen = all.find((o) => o.id === getTenant())?.id ?? all[0]!.id;
    setTenant(chosen);
    try {
      setMe(await api<Me>('GET', '/v1/me'));
    } catch (err) {
      setError(err);
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  const switchTenant = (id: string) => {
    setTenant(id);
    window.location.reload();
  };

  if (orgs && orgs.length === 0) return <NoOrganization onCreated={switchTenant} />;
  if (!me) {
    return (
      <main className="auth-box" id="content">
        <div className="auth-brand">
          <Logo /> FUTUREGROW
        </div>
        {error ? <ErrorNotice error={error} /> : <p className="muted loading">Loading your workspace…</p>}
      </main>
    );
  }

  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const stage = stageOf(current.slug);
  return (
    <JourneyProvider me={me}>
      <div className="shell">
        <Sidebar current={current.slug} open={menuOpen} />
        {menuOpen ? <button type="button" className="nav-backdrop" aria-label="Close menu" tabIndex={-1} onClick={() => setMenuOpen(false)} /> : null}
        <main className="main" id="content">
          <div className="topbar">
            <div className="topbar-title">
              <button type="button" className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
                Menu
              </button>
              <div>
                <div className="eyebrow">{stage ? `Stage ${stage.n} of ${STAGES.length} · ${stage.title}` : current.slug === 'overview' ? 'Your growth journey' : 'Today'}</div>
                <h1>{current.title}</h1>
                <p className="summary">{current.summary}</p>
              </div>
            </div>
            <div className="org-box">
              <label htmlFor="org">Organization</label>
              <select id="org" value={me.tenantId} onChange={(e) => switchTenant(e.target.value)}>
                {(orgs ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <span className="who" title="Your roles in this organization">
                {me.roles.join(', ')}
              </span>
            </div>
          </div>
          <ErrorNotice error={error} />
          {current.slug !== 'overview' ? <StageBanner slug={current.slug} /> : null}
          <div className="content">
            {current.custom === 'overview' ? <Overview me={me} /> : null}
            {current.custom === 'approvals' ? <Approvals initialId={params.get('id')} /> : null}
            {current.custom === 'governance' ? <Governance /> : null}
            {current.custom === 'audit' ? <Audit /> : null}
            {current.custom === 'settings' ? <Settings me={me} onTenant={switchTenant} onChanged={() => void boot()} /> : null}
            {current.custom === 'assets' ? <AssetUpload /> : null}
            {current.custom === 'connections' ? <Connections me={me} /> : null}
            {current.custom === 'knowledge' ? <GroundTruth /> : current.resources.map((r) => <ResourcePanel key={r.title} resource={r} />)}
          </div>
          <SectionPager slug={current.slug} />
        </main>
      </div>
    </JourneyProvider>
  );
}

function Sidebar({ current, open }: { current: string; open: boolean }) {
  const j = useJourney();
  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Modules">
      <a className="brand" href="/app/">
        <Logo size={26} />
        <span>FUTUREGROW</span>
        <small>beta</small>
      </a>
      <SidebarRank />
      {SECTION_GROUPS.map((g) => {
        const entry = g.stage && j ? j.view.stages.find((s) => s.stage.n === g.stage) : undefined;
        const state = entry && j?.loaded ? entry.state : 'upcoming';
        return (
          <div className={`nav-group${g.stage ? ` stage ${state}` : ''}`} key={g.title}>
            {g.stage ? (
              <div className="nav-stage-head">
                <span className="nav-stage-num" aria-hidden="true">
                  {state === 'done' ? <Icon name="check" size={12} /> : g.stage}
                </span>
                <span className="nav-stage-title">{g.title}</span>
                {entry ? (
                  <span className="nav-stage-count" title="Stage tasks done">
                    {entry.done}/{entry.stage.tasks.length}
                  </span>
                ) : null}
              </div>
            ) : (
              <h4>{g.title}</h4>
            )}
            {g.slugs.map((slug) => {
              const s = sectionBySlug(slug)!;
              const mark = sectionState(slug, j);
              return (
                <a key={slug} href={sectionHref(slug)} aria-current={slug === current ? 'page' : undefined}>
                  <span>{s.title}</span>
                  {slug === 'approvals' && j?.pending ? (
                    <span className="count" title="Waiting for approval">
                      {j.pending}
                    </span>
                  ) : mark === 'next' ? (
                    <span className="mark next" title="Your next step is here">
                      Next
                    </span>
                  ) : mark === 'done' ? (
                    <span className="mark done" title="Done">
                      <Icon name="check" size={12} />
                    </span>
                  ) : null}
                </a>
              );
            })}
          </div>
        );
      })}
    </nav>
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
