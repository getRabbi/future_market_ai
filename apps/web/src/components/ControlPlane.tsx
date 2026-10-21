import { useCallback, useEffect, useState } from 'react';
import { api, getTenant, type Me, setTenant } from '../lib/api.js';
import { authClient } from '../lib/auth.js';
import { SECTION_GROUPS, SECTIONS, sectionBySlug } from '../lib/catalog.js';
import { Approvals } from './Approvals.js';
import { Connections } from './Connections.js';
import { Governance } from './Governance.js';
import { ResourcePanel } from './ResourcePanel.js';
import { ErrorNotice } from './ui.js';
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
        {error ? <ErrorNotice error={error} /> : <p className="muted">Loading the control plane…</p>}
      </main>
    );
  }

  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  return (
    <div className="shell">
      <nav className={`sidebar${menuOpen ? ' open' : ''}`} aria-label="Modules">
        <div className="brand">
          FUTUREGROW <small>beta</small>
        </div>
        {SECTION_GROUPS.map((g) => (
          <div className="nav-group" key={g.title}>
            <h4>{g.title}</h4>
            {g.slugs.map((slug) => {
              const s = sectionBySlug(slug)!;
              return (
                <a key={slug} href={`/app/${slug === 'overview' ? '' : slug}`} aria-current={slug === current.slug ? 'page' : undefined}>
                  <span>{s.title}</span>
                  <span className="mods">{s.modules.join(' ')}</span>
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <main className="main" id="content">
        <div className="topbar">
          <div className="row">
            <button type="button" className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              Menu
            </button>
            <div>
              <h1>{current.title}</h1>
              <p className="small muted" style={{ margin: 0, maxWidth: '48rem' }}>
                {current.summary}
              </p>
            </div>
          </div>
          <div className="row">
            <label htmlFor="org" className="small muted" style={{ margin: 0 }}>
              Organization
            </label>
            <select id="org" value={me.tenantId} onChange={(e) => switchTenant(e.target.value)} style={{ width: 'auto' }}>
              {(orgs ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <span className="who">{me.roles.join(', ')}</span>
          </div>
        </div>
        <ErrorNotice error={error} />
        {current.custom === 'overview' ? <Overview me={me} /> : null}
        {current.custom === 'approvals' ? <Approvals initialId={params.get('id')} /> : null}
        {current.custom === 'governance' ? <Governance /> : null}
        {current.custom === 'audit' ? <Audit /> : null}
        {current.custom === 'settings' ? <Settings me={me} onTenant={switchTenant} /> : null}
        {current.custom === 'assets' ? <AssetUpload /> : null}
        {current.custom === 'connections' ? <Connections me={me} /> : null}
        {current.resources.map((r) => (
          <ResourcePanel key={r.title} resource={r} />
        ))}
      </main>
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
      <h1>Create your organization</h1>
      <p className="small muted">You are not a member of any organization yet. Ask an owner for an invitation, or create one.</p>
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
