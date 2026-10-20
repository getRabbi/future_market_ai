import { and, desc, eq, sql } from 'drizzle-orm';
import { type PublicFetchResult, extractPage, parseRobots, publicFetch, readLocalization, searchConsoleQuery } from '@futuregrow/connectors';
import { type DbOrTx, type Tx, keywordMetrics, seoAudits, seoPages, storeListings, withTenant } from '@futuregrow/db';
import { invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef, systemActor } from '../../deps.js';
import { audit, record, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { lintCopy } from '../m03-knowledge/index.js';
import type { PublicFetcher } from '../m05-competitors/index.js';
import { proposeAction } from '../m23-execution/gateway.js';
import { registerHooks } from '../m23-execution/registry.js';

export const SEO_USER_AGENT = 'FUTUREGROW-SiteAudit/0.1 (+https://futuregrow.invalid/bot)';

/* ------------------------------------------------------------------ */
/* Technical SEO audit                                                 */
/* ------------------------------------------------------------------ */

export const AuditRequestSchema = z.object({
  siteUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'http(s) only'),
  maxPages: z.number().int().min(1).max(200).default(50),
});

export async function requestSeoAudit(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'requesting a site audit');
  const input = AuditRequestSchema.parse(raw);
  const origin = new URL(input.siteUrl).origin;
  const [row] = await tx.insert(seoAudits).values({ tenantId, siteUrl: origin, maxPages: input.maxPages, requestedBy: actorRef(actor) }).returning();
  await audit(tx, tenantId, actor, 'seo.audit.requested', { type: 'seo_audit', id: row!.id }, { siteUrl: origin, maxPages: input.maxPages });
  await deps.jobs.add('seo_audit', { tenantId, auditId: row!.id }, { jobKey: `seo-audit:${row!.id}` });
  return row!;
}

export interface PageIssue {
  code: string;
  severity: 'error' | 'warning' | 'info';
  detail: string;
}

/** AI answer-engine crawlers whose robots.txt access we report (discovery, not ranking). */
export const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'Applebot-Extended'] as const;

export function pageIssues(p: { status: number; html: string; bytes: number; url: string; contentType: string }, extracted: ReturnType<typeof extractPage> | null): PageIssue[] {
  const out: PageIssue[] = [];
  if (p.status >= 400) return [{ code: 'HTTP_ERROR', severity: 'error', detail: `status ${p.status}` }];
  if (!extracted) return [{ code: 'NOT_HTML', severity: 'info', detail: p.contentType }];
  const e = extracted;
  if (!e.title) out.push({ code: 'TITLE_MISSING', severity: 'error', detail: 'no <title>' });
  else if (e.title.length > 60) out.push({ code: 'TITLE_LONG', severity: 'warning', detail: `${e.title.length} chars (search results typically truncate near 60)` });
  else if (e.title.length < 10) out.push({ code: 'TITLE_SHORT', severity: 'warning', detail: `${e.title.length} chars` });
  if (!e.metaDescription) out.push({ code: 'META_DESCRIPTION_MISSING', severity: 'warning', detail: 'no meta description' });
  else if (e.metaDescription.length > 160) out.push({ code: 'META_DESCRIPTION_LONG', severity: 'info', detail: `${e.metaDescription.length} chars` });
  const h1 = e.headings.filter((h) => h.level === 1);
  if (h1.length === 0) out.push({ code: 'H1_MISSING', severity: 'warning', detail: 'no <h1>' });
  if (h1.length > 1) out.push({ code: 'H1_MULTIPLE', severity: 'info', detail: `${h1.length} <h1> elements` });
  if (e.robotsMeta && /noindex/i.test(e.robotsMeta)) out.push({ code: 'NOINDEX', severity: 'warning', detail: `robots meta: ${e.robotsMeta}` });
  if (e.canonical) {
    try {
      const c = new URL(e.canonical, p.url);
      const self = new URL(p.url);
      if (c.origin !== self.origin || c.pathname !== self.pathname) out.push({ code: 'CANONICAL_ELSEWHERE', severity: 'info', detail: `canonical → ${c.toString()}` });
    } catch {
      out.push({ code: 'CANONICAL_INVALID', severity: 'warning', detail: e.canonical });
    }
  } else out.push({ code: 'CANONICAL_MISSING', severity: 'info', detail: 'no rel=canonical' });
  const words = e.text.split(/\s+/).filter(Boolean).length;
  if (words < 200) out.push({ code: 'THIN_CONTENT', severity: 'info', detail: `${words} words` });
  if (!e.lang) out.push({ code: 'LANG_MISSING', severity: 'info', detail: 'no <html lang>' });
  if (e.jsonLd.some((j) => !j.valid)) out.push({ code: 'STRUCTURED_DATA_INVALID', severity: 'error', detail: 'JSON-LD block does not parse' });
  if (e.jsonLd.length === 0) out.push({ code: 'STRUCTURED_DATA_MISSING', severity: 'info', detail: 'no JSON-LD' });
  const imgs = [...p.html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\balt\s*=/i.test(t)).length;
  if (noAlt) out.push({ code: 'IMG_ALT_MISSING', severity: 'warning', detail: `${noAlt} of ${imgs.length} images without alt` });
  if (p.bytes > 2 * 1024 * 1024) out.push({ code: 'PAGE_HEAVY', severity: 'warning', detail: `${p.bytes} bytes of HTML` });
  return out;
}

function normalizeUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Crawl one origin breadth-first, honouring robots.txt (RFC 9309) and its crawl-delay, through the
 * SSRF-guarded fetcher. Results are stored per page plus a site summary that is admitted as
 * evidence. Recommendations describe technical fixes; no ranking outcome is promised.
 */
export async function runSeoAudit(deps: CoreDeps & { fetchPublic?: PublicFetcher }, tenantId: string, auditId: string) {
  const actor = systemActor('seo-auditor');
  const fetcher: PublicFetcher = deps.fetchPublic ?? ((u, o) => publicFetch(u, o));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const a = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const [row] = await tx.update(seoAudits).set({ status: 'running', startedAt: deps.clock.now() }).where(and(eq(seoAudits.id, auditId), eq(seoAudits.status, 'queued'))).returning();
    return row ?? null;
  });
  if (!a) return { status: 'skipped' as const };
  const origin = new URL(a.siteUrl).origin;
  try {
    let robotsText = '';
    let robotsStatus = 0;
    try {
      const r = await fetcher(`${origin}/robots.txt`, { maxBytes: 512 * 1024, userAgent: SEO_USER_AGENT });
      robotsStatus = r.status;
      if (r.status >= 200 && r.status < 300) robotsText = r.body;
      else if (r.status >= 500) throw new Error(`robots.txt returned ${r.status}; not crawling (RFC 9309 §2.3.1.4)`);
    } catch (err) {
      if (err instanceof Error && /not crawling/.test(err.message)) throw err;
      throw new Error(`robots.txt unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const robots = parseRobots(robotsText, 'FUTUREGROW-SiteAudit');
    const delayMs = Math.min(10, robots.crawlDelaySeconds ?? 0) * 1000;
    const aiAccess = Object.fromEntries(AI_CRAWLERS.map((ua) => [ua, parseRobots(robotsText, ua).isAllowed('/')]));
    const sitemaps = [...robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!);

    const queue: string[] = [`${origin}/`];
    for (const sm of sitemaps.length ? sitemaps : [`${origin}/sitemap.xml`]) {
      try {
        const r = await fetcher(sm, { maxBytes: 5 * 1024 * 1024, userAgent: SEO_USER_AGENT });
        if (r.status === 200) for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) queue.push(m[1]!);
      } catch {
        // sitemap is optional
      }
    }
    const seen = new Set<string>();
    const pages: { url: string; status: number; title: string | null; issues: PageIssue[]; internalLinks: string[] }[] = [];
    const disallowed: string[] = [];
    let llmsTxt = false;
    try {
      const l = await fetcher(`${origin}/llms.txt`, { maxBytes: 256 * 1024, userAgent: SEO_USER_AGENT });
      llmsTxt = l.status === 200 && l.body.trim().length > 0;
    } catch {
      llmsTxt = false;
    }

    while (queue.length && pages.length < a.maxPages) {
      const next = normalizeUrl(queue.shift()!, origin);
      if (!next || seen.has(next) || new URL(next).origin !== origin) continue;
      seen.add(next);
      const u = new URL(next);
      if (!robots.isAllowed(`${u.pathname}${u.search}`)) {
        disallowed.push(next);
        continue;
      }
      if (pages.length > 0 && delayMs) await sleep(delayMs);
      let res: PublicFetchResult;
      try {
        res = await fetcher(next, { maxBytes: 3 * 1024 * 1024, userAgent: SEO_USER_AGENT });
      } catch (err) {
        pages.push({ url: next, status: 0, title: null, issues: [{ code: 'FETCH_FAILED', severity: 'error', detail: err instanceof Error ? err.message : String(err) }], internalLinks: [] });
        continue;
      }
      const isHtml = /text\/html|application\/xhtml/i.test(res.contentType);
      const ex = isHtml && res.status < 400 ? extractPage(res.body) : null;
      const issues = pageIssues({ status: res.status, html: res.body, bytes: res.bytes, url: res.finalUrl, contentType: res.contentType }, ex);
      const internal: string[] = [];
      let external = 0;
      for (const l of ex?.links ?? []) {
        const n = normalizeUrl(l.href, res.finalUrl);
        if (!n) continue;
        if (new URL(n).origin === origin) {
          internal.push(n);
          if (!seen.has(n)) queue.push(n);
        } else external++;
      }
      pages.push({ url: next, status: res.status, title: ex?.title ?? null, issues, internalLinks: internal });
      await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) =>
        tx
          .insert(seoPages)
          .values({
            tenantId,
            auditId,
            url: next,
            statusCode: res.status,
            title: ex?.title ?? null,
            metaDescription: ex?.metaDescription ?? null,
            canonical: ex?.canonical ?? null,
            robotsMeta: ex?.robotsMeta ?? null,
            h1: (ex?.headings ?? []).filter((h) => h.level === 1).map((h) => h.text.slice(0, 500)),
            wordCount: ex ? ex.text.split(/\s+/).filter(Boolean).length : 0,
            bytes: res.bytes,
            structuredData: (ex?.jsonLd ?? []).map((j) => (j.valid ? j.value : { invalid: j.error })),
            links: { internal: internal.length, external },
            issues,
            contentSha256: res.sha256,
            fetchedAt: res.fetchedAt,
          })
          .onConflictDoNothing(),
      );
    }

    // Site-level checks that need every page.
    const byTitle = new Map<string, string[]>();
    for (const p of pages) if (p.title) byTitle.set(p.title, [...(byTitle.get(p.title) ?? []), p.url]);
    const duplicateTitles = [...byTitle.entries()].filter(([, urls]) => urls.length > 1).map(([title, urls]) => ({ title, urls }));
    const statusByUrl = new Map(pages.map((p) => [p.url, p.status]));
    const brokenInternal = pages.flatMap((p) => p.internalLinks.filter((l) => (statusByUrl.get(l) ?? 0) >= 400).map((l) => ({ from: p.url, to: l })));
    const counts: Record<string, number> = {};
    for (const p of pages) for (const i of p.issues) counts[i.code] = (counts[i.code] ?? 0) + 1;
    const summary = {
      origin,
      pagesCrawled: pages.length,
      disallowedByRobots: disallowed.length,
      robotsStatus,
      sitemaps,
      issueCounts: counts,
      duplicateTitles: duplicateTitles.slice(0, 50),
      brokenInternalLinks: brokenInternal.slice(0, 100),
      aiDiscovery: { crawlerAccess: aiAccess, llmsTxt, pagesWithStructuredData: pages.filter((p) => !p.issues.some((i) => i.code === 'STRUCTURED_DATA_MISSING' || i.code === 'NOT_HTML')).length },
      recommendations: recommendations(counts, duplicateTitles.length, brokenInternal.length, aiAccess, llmsTxt),
      note: 'Technical findings only. Outcomes are measured by impressions, clicks and conversions; rankings are not promised.',
    };
    return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
      const ev = await admitInternalEvidence(tx, tenantId, actor, {
        kind: 'observation',
        sourceType: 'primary',
        owner: origin,
        uri: `seo-audit://${auditId}`,
        content: summary,
        summary: `Technical SEO audit of ${origin}: ${pages.length} pages`,
        confidence: 1,
        license: 'public web pages fetched under robots.txt',
        permittedUses: ['analytics', 'creative_generation'],
        externalPlatformTerms: `robots.txt honoured (${robotsStatus})`,
        freshnessSlaHours: 24 * 14,
        now: deps.clock.now(),
      });
      const [done] = await tx.update(seoAudits).set({ status: 'completed', finishedAt: deps.clock.now(), summary: { ...summary, evidenceId: ev.evidenceId } }).where(eq(seoAudits.id, auditId)).returning();
      await record(tx, tenantId, actor, 'seo.audit.completed', { type: 'seo_audit', id: auditId }, { pages: pages.length, evidenceId: ev.evidenceId });
      return { status: 'completed' as const, audit: done! };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.update(seoAudits).set({ status: 'failed', finishedAt: deps.clock.now(), summary: { error: message } }).where(eq(seoAudits.id, auditId)));
    return { status: 'failed' as const, error: message };
  }
}

function recommendations(counts: Record<string, number>, dupTitles: number, broken: number, ai: Record<string, boolean>, llmsTxt: boolean): string[] {
  const r: string[] = [];
  if (counts.HTTP_ERROR) r.push(`Fix ${counts.HTTP_ERROR} pages returning HTTP errors.`);
  if (broken) r.push(`Repair ${broken} internal links pointing to error pages.`);
  if (counts.TITLE_MISSING) r.push(`Add <title> to ${counts.TITLE_MISSING} pages.`);
  if (dupTitles) r.push(`Make ${dupTitles} duplicated titles unique per page.`);
  if (counts.META_DESCRIPTION_MISSING) r.push(`Write meta descriptions for ${counts.META_DESCRIPTION_MISSING} pages (from approved claims only).`);
  if (counts.STRUCTURED_DATA_INVALID) r.push(`Fix ${counts.STRUCTURED_DATA_INVALID} pages with JSON-LD that does not parse.`);
  if (counts.IMG_ALT_MISSING) r.push(`Add descriptive alt text on ${counts.IMG_ALT_MISSING} pages.`);
  if (counts.NOINDEX) r.push(`Review ${counts.NOINDEX} noindex pages — confirm they are meant to be excluded.`);
  const blockedAi = Object.entries(ai).filter(([, ok]) => !ok).map(([k]) => k);
  if (blockedAi.length) r.push(`robots.txt blocks AI crawlers (${blockedAi.join(', ')}). This is a business choice; keep it if intentional.`);
  if (!llmsTxt) r.push('Optional: publish /llms.txt summarising key pages for AI answer engines (an emerging, non-standard convention).');
  return r;
}

export async function auditDetail(tx: DbOrTx, id: string) {
  const [a] = await tx.select().from(seoAudits).where(eq(seoAudits.id, id));
  if (!a) throw notFound('audit');
  const pages = await tx.select().from(seoPages).where(eq(seoPages.auditId, id)).orderBy(seoPages.url).limit(500);
  return { audit: a, pages };
}

export async function listAudits(tx: DbOrTx) {
  return tx.select().from(seoAudits).orderBy(desc(seoAudits.createdAt)).limit(100);
}

/* ------------------------------------------------------------------ */
/* Keyword / query metrics                                             */
/* ------------------------------------------------------------------ */

export async function syncSearchConsole(deps: CoreDeps, tenantId: string, connectionId: string, args: { siteUrl: string; startDate: string; endDate: string }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(args.endDate)) throw invalid('dates must be YYYY-MM-DD');
  const { ctx } = await readContext(deps, tenantId, connectionId, 'search_console');
  const rows = await searchConsoleQuery(ctx, args.siteUrl, args.startDate, args.endDate);
  const actor = systemActor('search-console-sync');
  return withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => {
    const ev = await admitInternalEvidence(tx, tenantId, actor, {
      kind: 'metric',
      sourceType: 'primary',
      owner: 'google_search_console',
      uri: `search-console://${args.siteUrl}/${args.startDate}..${args.endDate}@${deps.clock.now().toISOString()}`,
      content: { rows: rows.length, siteUrl: args.siteUrl },
      summary: `${rows.length} query/page rows from Search Console`,
      confidence: 1,
      license: 'Google Search Console API terms (verified property owner)',
      permittedUses: ['analytics', 'creative_generation', 'causal_measurement'],
      externalPlatformTerms: 'google_search_console',
      freshnessSlaHours: 72,
      now: deps.clock.now(),
    });
    const n = await upsertKeywordRows(tx, tenantId, rows.map((r) => ({ query: r.query, pageUrl: r.page || null, impressions: r.impressions, clicks: r.clicks, position: r.position })), { periodStart: args.startDate, periodEnd: args.endDate, source: 'search_console', evidenceId: ev.evidenceId });
    return { rows: n, evidenceId: ev.evidenceId };
  });
}

export const KeywordUploadSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  evidenceId: z.string().uuid(),
  rows: z.array(z.object({ query: z.string().min(1).max(500), pageUrl: z.string().url().nullable().default(null), impressions: z.number().int().nonnegative(), clicks: z.number().int().nonnegative(), position: z.number().positive().nullable().default(null) })).min(1).max(50_000),
});

export async function uploadKeywordMetrics(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator', 'analyst'], 'uploading keyword data');
  const input = KeywordUploadSchema.parse(raw);
  const bad = input.rows.find((r) => r.clicks > r.impressions);
  if (bad) throw invalid(`clicks exceed impressions for "${bad.query}"`);
  const n = await upsertKeywordRows(tx, tenantId, input.rows, { periodStart: input.periodStart, periodEnd: input.periodEnd, source: 'upload', evidenceId: input.evidenceId });
  await audit(tx, tenantId, actor, 'seo.keywords.uploaded', { type: 'evidence', id: input.evidenceId }, { rows: n });
  return { rows: n };
}

async function upsertKeywordRows(tx: Tx, tenantId: string, rows: { query: string; pageUrl: string | null; impressions: number; clicks: number; position: number | null }[], meta: { periodStart: string; periodEnd: string; source: 'search_console' | 'upload'; evidenceId: string }) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ tenantId, ...r, ...meta }));
    await tx
      .insert(keywordMetrics)
      .values(chunk)
      .onConflictDoUpdate({
        target: [keywordMetrics.tenantId, keywordMetrics.query, keywordMetrics.pageUrl, keywordMetrics.periodStart, keywordMetrics.periodEnd, keywordMetrics.source],
        set: { impressions: sql`excluded.impressions`, clicks: sql`excluded.clicks`, position: sql`excluded.position`, evidenceId: sql`excluded.evidence_id` },
      });
  }
  return rows.length;
}

/**
 * "Striking distance" opportunities: queries with real impressions, average position 4–20 and
 * CTR below the period median. A heuristic for prioritising content work, not a forecast.
 */
export async function keywordOpportunities(tx: DbOrTx, opts: { minImpressions?: number; limit?: number } = {}) {
  const minImp = opts.minImpressions ?? 100;
  const r = await tx.execute<{ query: string; page_url: string | null; impressions: number; clicks: number; position: number; ctr: number }>(sql`
    with agg as (
      select query, page_url, sum(impressions)::int as impressions, sum(clicks)::int as clicks,
             sum(position * impressions) / nullif(sum(impressions), 0) as position
      from keyword_metrics group by query, page_url
    ), med as (
      select percentile_cont(0.5) within group (order by clicks::float / nullif(impressions, 0)) as m from agg where impressions >= ${minImp}
    )
    select a.query, a.page_url, a.impressions, a.clicks, a.position, a.clicks::float / nullif(a.impressions, 0) as ctr
    from agg a, med
    where a.impressions >= ${minImp} and a.position between 4 and 20 and a.clicks::float / nullif(a.impressions, 0) <= coalesce(med.m, 1)
    order by a.impressions desc limit ${opts.limit ?? 100}`);
  return { rows: r.rows, method: 'heuristic: position 4–20, CTR ≤ median, impressions ≥ threshold', note: 'Prioritisation aid; no ranking or traffic outcome is promised.' };
}

/* ------------------------------------------------------------------ */
/* ASO: store listing validation                                       */
/* ------------------------------------------------------------------ */

/** Store field limits (App Store Connect / Google Play Console documentation). */
export const STORE_LIMITS = {
  app_store: { name: 30, subtitle: 30, keywords: 100, promotionalText: 170, description: 4000, whatsNew: 4000 },
  google_play: { title: 30, shortDescription: 80, fullDescription: 4000 },
} as const;

/** Google Play metadata policy: no performance/rank/price/promotional claims in title, icon or developer name. */
const PLAY_TITLE_BANNED = /\b(best|top|#\s?1|number one|free|no ads|sale|discount|new|hot)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

export interface ListingCheck {
  field: string;
  code: string;
  severity: 'block' | 'warn';
  detail: string;
}

export function validateListingFields(store: 'app_store' | 'google_play', fields: Record<string, string>): ListingCheck[] {
  const out: ListingCheck[] = [];
  const limits = STORE_LIMITS[store] as Record<string, number>;
  for (const [k, v] of Object.entries(fields)) {
    const max = limits[k];
    if (max === undefined) {
      out.push({ field: k, code: 'UNKNOWN_FIELD', severity: 'block', detail: `${store} has no field ${k}` });
      continue;
    }
    const len = k === 'keywords' ? Buffer.byteLength(v, 'utf8') : [...v].length;
    if (len > max) out.push({ field: k, code: 'TOO_LONG', severity: 'block', detail: `${len} > ${max}${k === 'keywords' ? ' bytes' : ' characters'}` });
    if (v.trim().length === 0) out.push({ field: k, code: 'EMPTY', severity: 'block', detail: 'empty' });
  }
  if (store === 'app_store' && fields.keywords) {
    const kws = fields.keywords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const dup = kws.filter((k, i) => kws.indexOf(k) !== i);
    if (dup.length) out.push({ field: 'keywords', code: 'DUPLICATE_KEYWORDS', severity: 'warn', detail: [...new Set(dup)].join(', ') });
    const nameWords = new Set(`${fields.name ?? ''} ${fields.subtitle ?? ''}`.toLowerCase().split(/\W+/).filter(Boolean));
    const wasted = kws.filter((k) => nameWords.has(k));
    if (wasted.length) out.push({ field: 'keywords', code: 'REPEATS_NAME', severity: 'warn', detail: `already indexed from name/subtitle: ${wasted.join(', ')}` });
    if (/,\s/.test(fields.keywords)) out.push({ field: 'keywords', code: 'SPACES_AFTER_COMMAS', severity: 'warn', detail: 'spaces after commas consume the 100-byte budget' });
  }
  if (store === 'google_play' && fields.title) {
    if (PLAY_TITLE_BANNED.test(fields.title)) out.push({ field: 'title', code: 'PLAY_PROMOTIONAL_TITLE', severity: 'block', detail: 'performance/rank/price/promotional terms are not allowed in Play titles' });
    if (EMOJI.test(fields.title)) out.push({ field: 'title', code: 'PLAY_EMOJI_TITLE', severity: 'block', detail: 'emoji are not allowed in Play titles' });
    if (/[A-Z]{5,}/.test(fields.title) && fields.title === fields.title.toUpperCase()) out.push({ field: 'title', code: 'PLAY_ALL_CAPS', severity: 'block', detail: 'all-caps titles are not allowed unless part of the brand' });
  }
  const all = Object.values(fields).join(' ').toLowerCase();
  const words = all.split(/\W+/).filter((w) => w.length > 3);
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  const stuffed = [...freq.entries()].filter(([, n]) => words.length >= 50 && n / words.length > 0.06).map(([w]) => w);
  if (stuffed.length) out.push({ field: '*', code: 'KEYWORD_STUFFING', severity: 'block', detail: `over-repeated terms: ${stuffed.join(', ')}` });
  return out;
}

export const ListingInputSchema = z.object({
  store: z.enum(['app_store', 'google_play']),
  appRef: z.string().min(1).max(200),
  locale: z.string().min(2).max(10),
  fields: z.record(z.string(), z.string().max(4000)),
  claimIds: z.array(z.string().uuid()).default([]),
});

export async function createListingDraft(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'drafting store listings');
  const input = ListingInputSchema.parse(raw);
  const checks = validateListingFields(input.store, input.fields);
  const lint = await lintCopy(tx, Object.values(input.fields).join('\n'), { claimIds: input.claimIds, channel: input.store, now: deps.clock.now() });
  const blocked = checks.some((c) => c.severity === 'block') || !lint.passed;
  const [row] = await tx
    .insert(storeListings)
    .values({ tenantId, store: input.store, appRef: input.appRef, locale: input.locale, fields: input.fields, validation: { checks, lint }, claimIds: input.claimIds, status: blocked ? 'invalid' : 'draft', createdBy: actorRef(actor) })
    .returning();
  await record(tx, tenantId, actor, 'aso.listing.validated', { type: 'store_listing', id: row!.id }, { store: input.store, status: row!.status, checks: checks.length });
  return row!;
}

export async function approveListing(tx: Tx, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'approver', 'legal_approver'], 'approving store listings');
  const [l] = await tx.select().from(storeListings).where(eq(storeListings.id, id));
  if (!l) throw notFound('listing');
  if (l.status !== 'draft') throw invalid(`listing is ${l.status}`);
  if (l.createdBy === actorRef(actor)) throw invalid('the author cannot approve their own listing');
  const [row] = await tx.update(storeListings).set({ status: 'approved' }).where(eq(storeListings.id, id)).returning();
  await audit(tx, tenantId, actor, 'aso.listing.approved', { type: 'store_listing', id }, {});
  return row!;
}

/**
 * Propose pushing an approved App Store listing via M23. Current values are read first so the
 * executor's precondition check (fields unchanged since proposal) and rollback have a baseline.
 * Google Play listing writes are not implemented (no Play Developer API connector, B-009).
 */
export async function proposeAppStoreUpdate(deps: CoreDeps, tenantId: string, actor: Actor, listingId: string, input: { connectionId: string; localizationId: string; geographies: string[]; evidenceIds?: string[] }) {
  const l = await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, async (tx) => (await tx.select().from(storeListings).where(eq(storeListings.id, listingId)))[0]);
  if (!l) throw notFound('listing');
  if (l.store !== 'app_store') throw invalid('Google Play listing updates are not supported (B-009)');
  if (l.status !== 'approved') throw invalid(`listing must be approved (is ${l.status})`);
  const writable = ['description', 'keywords', 'promotionalText', 'whatsNew'] as const;
  const fields = Object.fromEntries(writable.filter((k) => l.fields[k] !== undefined).map((k) => [k, l.fields[k]!]));
  if (Object.keys(fields).length === 0) throw invalid('nothing to update: name/subtitle are app-info fields and are changed with a new version');
  const { ctx } = await readContext(deps, tenantId, input.connectionId, 'app_store_connect');
  const current = await readLocalization(ctx, input.localizationId);
  if (current.locale && current.locale.toLowerCase() !== l.locale.toLowerCase()) throw invalid(`localization ${input.localizationId} is ${current.locale}, listing is ${l.locale}`);
  const previousFields = Object.fromEntries(Object.keys(fields).map((k) => [k, (current as Record<string, string | undefined>)[k] ?? null]));
  const view = await proposeAction(deps, tenantId, actor, {
    actionType: 'store.app_store.update_localization',
    connectionId: input.connectionId,
    target: { listingId },
    params: { listingId, localizationId: input.localizationId, fields, previousFields },
    risk: { geographies: input.geographies },
    evidenceIds: input.evidenceIds ?? [],
    idempotencyKey: `listing:${listingId}:${sha256Hex(JSON.stringify(previousFields)).slice(0, 16)}`,
  });
  await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (tx) => tx.update(storeListings).set({ status: 'submitted', actionId: view.id }).where(eq(storeListings.id, listingId)));
  return view;
}

registerHooks('store.app_store.update_localization', {
  async onVerified(tx, action) {
    await tx.update(storeListings).set({ status: 'live_verified' }).where(eq(storeListings.id, (action.params as { listingId: string }).listingId));
  },
  async onTerminalFailure(tx, action) {
    await tx.update(storeListings).set({ status: 'approved' }).where(and(eq(storeListings.id, (action.params as { listingId: string }).listingId), eq(storeListings.status, 'submitted')));
  },
});

export async function listListings(tx: DbOrTx) {
  return tx.select().from(storeListings).orderBy(desc(storeListings.createdAt)).limit(200);
}
