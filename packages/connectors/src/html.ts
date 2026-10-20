/**
 * Minimal, dependency-free HTML extraction for public pages (competitor snapshots, SEO audits).
 * Not a full parser: it is used for text/metadata extraction, never for rendering.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", hellip: '…', mdash: '—', ndash: '–', euro: '€', pound: '£', yen: '¥' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  headings: { level: number; text: string }[];
  text: string;
  links: { href: string; text: string; rel: string | null }[];
  jsonLd: { valid: boolean; value: unknown; error?: string }[];
  prices: string[];
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

const PRICE_RE = /(?:[$€£¥]\s?\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|JPY))(?:\s?\/\s?(?:mo|month|yr|year|user|seat))?/gi;

export function extractPage(html: string): ExtractedPage {
  const jsonLd: ExtractedPage['jsonLd'] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLd.push({ valid: true, value: JSON.parse(m[1]!.trim()) });
    } catch (err) {
      jsonLd.push({ valid: false, value: null, error: err instanceof Error ? err.message : 'invalid JSON' });
    }
  }
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const title = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let metaDescription: string | null = null;
  let robotsMeta: string | null = null;
  for (const m of cleaned.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], 'name') ?? attr(m[0], 'property') ?? '').toLowerCase();
    if (name === 'description' || (name === 'og:description' && !metaDescription)) metaDescription = attr(m[0], 'content');
    if (name === 'robots') robotsMeta = attr(m[0], 'content');
  }
  let canonical: string | null = null;
  const links: ExtractedPage['links'] = [];
  for (const m of cleaned.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical')) canonical = attr(m[0], 'href');
  }
  for (const m of cleaned.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, 'href');
    if (href) links.push({ href, text: stripTags(m[2] ?? '').slice(0, 200), rel: attr(`<a ${m[1]}>`, 'rel') });
  }
  const headings = [...cleaned.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: stripTags(m[2] ?? '') })).filter((h) => h.text);
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const text = stripTags((bodyMatch?.[1] ?? cleaned).replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b[^>]*>/gi, '\n'));
  const htmlLang = cleaned.match(/<html\b[^>]*>/i);
  return {
    title: title ? stripTags(title[1]!) : null,
    metaDescription,
    canonical,
    robotsMeta,
    lang: htmlLang ? attr(htmlLang[0], 'lang') : null,
    headings,
    text,
    links,
    jsonLd,
    prices: [...new Set(text.match(PRICE_RE) ?? [])].map((p) => p.trim()),
  };
}

/** Line-level diff of normalised text (LCS on lines, capped for very large pages). */
export function diffLines(before: string, after: string, max = 2000): { added: string[]; removed: string[] } {
  const a = splitSentences(before).slice(0, max);
  const b = splitSentences(after).slice(0, max);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  while (i < n) removed.push(a[i++]!);
  while (j < m) added.push(b[j++]!);
  return { added, removed };
}

function splitSentences(t: string): string[] {
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2);
}
