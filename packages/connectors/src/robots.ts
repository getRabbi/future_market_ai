/**
 * robots.txt evaluation (RFC 9309): group selection by most specific user-agent, longest-match
 * between Allow/Disallow (Allow wins ties), `*` wildcards and `$` end anchors.
 */
interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicy {
  isAllowed(pathAndQuery: string): boolean;
  crawlDelaySeconds: number | null;
  matchedAgent: string | null;
}

export function parseRobots(text: string, userAgent: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelaySeconds: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // empty disallow = allow all
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySeconds = n;
    }
  }

  const ua = userAgent.toLowerCase();
  const token = ua.split('/')[0]!;
  let best: Group | null = null;
  let bestLen = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a !== '*' && token.includes(a) && a.length > bestLen) {
        best = g;
        bestLen = a.length;
      }
    }
  }
  if (!best) best = groups.find((g) => g.agents.includes('*')) ?? null;

  const rules = best?.rules ?? [];
  return {
    matchedAgent: best ? (bestLen >= 0 ? (best.agents.find((a) => token.includes(a)) ?? '*') : '*') : null,
    crawlDelaySeconds: best?.crawlDelaySeconds ?? null,
    isAllowed(path: string) {
      if (path === '/robots.txt') return true;
      let decision: Rule | null = null;
      let decisionLen = -1;
      for (const r of rules) {
        if (!matches(r.pattern, path)) continue;
        const len = r.pattern.length;
        if (len > decisionLen || (len === decisionLen && r.allow)) {
          decision = r;
          decisionLen = len;
        }
      }
      return decision ? decision.allow : true;
    },
  };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map(escapeRe).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
