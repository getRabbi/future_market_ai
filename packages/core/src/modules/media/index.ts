import { assets, connections, type DbOrTx } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import type { CoreDeps } from '../../deps.js';
import { generativeVideoReadiness } from './generative-video.js';
import { imageModelReadiness, stockLicence } from './sources.js';
import { speechReadiness } from './voice.js';

export * as flowImport from './flow-import.js';
export * as generativeVideo from './generative-video.js';
export * as videoRouting from './routing.js';
export * as sources from './sources.js';
export * as video from './video.js';
export * as videoAdapters from './video-adapters.js';
export * as videoJobs from './video-jobs.js';
export * as voice from './voice.js';

/**
 * Provider-neutral creative media (D-044). The studio asks for an image of a format; a provider
 * returns bytes with provenance, licence and a content hash; one QA gate decides whether it may be
 * used. New sources (a stock library, an image model) are added as providers without changing the
 * studio. A provider is enabled only when its credentials AND its rights record exist.
 */

export { MEDIA_FORMATS, type MediaFormat } from './formats.js';

import { MEDIA_FORMATS, type MediaFormat } from './formats.js';

export type MediaProviderKind = 'template_card' | 'verified_asset' | 'stock_image' | 'ai_image' | 'ai_voice' | 'ai_video';

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

/** A licensed stock library (Pexels, P3-03): a connected API key and an approved stock_media licence record for the Pexels License. */
export const stockImages: MediaProvider = {
  id: 'stock-library',
  kind: 'stock_image',
  async status(ctx) {
    const [conn] = await ctx.t
      .select({ id: connections.id, healthStatus: connections.healthStatus })
      .from(connections)
      .where(and(eq(connections.provider, 'pexels'), eq(connections.status, 'active')))
      .limit(1);
    const licence = await stockLicence(ctx.t);
    const missing = [...(conn ? [] : ['a connected Pexels API key (Connections)']), ...(licence ? [] : ['an approved stock_media licence record for the Pexels License (Governance › licences)'])];
    return missing.length
      ? { id: this.id, kind: this.kind, enabled: false, reason: 'No licensed stock library is ready; the branded templates are used instead.', requires: missing, adapter: 'available', prerequisitesMet: false }
      : { id: this.id, kind: this.kind, enabled: true, reason: `Pexels under licence record "${licence!.exactName}": search and import photos and videos; every import records its author, attribution and licence.`, requires: [], adapter: 'available', prerequisitesMet: true };
  },
};

/** An image-generation model (P3-02): registry-approved for image_generation, priced, configured on this server, with an approved licence record. */
export const aiImages: MediaProvider = {
  id: 'ai-image-model',
  kind: 'ai_image',
  async status(ctx) {
    const r = await imageModelReadiness(ctx.t, ctx.deps);
    return r.missing.length
      ? { id: this.id, kind: this.kind, enabled: false, reason: 'No image-generation model is ready for production (B-011); illustrations come from the branded templates.', requires: r.missing, adapter: 'available', prerequisitesMet: false }
      : { id: this.id, kind: this.kind, enabled: true, reason: `${r.model!.provider}/${r.model!.modelId} is approved at about $${r.model!.usdPerImage} per image; every image is labelled AI-generated and counts toward the AI spending limit.`, requires: [], adapter: 'available', prerequisitesMet: true };
  },
};

/** A speech model for voiceovers (P3-04): registry-approved for speech_generation, priced per character, configured, with an approved licence record. */
export const aiVoice: MediaProvider = {
  id: 'ai-voice-model',
  kind: 'ai_voice',
  async status(ctx) {
    const r = await speechReadiness(ctx.t, ctx.deps);
    return r.missing.length
      ? { id: this.id, kind: this.kind, enabled: false, reason: 'No speech model is ready for production; videos use text and subtitles, or an uploaded voice recording with recorded voice rights.', requires: r.missing, adapter: 'available', prerequisitesMet: false }
      : {
          id: this.id,
          kind: this.kind,
          enabled: true,
          reason: `${r.model!.provider}/${r.model!.modelId} is approved at about $${r.model!.usdPerMillionChars} per million characters; voices are synthetic stock voices, every voiceover is labelled AI-generated and counts toward the AI spending limit.`,
          requires: [],
          adapter: 'available',
          prerequisitesMet: true,
        };
  },
};

/**
 * Generative video models (text/image → video). No provider is approved and FUTUREGROW has no
 * adapter: commercial terms, likeness and disclosure rules for generated video are not reviewed.
 * Videos are rendered from licensed scenes in the Video Studio instead.
 */
export const aiVideo: MediaProvider = {
  id: 'ai-video-model',
  kind: 'ai_video',
  async status(ctx) {
    const ready = await generativeVideoReadiness(ctx.t, ctx.deps);
    return {
      id: this.id,
      kind: this.kind,
      enabled: ready.missing.length === 0,
      reason: ready.missing.length ? 'Generative video is unavailable until a verified adapter, model pricing and output licence are approved.' : 'Approved adapter configured. Generated silent clips require technical QA and likeness-rights review before use.',
      requires: ready.missing,
      adapter: ready.providerConfigured ? 'available' : 'not_built',
      prerequisitesMet: ready.missing.length === 0,
    };
  },
};

export const MEDIA_PROVIDERS: readonly MediaProvider[] = [templateCards, verifiedAssets, stockImages, aiImages, aiVoice, aiVideo];

export async function mediaProviders(ctx: MediaContext): Promise<MediaProviderStatus[]> {
  const out: MediaProviderStatus[] = [];
  for (const p of MEDIA_PROVIDERS) out.push(await p.status(ctx));
  return out;
}
