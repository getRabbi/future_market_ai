import { closestSize, ImageProviderError, type PlannedCall } from '@futuregrow/agent-kernel';
import { type ConnectorContext, PEXELS_LICENSE, ProviderHttpError, pexelsDownload, pexelsGet, pexelsSearch, type StockCandidate } from '@futuregrow/connectors';
import { canonicalJson } from '@futuregrow/contracts';
import { artifactLicenses, assetRights, assets, connections, type DbOrTx, mediaJobs, modelRegistry, protectedIdentities, stockAssets, type Tx, withSystem, withTenant } from '@futuregrow/db';
import { forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { coverFit } from '@futuregrow/visuals';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAiBudget, guardAiCall, releaseAiCall } from '../../ai-budget.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { readContext } from '../connections.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { recomputeEligibility, sniffMedia } from '../m14-assets/index.js';
import { recordCost } from '../m24-governance/index.js';
import { MEDIA_FORMATS, type MediaFormat } from './formats.js';

/**
 * Licensed stock media (P3-03) and AI image generation (P3-02). Both run as queued media jobs: a
 * request is validated and hashed, a worker leases it, and it succeeds only with a stored asset
 * whose bytes, provenance and rights are recorded. Stock needs a connected Pexels key and an
 * approved stock_media licence record; AI images need a registry-approved image model with a
 * price, a configured provider, an approved model licence record and room in the AI budget.
 * Nothing is downloaded or generated without those, and no provider is called during a status read.
 */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 10 * 60_000;
const FORMAT_KEYS = Object.keys(MEDIA_FORMATS) as [MediaFormat, ...MediaFormat[]];

/* ------------------------------------------------------------------ */
/* Licence and model prerequisites                                     */
/* ------------------------------------------------------------------ */

/** The tenant's approved licence record for Pexels content (artifact type stock_media). */
export async function stockLicence(t: DbOrTx) {
  const rows = await t
    .select()
    .from(artifactLicenses)
    .where(and(eq(artifactLicenses.artifactType, 'stock_media'), eq(artifactLicenses.commercialUse, 'allowed'), eq(artifactLicenses.approvedForProduction, true)));
  return rows.find((r) => /pexels/i.test(`${r.exactName} ${r.licenseIdOrCustomTerms} ${r.sourceUrl ?? ''}`)) ?? null;
}

export interface ImageModelReadiness {
  model: { provider: string; modelId: string; usdPerImage: number | null } | null;
  providerConfigured: boolean;
  licence: { id: string; name: string } | null;
  missing: string[];
}

/** Whether an image model can be used now, and what is missing. Reads only; calls no provider. */
export async function imageModelReadiness(t: DbOrTx, deps: Pick<CoreDeps, 'images'>, modelId?: string): Promise<ImageModelReadiness> {
  const models = await t.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
  const usable = models.filter((m) => m.purposes.includes('image_generation') && m.commercialUse === 'allowed' && m.trainingOnCustomerData === 'no' && m.status === 'active' && (!modelId || m.modelId === modelId));
  const m = usable[0] ?? null;
  const missing: string[] = [];
  if (!m) missing.push('an image model approved for image_generation (commercial use allowed, no training on customer data)');
  const providerConfigured = Boolean(m && deps.images?.[m.provider]);
  if (m && !providerConfigured) missing.push(`the ${m.provider} image provider is not configured on this server`);
  let licence: { id: string; name: string } | null = null;
  if (m) {
    const [l] = await t
      .select({ id: artifactLicenses.id, name: artifactLicenses.exactName })
      .from(artifactLicenses)
      .where(and(eq(artifactLicenses.exactName, `${m.provider}/${m.modelId}`), eq(artifactLicenses.approvedForProduction, true), eq(artifactLicenses.commercialUse, 'allowed')))
      .limit(1);
    licence = l ?? null;
    if (!licence) missing.push(`an approved licence record named "${m.provider}/${m.modelId}" for the model's output terms (Governance › licences)`);
    if (m.usdPerImage === null) missing.push('a per-image price in the model registry (unpriced image models are not used)');
  }
  return { model: m ? { provider: m.provider, modelId: m.modelId, usdPerImage: m.usdPerImage } : null, providerConfigured, licence, missing };
}

/* ------------------------------------------------------------------ */
/* Stock: search and import                                            */
/* ------------------------------------------------------------------ */

export const StockSearchSchema = z
  .object({
    connectionId: z.string().uuid(),
    mediaType: z.enum(['photo', 'video']).default('photo'),
    query: z.string().trim().min(2).max(200),
    orientation: z.enum(['landscape', 'portrait', 'square']).optional(),
    page: z.number().int().min(1).max(100).default(1),
  })
  .strict();

/** Searches the licensed library; results show which items this organization already imported. */
export async function searchStock(deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES, 'analyst'], 'searching stock media');
  const q = StockSearchSchema.parse(raw);
  const { ctx } = await readContext(deps, tenantId, q.connectionId, 'pexels');
  const result = await pexelsSearch(ctx, q.mediaType, { query: q.query, orientation: q.orientation, page: q.page, perPage: 24 });
  const imported = result.items.length
    ? await withTenant(deps.db, { tenantId, actor: actorRef(actor) }, (t) =>
        t
          .select({ externalId: stockAssets.externalId, format: stockAssets.format, assetId: stockAssets.assetId, revokedAt: stockAssets.revokedAt })
          .from(stockAssets)
          .where(
            and(
              eq(stockAssets.provider, 'pexels'),
              eq(stockAssets.mediaType, q.mediaType),
              inArray(
                stockAssets.externalId,
                result.items.map((i) => i.externalId),
              ),
            ),
          ),
      )
    : [];
  return { ...result, licence: PEXELS_LICENSE, items: result.items.map((i) => ({ ...i, imported: imported.filter((x) => x.externalId === i.externalId && !x.revokedAt).map((x) => ({ format: x.format, assetId: x.assetId })) })) };
}

export const StockImportSchema = z
  .object({
    connectionId: z.string().uuid(),
    mediaType: z.enum(['photo', 'video']),
    externalId: z.string().regex(/^\d{1,20}$/),
    /** Photos are cover-fitted to a studio format; videos keep their own size ("original"). */
    format: z.enum([...FORMAT_KEYS, 'original']).default('portrait_4x5'),
  })
  .strict()
  .refine((x) => (x.mediaType === 'video') === (x.format === 'original'), 'videos are imported as "original"; photos need a studio format');

async function enqueue(t: Tx, tenantId: string, actor: Actor, v: { kind: 'ai_image' | 'stock_import'; provider: string; modelId?: string | null; connectionId?: string | null; request: Record<string, unknown> }) {
  const [job] = await t
    .insert(mediaJobs)
    .values({ tenantId, kind: v.kind, provider: v.provider, modelId: v.modelId ?? null, connectionId: v.connectionId ?? null, request: v.request, requestSha256: sha256Hex(canonicalJson(v.request)), requestedBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, `media.${v.kind}.requested`, { type: 'media_job', id: job!.id }, { provider: v.provider, modelId: v.modelId ?? null, request: v.kind === 'ai_image' ? { ...v.request, prompt: clipText(String(v.request.prompt ?? ''), 200) } : v.request });
  return job!;
}

export async function requestStockImport(t: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'importing stock media');
  const input = StockImportSchema.parse(raw);
  const [conn] = await t.select().from(connections).where(eq(connections.id, input.connectionId));
  if (conn?.provider !== 'pexels') throw invalid('choose a connected Pexels account');
  if (!(await stockLicence(t))) throw forbidden('record the Pexels License (https://www.pexels.com/license/) as an approved stock_media licence in Governance before importing; nothing was downloaded');
  const [existing] = await t
    .select()
    .from(stockAssets)
    .where(and(eq(stockAssets.provider, 'pexels'), eq(stockAssets.externalId, input.externalId), eq(stockAssets.mediaType, input.mediaType), eq(stockAssets.format, input.format), isNull(stockAssets.revokedAt)));
  if (existing) return { duplicate: true as const, assetId: existing.assetId, job: null };
  const [pending] = await t
    .select()
    .from(mediaJobs)
    .where(and(eq(mediaJobs.kind, 'stock_import'), inArray(mediaJobs.status, ['queued', 'running']), sql`${mediaJobs.request}->>'externalId' = ${input.externalId}`, sql`${mediaJobs.request}->>'format' = ${input.format}`));
  if (pending) return { duplicate: true as const, assetId: null, job: pending };
  return { duplicate: false as const, assetId: null, job: await enqueue(t, tenantId, actor, { kind: 'stock_import', provider: 'pexels', connectionId: input.connectionId, request: input }) };
}

/* ------------------------------------------------------------------ */
/* AI images                                                           */
/* ------------------------------------------------------------------ */

export const ImageRequestSchema = z
  .object({
    prompt: z.string().trim().min(10).max(2000),
    format: z.enum(FORMAT_KEYS).default('portrait_4x5'),
    modelId: z.string().max(120).optional(),
    quality: z.enum(['low', 'medium', 'high']).default('medium'),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Content that is never requested from an image model (likeness and child-safety rules apply before the provider's own moderation). */
const PROHIBITED = [/\b(child|children|kid|kids|minor|minors|teen|teenager|schoolgirl|schoolboy|baby)\b/i, /\b(nude|naked|sexual|nsfw|porn)\b/i, /\b(logo of|in the style of|by the artist)\b/i];

export async function promptProblems(t: DbOrTx, prompt: string): Promise<string[]> {
  const out: string[] = [];
  if (PROHIBITED[0]!.test(prompt)) out.push('prompts must not depict children or minors');
  if (PROHIBITED[1]!.test(prompt)) out.push('sexual content is not generated');
  if (PROHIBITED[2]!.test(prompt)) out.push('prompts must not copy a third party’s logo or a named artist’s style');
  const lower = prompt.toLowerCase();
  const protectedNames = await t.select({ name: protectedIdentities.normalizedName }).from(protectedIdentities);
  for (const p of protectedNames) if (p.name && lower.includes(p.name.toLowerCase())) out.push(`prompts must not name a protected identity (${p.name})`);
  return out;
}

export async function requestImageGeneration(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'generating images');
  const input = ImageRequestSchema.parse(raw);
  const ready = await imageModelReadiness(t, deps, input.modelId);
  if (ready.missing.length) throw forbidden(`AI image generation is not enabled: ${ready.missing.join('; ')}`);
  const problems = await promptProblems(t, input.prompt);
  if (problems.length) throw invalid(`prompt refused: ${problems.join('; ')}`);
  const budget = await getAiBudget(t, tenantId, deps.config, deps.clock.now());
  if (budget.limitUsd !== null && (budget.remainingUsd ?? 0) < (ready.model!.usdPerImage ?? Number.POSITIVE_INFINITY)) throw forbidden(`the AI spending limit has $${(budget.remainingUsd ?? 0).toFixed(2)} left this month; one image costs about $${ready.model!.usdPerImage}`);
  return enqueue(t, tenantId, actor, { kind: 'ai_image', provider: ready.model!.provider, modelId: ready.model!.modelId, request: { ...input, modelId: ready.model!.modelId } });
}

/* ------------------------------------------------------------------ */
/* Worker: lease and run one job                                       */
/* ------------------------------------------------------------------ */

export type MediaJobOutcome = { kind: 'none' } | { kind: 'succeeded'; jobId: string; assetId: string } | { kind: 'retry'; jobId: string; reason: string } | { kind: 'failed' | 'refused' | 'blocked'; jobId: string; reason: string };

export async function storeAsset(t: Tx, deps: CoreDeps, tenantId: string, v: { bytes: Uint8Array; mime: string; kind: 'image' | 'video' | 'audio'; title: string; origin: 'stock' | 'generated'; width: number | null; height: number | null; manifest: Record<string, unknown>; disclosure: Record<string, unknown> }) {
  const sha = sha256Hex(v.bytes);
  const [dup] = await t.select().from(assets).where(eq(assets.sha256, sha));
  if (dup) return dup;
  const put = await deps.store.put(tenantKey(tenantId, 'assets', sha), v.bytes, v.mime);
  const [row] = await t
    .insert(assets)
    .values({
      tenantId,
      kind: v.kind,
      title: v.title,
      objectKey: put.key,
      sha256: sha,
      mime: v.mime,
      bytes: put.bytes,
      width: v.width,
      height: v.height,
      origin: v.origin,
      manifest: v.manifest,
      qa: { technical: { passed: true, mime: v.mime, width: v.width, height: v.height } },
      disclosure: v.disclosure,
      createdBy: 'system:media-sources',
    })
    .returning();
  return row!;
}

async function runStock(_deps: CoreDeps, job: typeof mediaJobs.$inferSelect, ctx: ConnectorContext) {
  const req = job.request as z.infer<typeof StockImportSchema>;
  const item: StockCandidate = await pexelsGet(ctx, req.mediaType, req.externalId);
  const file = await pexelsDownload(ctx, item);
  const sniff = sniffMedia(file.bytes);
  let bytes = file.bytes;
  let mime = sniff.mime ?? '';
  let width = sniff.width ?? item.width;
  let height = sniff.height ?? item.height;
  if (req.mediaType === 'photo') {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error(`downloaded file is ${mime || 'unrecognised'}, not a photo`);
    const f = MEDIA_FORMATS[req.format as MediaFormat];
    const fitted = await coverFit(bytes, mime, f.width, f.height);
    bytes = fitted.png;
    mime = 'image/png';
    width = fitted.width;
    height = fitted.height;
  } else if (mime !== 'video/mp4') throw new Error(`downloaded file is ${mime || 'unrecognised'}, not an MP4 video`);
  return { item, bytes, mime, width, height, sourceSha256: sha256Hex(file.bytes) };
}

/**
 * Leases the oldest due job (FOR UPDATE SKIP LOCKED, crash-safe lease), runs it and records the
 * outcome. Retryable provider failures (rate limits, outages) back off up to three attempts;
 * refusals and missing prerequisites are terminal and never retried.
 */
export async function processNextMediaJob(deps: CoreDeps, workerId = `media-sources:${process.pid}`): Promise<MediaJobOutcome> {
  const now = deps.clock.now();
  const job = await withSystem(deps.db, 'system:media-sources', async (tx) => {
    const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
      update media_jobs set status = 'running', attempts = attempts + 1, lease_owner = ${workerId}, lease_until = ${new Date(now.getTime() + LEASE_MS)}
      where id = (
        select id from media_jobs
        where (status = 'queued' and (next_attempt_at is null or next_attempt_at <= ${now})) or (status = 'running' and lease_until < ${now})
        order by requested_at for update skip locked limit 1)
      returning id, tenant_id`);
    return r.rows[0] ?? null;
  });
  if (!job) return { kind: 'none' };
  const tenantId = job.tenant_id;
  const actor = systemActor('media-sources');
  const tctx = { tenantId, actor: 'system:media-sources' };
  const [row] = await withTenant(deps.db, tctx, (t) => t.select().from(mediaJobs).where(eq(mediaJobs.id, job.id)));
  const finish = async (status: 'succeeded' | 'failed' | 'refused' | 'blocked' | 'queued' | 'cancelled', reason: string | null, patch: Partial<typeof mediaJobs.$inferInsert> = {}) => {
    await withTenant(deps.db, tctx, async (t) => {
      await t
        .update(mediaJobs)
        .set({ status, statusReason: reason ? clipText(reason, 2000) : null, leaseOwner: null, leaseUntil: null, finishedAt: status === 'queued' ? null : deps.clock.now(), ...patch })
        .where(and(eq(mediaJobs.id, job.id), eq(mediaJobs.leaseOwner, workerId), eq(mediaJobs.status, 'running')));
      await audit(t, tenantId, actor, `media.${row!.kind}.${status === 'queued' ? 'retry_scheduled' : status}`, { type: 'media_job', id: job.id }, { reason: reason ? clipText(reason, 300) : null, attempts: row!.attempts, ...(patch.assetId ? { assetId: patch.assetId } : {}) });
    });
  };
  const retryOrFail = async (reason: string, retryable: boolean): Promise<MediaJobOutcome> => {
    if (retryable && row!.attempts < MAX_ATTEMPTS) {
      await finish('queued', reason, { nextAttemptAt: new Date(deps.clock.now().getTime() + 60_000 * 2 ** row!.attempts) });
      return { kind: 'retry', jobId: job.id, reason };
    }
    await finish('failed', reason);
    return { kind: 'failed', jobId: job.id, reason };
  };

  if (row!.kind === 'ai_video') {
    const { runGenerativeVideo } = await import('./generative-video.js');
    return runGenerativeVideo(deps, row!, finish);
  }

  if (row!.kind === 'video_import') {
    const { runVideoImport } = await import('./flow-import.js');
    return runVideoImport(deps, row!, finish);
  }

  if (row!.kind === 'voiceover') {
    const { runVoiceover } = await import('./voice.js');
    return runVoiceover(deps, row!, { finish, retryOrFail: retryOrFail as never, storeAsset });
  }

  if (row!.kind === 'stock_import') {
    const licence = await withTenant(deps.db, tctx, (t) => stockLicence(t));
    if (!licence) {
      await finish('blocked', 'the approved stock_media licence record was withdrawn before the import ran');
      return { kind: 'blocked', jobId: job.id, reason: 'licence' };
    }
    let out: Awaited<ReturnType<typeof runStock>>;
    try {
      const { ctx } = await readContext(deps, tenantId, row!.connectionId!, 'pexels');
      out = await runStock(deps, row!, ctx);
    } catch (err) {
      // Only provider-side throttling and outages are retried; refusals before sending, auth errors and bad files are terminal.
      const e = err as { status?: number | null; phase?: string; message?: string };
      const status = typeof e.status === 'number' ? e.status : null;
      const providerError = err instanceof ProviderHttpError;
      return retryOrFail(e.message ?? String(err), providerError && (status === 429 || (status !== null && status >= 500) || (status === null && e.phase === 'ambiguous')));
    }
    const req = row!.request as z.infer<typeof StockImportSchema>;
    const assetId = await withTenant(deps.db, tctx, async (t) => {
      const ev = await admitInternalEvidence(t, tenantId, actor, {
        kind: 'document',
        owner: 'pexels',
        uri: `${out.item.pageUrl}#${req.format}`,
        content: { provider: 'pexels', externalId: out.item.externalId, mediaType: req.mediaType, pageUrl: out.item.pageUrl, author: out.item.author, authorUrl: out.item.authorUrl, license: PEXELS_LICENSE, downloadedSha256: out.sourceSha256, storedFormat: req.format },
        summary: `${out.item.attribution} (${PEXELS_LICENSE.name})`,
        confidence: 1,
        license: `${PEXELS_LICENSE.name} ${PEXELS_LICENSE.url}`,
        permittedUses: ['creative_generation', 'publishing'],
        now: deps.clock.now(),
      });
      const asset = await storeAsset(t, deps, tenantId, {
        bytes: out.bytes,
        mime: out.mime,
        kind: req.mediaType === 'photo' ? 'image' : 'video',
        title: clipText(`${out.item.attribution}${out.item.description ? ` — ${out.item.description}` : ''}`, 200),
        origin: 'stock',
        width: out.width,
        height: out.height,
        manifest: {
          contains: { music: false, voice: false, likeness: false, aiGenerated: false },
          captions: '',
          claimIds: [],
          source: { provider: 'pexels', externalId: out.item.externalId, pageUrl: out.item.pageUrl, author: out.item.author, attribution: out.item.attribution, restrictions: PEXELS_LICENSE.restrictions },
          provenanceEvidenceId: ev.evidenceId,
        },
        disclosure: { isAiGenerated: false, syntheticPersonaId: null },
      });
      const [has] = await t
        .select({ id: assetRights.id })
        .from(assetRights)
        .where(and(eq(assetRights.assetId, asset.id), eq(assetRights.component, 'source_media')));
      if (!has) await t.insert(assetRights).values({ tenantId, assetId: asset.id, component: 'source_media', rightsHolder: out.item.author, licenseRef: `${PEXELS_LICENSE.name} (${out.item.pageUrl})`, artifactLicenseId: licence.id, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null });
      await t
        .insert(stockAssets)
        .values({
          tenantId,
          provider: 'pexels',
          externalId: out.item.externalId,
          mediaType: req.mediaType,
          format: req.format,
          assetId: asset.id,
          pageUrl: out.item.pageUrl,
          author: out.item.author,
          authorUrl: out.item.authorUrl,
          attribution: out.item.attribution,
          license: PEXELS_LICENSE,
          artifactLicenseId: licence.id,
          importedBy: row!.requestedBy,
        })
        .onConflictDoNothing();
      await recomputeEligibility(t, deps, tenantId, asset.id);
      return asset.id;
    });
    await finish('succeeded', null, { assetId, provenance: { pageUrl: out.item.pageUrl, author: out.item.author, sourceSha256: out.sourceSha256 } });
    return { kind: 'succeeded', jobId: job.id, assetId };
  }

  // ---------------- AI image ----------------
  const req = row!.request as z.infer<typeof ImageRequestSchema> & { modelId: string };
  const ready = await withTenant(deps.db, tctx, (t) => imageModelReadiness(t, deps, req.modelId));
  if (ready.missing.length) {
    await finish('blocked', `no longer enabled: ${ready.missing.join('; ')}`);
    return { kind: 'blocked', jobId: job.id, reason: ready.missing.join('; ') };
  }
  const problems = await withTenant(deps.db, tctx, (t) => promptProblems(t, req.prompt));
  if (problems.length) {
    await finish('refused', problems.join('; '));
    return { kind: 'refused', jobId: job.id, reason: problems.join('; ') };
  }
  const provider = deps.images![ready.model!.provider]!;
  const target = MEDIA_FORMATS[req.format];
  const size = closestSize(provider.sizes(req.modelId), target)!;
  const call: PlannedCall = { provider: ready.model!.provider, modelId: req.modelId, purpose: 'image_generation', maxCostUsd: ready.model!.usdPerImage };
  let image: Awaited<ReturnType<typeof provider.generate>>;
  try {
    await guardAiCall(deps.db, deps.config, tenantId, call, deps.clock.now());
  } catch (err) {
    await finish('blocked', err instanceof Error ? err.message : String(err));
    return { kind: 'blocked', jobId: job.id, reason: 'budget' };
  }
  try {
    image = await provider.generate({ model: req.modelId, prompt: req.prompt, size, quality: req.quality });
  } catch (err) {
    releaseAiCall(call);
    if (err instanceof ImageProviderError && err.kind === 'refused') {
      await finish('refused', err.message);
      return { kind: 'refused', jobId: job.id, reason: err.message };
    }
    return retryOrFail(err instanceof Error ? err.message : String(err), err instanceof ImageProviderError ? err.retryable : true);
  }
  releaseAiCall(call);
  const fitted = await coverFit(image.bytes, image.mime, target.width, target.height);
  const assetId = await withTenant(deps.db, tctx, async (t) => {
    await recordCost(t, tenantId, {
      category: 'image_generation',
      provider: ready.model!.provider,
      unit: 'images',
      quantity: 1,
      unitCostUsd: ready.model!.usdPerImage,
      refType: 'media_job',
      refId: job.id,
      metadata: { model: req.modelId, quality: req.quality, size: `${size.width}x${size.height}`, requestId: image.requestId },
    });
    const ev = await admitInternalEvidence(t, tenantId, actor, {
      kind: 'document',
      owner: 'futuregrow-media-sources',
      uri: `generated://${job.id}`,
      content: { mediaJobId: job.id, provider: ready.model!.provider, modelId: req.modelId, prompt: req.prompt, revisedPrompt: image.revisedPrompt, providerSize: size, format: req.format, outputSha256: sha256Hex(image.bytes), requestId: image.requestId, licenceRecord: ready.licence },
      summary: `AI image from ${ready.model!.provider}/${req.modelId}`,
      confidence: 1,
      license: `generated output under the ${ready.model!.provider} terms recorded as "${ready.licence!.name}"`,
      permittedUses: ['creative_generation', 'publishing'],
      now: deps.clock.now(),
    });
    const asset = await storeAsset(t, deps, tenantId, {
      bytes: fitted.png,
      mime: 'image/png',
      kind: 'image',
      title: req.title ?? clipText(`AI image: ${req.prompt}`, 200),
      origin: 'generated',
      width: fitted.width,
      height: fitted.height,
      manifest: { contains: { music: false, voice: false, likeness: false, aiGenerated: true }, captions: '', claimIds: [], model: { provider: ready.model!.provider, modelId: req.modelId, prompt: req.prompt, revisedPrompt: image.revisedPrompt }, provenanceEvidenceId: ev.evidenceId },
      disclosure: { isAiGenerated: true, syntheticPersonaId: null },
    });
    const existing = await t.select({ component: assetRights.component }).from(assetRights).where(eq(assetRights.assetId, asset.id));
    if (!existing.length) {
      await t.insert(assetRights).values([
        { tenantId, assetId: asset.id, component: 'source_media', rightsHolder: 'tenant (generated output)', licenseRef: `generated by ${ready.model!.provider}/${req.modelId}`, artifactLicenseId: null, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null },
        { tenantId, assetId: asset.id, component: 'model', rightsHolder: ready.model!.provider, licenseRef: ready.licence!.name, artifactLicenseId: ready.licence!.id, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null },
      ]);
    }
    await recomputeEligibility(t, deps, tenantId, asset.id);
    return asset.id;
  });
  await finish('succeeded', null, { assetId, costUsd: ready.model!.usdPerImage, provenance: { model: req.modelId, requestId: image.requestId, size } });
  return { kind: 'succeeded', jobId: job.id, assetId };
}

/* ------------------------------------------------------------------ */
/* Licence revocation, reads                                           */
/* ------------------------------------------------------------------ */

/** Withdraws a stock asset's licence (e.g. the provider removed the item): the asset stops being publish-eligible at once. */
export async function revokeStockAsset(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, assetId: string, reason: string) {
  requireRole(actor, ['owner', 'admin', 'legal_approver'], 'revoking a stock licence');
  if (reason.trim().length < 3) throw invalid('say why the licence is revoked');
  const rows = await t
    .select()
    .from(stockAssets)
    .where(and(eq(stockAssets.assetId, assetId), isNull(stockAssets.revokedAt)));
  if (!rows.length) throw notFound('active stock asset');
  const now = deps.clock.now();
  await t
    .update(stockAssets)
    .set({ revokedAt: now, revokedReason: clipText(reason, 500) })
    .where(eq(stockAssets.assetId, assetId));
  await t
    .update(assetRights)
    .set({ expiresAt: now })
    .where(and(eq(assetRights.assetId, assetId), eq(assetRights.component, 'source_media')));
  await audit(t, tenantId, actor, 'media.stock.revoked', { type: 'asset', id: assetId }, { reason: clipText(reason, 200) });
  return recomputeEligibility(t, deps, tenantId, assetId);
}

/** Re-evaluates stock assets whose licence record is no longer approved (daily sweep). */
export async function recheckStockLicences(t: Tx, deps: CoreDeps, tenantId: string): Promise<number> {
  const rows = await t.select({ assetId: stockAssets.assetId, approved: artifactLicenses.approvedForProduction }).from(stockAssets).leftJoin(artifactLicenses, eq(artifactLicenses.id, stockAssets.artifactLicenseId)).where(isNull(stockAssets.revokedAt));
  let changed = 0;
  for (const r of rows.filter((x) => !x.approved)) {
    const a = await recomputeEligibility(t, deps, tenantId, r.assetId);
    if (!a.publishEligible) changed++;
  }
  return changed;
}

export async function listMediaJobs(t: DbOrTx) {
  return t.select().from(mediaJobs).orderBy(desc(mediaJobs.requestedAt)).limit(200);
}

export async function mediaJob(t: DbOrTx, id: string) {
  const [j] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, id));
  if (!j) throw notFound('media job');
  return j;
}

export async function listStockAssets(t: DbOrTx) {
  return t.select().from(stockAssets).orderBy(desc(stockAssets.importedAt)).limit(500);
}
