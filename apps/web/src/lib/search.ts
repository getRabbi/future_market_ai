/**
 * Global search (D-048): pages, tools, quick actions and help are static; goals, apps, brands,
 * channels, posts and approvals come from the organization's own list endpoints, which the API
 * already scopes to the tenant and the signed-in user's permissions (a list the role may not read
 * simply contributes nothing). Ranking is plain text matching, done in the browser.
 */
import { actionName } from './dashboard.js';
import { readableText, statusLabel } from './format.js';
import { SECTION_FLOWS, TASKS } from './journey.js';
import { GROUPS, PAGES, pageHref } from './nav.js';

export type ResultKind = 'Pages' | 'Actions' | 'Goals' | 'Apps' | 'Brands' | 'Channels' | 'Content' | 'Approvals' | 'Help';

export const KIND_ORDER: ResultKind[] = ['Actions', 'Pages', 'Goals', 'Approvals', 'Apps', 'Content', 'Channels', 'Brands', 'Help'];

export interface SearchItem {
  id: string;
  kind: ResultKind;
  title: string;
  detail: string;
  href: string;
  /** Extra text matched but not shown. */
  terms: string;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Score of an item for a query (0 = no match). Every query word must match somewhere. */
export function score(item: SearchItem, query: string): number {
  const q = norm(query).trim();
  if (!q) return 0;
  const title = norm(item.title);
  const hay = `${title} ${norm(item.detail)} ${norm(item.terms)}`;
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.every((w) => hay.includes(w))) return 0;
  let s = 1;
  if (title === q) s += 100;
  else if (title.startsWith(q)) s += 60;
  else if (title.includes(q)) s += 35;
  for (const w of words) if (new RegExp(`(^|\\s)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(title)) s += 10;
  if (item.kind === 'Pages' || item.kind === 'Actions') s += 5;
  return s;
}

export function rank(items: SearchItem[], query: string, perKind = 6): { kind: ResultKind; items: SearchItem[] }[] {
  const scored = items.map((i) => ({ i, s: score(i, query) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return KIND_ORDER.map((kind) => ({
    kind,
    items: scored
      .filter((x) => x.i.kind === kind)
      .slice(0, perKind)
      .map((x) => x.i),
  })).filter((g) => g.items.length);
}

export function staticItems(roles: string[], quick: { label: string; hint: string; href: string }[]): SearchItem[] {
  const groupTitle = (k: string) => GROUPS.find((g) => g.key === k)?.title ?? '';
  const pages: SearchItem[] = PAGES.map((p) => ({ id: `page-${p.slug || 'home'}`, kind: 'Pages', title: p.title, detail: `${groupTitle(p.group)}${p.modules.length ? ` · ${p.modules.join(', ')}` : ''}`, href: pageHref(p.slug), terms: `${p.summary} ${p.keywords.join(' ')} ${p.modules.join(' ')}` }));
  const actions: SearchItem[] = quick.map((q) => ({ id: `quick-${q.href}`, kind: 'Actions', title: q.label, detail: q.hint, href: q.href, terms: 'create new add do' }));
  const help: SearchItem[] = [
    ...TASKS.filter((t) => !t.roles || t.roles.some((r) => roles.includes(r))).map((t) => ({ id: `task-${t.id}`, kind: 'Help' as const, title: t.title, detail: t.why, href: pageHref(t.section), terms: `${t.how} how to journey step` })),
    ...Object.entries(SECTION_FLOWS).map(([slug, steps]) => ({ id: `flow-${slug}`, kind: 'Help' as const, title: `How ${PAGES.find((p) => p.slug === slug)?.title ?? slug} works`, detail: steps.join(' → '), href: pageHref(slug), terms: 'help how works guide' })),
  ];
  return [...actions, ...pages, ...help];
}

/* ------------------------------------------------------------------ */
/* Records from the API                                                */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

export function goalItems(rows: Row[]): SearchItem[] {
  return rows.map((g) => ({ id: `goal-${str(g.id)}`, kind: 'Goals', title: str(g.title), detail: `${statusLabel(g.status)} · ${str((g.kpi as Row | undefined)?.label)}`, href: `/app/goals?id=${str(g.id)}`, terms: str(g.statement) }));
}

export function appItems(data: { apps?: Row[] } | null): SearchItem[] {
  return (data?.apps ?? []).map((a) => ({ id: `app-${str(a.id)}`, kind: 'Apps', title: str(a.displayName) || str(a.appId), detail: `${a.platform === 'ios' ? 'iOS' : 'Android'} · ${str(a.appId)}`, href: `/app/apps?app=${str(a.id)}`, terms: `${str(a.appId)} store report installs` }));
}

export function brandItems(rows: Row[]): SearchItem[] {
  return rows.map((b) => ({ id: `brand-${str(b.id)}`, kind: 'Brands', title: str(b.name), detail: 'Brand', href: `/app/channels?brand=${str(b.id)}`, terms: str(b.description) }));
}

export function channelItems(rows: Row[]): SearchItem[] {
  return rows.map((c) => ({ id: `conn-${str(c.id)}`, kind: 'Channels', title: str(c.displayName) || str(c.provider), detail: `${statusLabel(c.provider)} · ${statusLabel(c.status)}`, href: '/app/connections', terms: `${str(c.provider)} connection account` }));
}

export function postItems(rows: Row[]): SearchItem[] {
  return rows.slice(0, 200).map((p) => {
    const when = str(p.verifiedAt) || str(p.scheduledAt);
    const d = when ? new Date(when) : null;
    return {
      id: `post-${str(p.id)}`,
      kind: 'Content',
      title: readableText(str(p.caption)).slice(0, 80) || 'Post',
      detail: `${statusLabel(p.platform)} · ${p.status === 'published_verified' ? 'Published and verified' : statusLabel(p.status)}${d && !Number.isNaN(d.getTime()) ? ` · ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}`,
      href: '/app/calendar',
      terms: str(p.caption),
    };
  });
}

export function approvalItems(rows: Row[]): SearchItem[] {
  return rows.map((a) => ({ id: `action-${str(a.id)}`, kind: 'Approvals', title: actionName(str(a.actionType)), detail: `Needs approval${a.statusReason ? ` · ${readableText(str(a.statusReason)).slice(0, 80)}` : ''}`, href: `/app/approvals?id=${str(a.id)}`, terms: `${str(a.actionType)} approve review` }));
}
