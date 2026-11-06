import { artifactLicenses, assets, type DbOrTx, modelRegistry } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import type { CoreDeps } from '../../deps.js';

/**
 * Provider-neutral creative media (D-044). The studio asks for an image of a format; a provider
 * returns bytes with provenance, licence and a content hash; one QA gate decides whether it may be
 * used. New sources (a stock library, an image model) are added as providers without changing the
 * studio. A provider is enabled only when its credentials AND its rights record exist.
 */

export const MEDIA_FORMATS = {
  portrait_4x5: { width: 1080, height: 1350 },
  square_1x1: { width: 1080, height: 1080 },
  landscape_191x1: { width: 1200, height: 628 },
  story_9x16: { width: 1080, height: 1920 },
} as const;
export type MediaFormat = keyof typeof MEDIA_FORMATS;

export type MediaProviderKind = 'template_card' | 'verified_asset' | 'stock_image' | 'ai_image';

export interface MediaLicense {
  ref: string;
  commercialUse: 'allowed' | 'restricted' | 'unknown';
  attribution: string | null;
}

export interface MediaCandidate {
  providerId: string;
  kind: MediaProviderKind;
  mime: string;
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  aiGenerated: boolean;
  license: MediaLicense;
  provenance: Record<string, unknown>;
}

export interface MediaProviderStatus {
  id: string;
  kind: MediaProviderKind;
  /** True only when FUTUREGROW can actually produce media from it now (adapter built and prerequisites met). */
  enabled: boolean;
  reason: string;
  /** What must exist before this provider can be enabled. */
  requires: string[];
  /** Whether FUTUREGROW has code that fetches or generates media from this provider. */
  adapter: 'available' | 'not_built';
  /** Credentials and rights records exist (independent of the adapter). */
  prerequisitesMet: boolean;
}

/**
 * Stock and AI images have readiness checks but no execution adapter yet (deferred scope, D-044):
 * meeting their prerequisites never makes them usable on its own.
 */
const NO_ADAPTER = 'no FUTUREGROW adapter fetches or generates these images yet (deferred), so the branded templates are used';

export interface MediaContext {
  t: DbOrTx;
  deps: CoreDeps;
  tenantId: string;
}

export interface MediaProvider {
  id: string;
  kind: MediaProviderKind;
  status(ctx: MediaContext): Promise<MediaProviderStatus>;
}

/* ------------------------------------------------------------------ */
/* QA gate: nothing unlicensed, mis-sized or unverifiable is used      */
/* ------------------------------------------------------------------ */

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

export function mediaQa(c: MediaCandidate, format: MediaFormat): { passed: boolean; problems: string[] } {
  const problems: string[] = [];
  const want = MEDIA_FORMATS[format];
  if (!IMAGE_MIMES.includes(c.mime)) problems.push(`unsupported media type ${c.mime}`);
  if (sha256Hex(Buffer.from(c.bytes)) !== c.sha256) problems.push('content hash does not match the bytes');
  if (c.width < want.width || c.height < want.height) problems.push(`${c.width}×${c.height} is smaller than ${want.width}×${want.height}`);
  if (Math.abs(c.width / c.height - want.width / want.height) > 0.01) problems.push(`aspect ${(c.width / c.height).toFixed(3)} does not match ${format}`);
  if (c.license.commercialUse !== 'allowed') problems.push(`licence ${c.license.ref} does not allow commercial use (${c.license.commercialUse})`);
  if (!Object.keys(c.provenance).length) problems.push('no provenance recorded');
  if (c.kind === 'ai_image' && !c.aiGenerated) problems.push('an AI image must carry the AI-generated disclosure');
  return { passed: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

/** The branded card renderer (@futuregrow/visuals): tenant-owned templates, OFL fonts, no third-party imagery. */
export const templateCards: MediaProvider = {
  id: 'futuregrow-cards',
  kind: 'template_card',
  async status() {
    return { id: this.id, kind: this.kind, enabled: true, reason: 'Bundled renderer: tenant-owned templates, Noto fonts under SIL OFL 1.1, rendered locally with QA (contrast, overflow, minimum text size).', requires: [], adapter: 'available', prerequisitesMet: true };
  },
};

/** Owner-supplied images (app screenshots, product photos) that passed M14 rights and publish eligibility. */
export const verifiedAssets: MediaProvider = {
  id: 'verified-assets',
  kind: 'verified_asset',
  async status(ctx) {
    // M14 stores publish eligibility whenever rights change; a status read never recomputes (no writes).
    const eligible = (
      await ctx.t
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.kind, 'image'), eq(assets.origin, 'upload'), eq(assets.publishEligible, true)))
        .limit(50)
    ).length;
    return eligible
      ? { id: this.id, kind: this.kind, enabled: true, reason: `${eligible} uploaded image${eligible === 1 ? '' : 's'} with recorded rights are publish-eligible.`, requires: [], adapter: 'available', prerequisitesMet: true }
      : {
          id: this.id,
          kind: this.kind,
          enabled: false,
          reason: 'No uploaded image (for example an app screenshot) has recorded rights and passed publish eligibility.',
          requires: ['an uploaded image asset', 'asset rights covering every component', 'publish eligibility (M14)'],
          adapter: 'available',
          prerequisitesMet: false,
        };
  },
};

/** A licensed stock library. Needs the vendor key and a production-approved stock_media licence record. */
export const stockImages: MediaProvider = {
  id: 'stock-library',
  kind: 'stock_image',
  async status(ctx) {
    const vendor = ctx.deps.config.media?.stockProvider ?? null;
    const [licence] = await ctx.t
      .select({ id: artifactLicenses.id, name: artifactLicenses.exactName })
      .from(artifactLicenses)
      .where(and(eq(artifactLicenses.artifactType, 'stock_media'), eq(artifactLicenses.commercialUse, 'allowed'), eq(artifactLicenses.approvedForProduction, true)))
      .limit(1);
    const missing = [...(vendor ? [] : ['a configured stock vendor and API key']), ...(licence ? [] : ['an approved stock_media licence record with commercial use allowed'])];
    const requires = [...missing, 'a stock-library adapter (not built yet)'];
    return missing.length
      ? { id: this.id, kind: this.kind, enabled: false, reason: 'No licensed stock library is configured; the branded templates are used instead.', requires, adapter: 'not_built', prerequisitesMet: false }
      : { id: this.id, kind: this.kind, enabled: false, reason: `${vendor} under licence "${licence!.name}" is configured, but ${NO_ADAPTER}.`, requires, adapter: 'not_built', prerequisitesMet: true };
  },
};

/** An image-generation model. Needs a production-approved registry entry for image generation with commercial use allowed. */
export const aiImages: MediaProvider = {
  id: 'ai-image-model',
  kind: 'ai_image',
  async status(ctx) {
    const models = await ctx.t.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
    const usable = models.find((m) => m.purposes.includes('image_generation') && m.commercialUse === 'allowed' && m.trainingOnCustomerData === 'no');
    return usable
      ? { id: this.id, kind: this.kind, enabled: false, reason: `${usable.provider}/${usable.modelId} is approved for image generation, but ${NO_ADAPTER}.`, requires: ['an image-generation adapter (not built yet)'], adapter: 'not_built', prerequisitesMet: true }
      : {
          id: this.id,
          kind: this.kind,
          enabled: false,
          reason: 'No image-generation model is approved for production (B-011); illustrations come from the branded templates.',
          requires: ['an image model approved for image_generation', 'commercial use allowed', 'no training on customer data', 'an image-generation adapter (not built yet)'],
          adapter: 'not_built',
          prerequisitesMet: false,
        };
  },
};

export const MEDIA_PROVIDERS: readonly MediaProvider[] = [templateCards, verifiedAssets, stockImages, aiImages];

export async function mediaProviders(ctx: MediaContext): Promise<MediaProviderStatus[]> {
  const out: MediaProviderStatus[] = [];
  for (const p of MEDIA_PROVIDERS) out.push(await p.status(ctx));
  return out;
}
