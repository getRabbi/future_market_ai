import { campaignLinks, type DbOrTx, studioPrograms } from '@futuregrow/db';
import { conflict } from '@futuregrow/observability';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

/* ------------------------------------------------------------------ */
/* Campaign identities (P3-01: no collisions between programs)         */
/* ------------------------------------------------------------------ */

const CAMPAIGN_RE = /^[a-z0-9_]{3,40}$/;

/** A store-link campaign base from words (brand slug, program name or pack): [a-z0-9_], at most 34 characters. */
export function campaignBase(...parts: (string | null | undefined)[]): string {
  const raw = parts
    .filter((p): p is string => Boolean(p?.trim()))
    .join('_')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34)
    .replace(/_+$/g, '');
  return raw.length >= 3 ? raw : `program_${raw || 'content'}`.slice(0, 34);
}

/** Campaign names in use by other programs or already recorded on store links (historical shared campaigns stay reserved). */
async function campaignTaken(t: DbOrTx, campaign: string, connectionId: string): Promise<boolean> {
  const [program] = await t
    .select({ id: studioPrograms.id })
    .from(studioPrograms)
    .where(and(ne(studioPrograms.connectionId, connectionId), sql`${studioPrograms.settings}->>'campaign' = ${campaign}`))
    .limit(1);
  if (program) return true;
  const [link] = await t
    .select({ id: campaignLinks.id })
    .from(campaignLinks)
    .leftJoin(studioPrograms, eq(studioPrograms.id, campaignLinks.programId))
    .where(and(eq(campaignLinks.campaign, campaign), or(isNull(studioPrograms.connectionId), ne(studioPrograms.connectionId, connectionId))))
    .limit(1);
  return Boolean(link);
}

/** The first free campaign for a program: `base`, then `base_2`, `base_3`, … */
export async function uniqueCampaign(t: DbOrTx, base: string, connectionId: string): Promise<string> {
  const b = campaignBase(base);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? b : `${b}_${n}`;
    if (CAMPAIGN_RE.test(candidate) && !(await campaignTaken(t, candidate, connectionId))) return candidate;
  }
  throw conflict(`no free campaign name near "${b}"; choose a distinct campaign name`);
}

/**
 * Resolves a program's campaign: an omitted campaign keeps the existing program's, and a new
 * program gets a unique default from its brand and name (never the legacy shared `eps_daily`).
 * An explicitly chosen campaign that another program already uses is refused with a free
 * alternative, so two programs never write the same store-link identity.
 */
export async function resolveProgramCampaign(t: DbOrTx, args: { requested: string | undefined; current: string | null; connectionId: string; base: string }): Promise<string> {
  if (args.requested === undefined) return args.current ?? (await uniqueCampaign(t, args.base, args.connectionId));
  if (args.requested === args.current) return args.requested;
  if (await campaignTaken(t, args.requested, args.connectionId)) {
    const free = await uniqueCampaign(t, args.requested, args.connectionId);
    throw conflict(`campaign "${args.requested}" is already used by another program (its store links and reports would be mixed). Choose a distinct campaign name, for example "${free}".`);
  }
  return args.requested;
}
