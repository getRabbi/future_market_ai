import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { appItems, approvalItems, brandItems, channelItems, goalItems, postItems, type ResultKind, rank, type SearchItem, staticItems } from '../lib/search.js';
import { type AnyIcon, Ico } from './Icons.js';
import { allowedQuickActions, useWorkspace } from './Shell.js';

/** Records are fetched once per organization and page load; switching organization reloads the page, which drops them. */
let cache: { tenant: string; items: SearchItem[]; done: boolean } | null = null;

const KIND_ICON: Record<ResultKind, AnyIcon> = { Pages: 'grid', Actions: 'bolt', Goals: 'target', Apps: 'phone', Brands: 'tag', Channels: 'share', Content: 'layers', Approvals: 'check-circle', Help: 'help' };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { me } = useWorkspace();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<SearchItem[]>(() => (cache?.tenant === me.tenantId ? cache.items : []));
  const [loading, setLoading] = useState(!(cache?.tenant === me.tenantId && cache.done));
  const input = useRef<HTMLInputElement | null>(null);
  const restore = useRef<HTMLElement | null>(typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);
  const listId = useId();

  useEffect(() => {
    input.current?.focus();
    const prev = restore.current;
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    if (cache?.tenant === me.tenantId && cache.done) return;
    let live = true;
    const get = <T,>(path: string) => api<T>('GET', path).catch(() => null);
    void Promise.all([
      get<Record<string, unknown>[]>('/v1/autopilot/goals').then((r) => goalItems(r ?? [])),
      get<{ apps?: Record<string, unknown>[] }>('/v1/app-intelligence/accounts').then(appItems),
      get<Record<string, unknown>[]>('/v1/brands').then((r) => brandItems(r ?? [])),
      get<Record<string, unknown>[]>('/v1/connections').then((r) => channelItems(r ?? [])),
      get<Record<string, unknown>[]>('/v1/social/posts').then((r) => postItems(r ?? [])),
      get<Record<string, unknown>[]>('/v1/actions?status=APPROVAL_REQUIRED&limit=100').then((r) => approvalItems(r ?? [])),
    ]).then((parts) => {
      const items = parts.flat();
      cache = { tenant: me.tenantId, items, done: true };
      if (live) {
        setRecords(items);
        setLoading(false);
      }
    });
    return () => {
      live = false;
    };
  }, [me.tenantId]);

  const quick = useMemo(() => allowedQuickActions(me), [me]);
  const statics = useMemo(() => staticItems(me.roles, quick), [me.roles, quick]);
  const groups = useMemo(() => {
    if (!query.trim()) {
      const pages = statics.filter((s) => s.kind === 'Pages' && ['page-home', 'page-goals', 'page-autopilot', 'page-content', 'page-apps', 'page-results', 'page-approvals', 'page-tools'].includes(s.id));
      return [
        { kind: 'Actions' as const, items: statics.filter((s) => s.kind === 'Actions').slice(0, 4) },
        { kind: 'Pages' as const, items: pages },
      ];
    }
    return rank([...statics, ...records], query);
  }, [query, statics, records]);
  const flat = groups.flatMap((g) => g.items);
  const current = flat[Math.min(active, flat.length - 1)];

  useEffect(() => {
    if (current) document.getElementById(`${listId}-${current.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const open = (item: SearchItem | undefined) => {
    if (!item) return;
    onClose();
    window.location.assign(item.href);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(current);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') e.preventDefault();
  };

  return (
    <div className="palette-layer">
      <button type="button" className="palette-backdrop" aria-label="Close search" tabIndex={-1} onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search FUTUREGROW">
        <div className="palette-input">
          <Ico name="search" size={20} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search goals, content, apps, reports and settings"
            placeholder="Search goals, content, apps, reports, settings…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {loading ? (
            <span className="palette-loading" role="status">
              Loading records…
            </span>
          ) : null}
          <kbd className="palette-esc">Esc</kbd>
        </div>
        <div className="palette-results" id={listId} role="listbox" aria-label="Results">
          {groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox (ARIA listbox pattern), not a form fieldset
            <div key={g.kind} role="group" aria-label={g.kind} className="palette-group">
              <div className="palette-kind" aria-hidden="true">
                {g.kind === 'Actions' && !query.trim() ? 'Quick actions' : g.kind === 'Pages' && !query.trim() ? 'Go to' : g.kind}
              </div>
              {g.items.map((item) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: options are chosen with the arrow keys and Enter on the search field (aria-activedescendant)
                <div key={item.id} id={`${listId}-${item.id}`} role="option" tabIndex={-1} aria-selected={item === current} className={`palette-item${item === current ? ' active' : ''}`} onMouseMove={() => setActive(flat.indexOf(item))} onClick={() => open(item)}>
                  <span className="palette-icon">
                    <Ico name={KIND_ICON[item.kind]} size={17} />
                  </span>
                  <span className="palette-text">
                    <span className="palette-title">{item.title}</span>
                    <span className="palette-detail">{item.detail}</span>
                  </span>
                  <Ico name="arrow-right" size={16} className="palette-go" />
                </div>
              ))}
            </div>
          ))}
          {query.trim() && !flat.length ? (
            <div className="palette-empty" role="status">
              {loading ? 'Searching your records…' : `Nothing matches “${query}”. Try a page name such as “approvals”, a goal, an app or a post.`}
            </div>
          ) : null}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
          <span>
            <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
