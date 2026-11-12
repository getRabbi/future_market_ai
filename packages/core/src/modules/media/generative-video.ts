import { canonicalJson } from '@futuregrow/contracts';
import { artifactLicenses, assetRights, costLedger, type DbOrTx, mediaJobs, modelRegistry, type Tx, withTenant } from '@futuregrow/db';
import { forbidden, invalid, sha256Hex } from '@futuregrow/observability';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAiBudget } from '../../ai-budget.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { recomputeEligibility, sniffMedia } from '../m14-assets/index.js';
import { recordCost } from '../m24-governance/index.js';
import { promptProblems, storeAsset } from './sources.js';
import { probeGeneratedVideo } from './video-probe.js';

export const GenerativeVideoRequest = z.object({ modelId: z.string().min(1).max(120), prompt: z.string().trim().min(5).max(2000), seconds: z.number().int().min(1).max(15), width: z.number().int().min(256).max(1920), height: z.number().int().min(256).max(1920), title: z.string().trim().min(1).max(200) }).strict();
export type VideoRequest = z.infer<typeof GenerativeVideoRequest>;
/** Implement only against verified official APIs. Adapters enforce timeouts, download limits and SSRF-safe output retrieval. */
export interface GenerativeVideoProvider {
  /** Must guarantee replay-safe submission for the same key and enforce the quoted total charge cap. */
  start(input: VideoRequest & { idempotencyKey: string; maxCostUsd: number; signal: AbortSignal }): Promise<{ operationId: string }>;
  poll(operationId: string, signal: AbortSignal): Promise<{ status: 'pending' } | { status: 'failed'; reason: string; actualCostUsd: number } | { status: 'succeeded'; bytes: Uint8Array; actualCostUsd: number }>;
  supports(input: VideoRequest): boolean;
}

export async function generativeVideoReadiness(t: DbOrTx, deps: Pick<CoreDeps, 'videos'>, modelId?: string) {
  const candidates = await t.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
  const model = candidates.find((m) => (!modelId || m.modelId === modelId) && m.purposes.includes('video_generation') && m.status === 'active' && m.commercialUse === 'allowed' && m.trainingOnCustomerData === 'no') ?? null;
  const provider = model ? deps.videos?.[model.provider] : undefined;
  const licence = model
    ? ((
        await t
          .select()
          .from(artifactLicenses)
          .where(and(eq(artifactLicenses.exactName, `${model.provider}/${model.modelId}`), eq(artifactLicenses.approvedForProduction, true), eq(artifactLicenses.commercialUse, 'allowed')))
          .limit(1)
      )[0] ?? null)
    : null;
  const missing = [
    ...(!model ? ['an approved video_generation model with commercial rights and no training on customer data'] : []),
    ...(!provider ? ['a verified generative-video provider adapter and server credentials'] : []),
    ...(!licence ? ['an approved output licence record matching provider/model'] : []),
    ...(model?.usdPerVideoSecond == null || !Number.isFinite(model.usdPerVideoSecond) || model.usdPerVideoSecond < 0 ? ['a reviewed maximum USD price per output second'] : []),
  ];
  return { model, licence, missing, providerConfigured: Boolean(provider) };
}

export async function requestGenerativeVideo(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'generating video');
  const input = GenerativeVideoRequest.parse(raw);
  const ready = await generativeVideoReadiness(t, deps, input.modelId);
  if (ready.missing.length) throw forbidden(`Generative video unavailable: ${ready.missing.join('; ')}`);
  if (!deps.videos![ready.model!.provider]!.supports(input)) throw invalid('Adapter does not support these video parameters');
  const problems = await promptProblems(t, input.prompt);
  if (problems.length) throw invalid(problems.join('; '));
  await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video-budget:${tenantId}`}, 0))`);
  const maxCost = input.seconds * ready.model!.usdPerVideoSecond!;
  const budget = await getAiBudget(t, tenantId, deps.config, deps.clock.now());
  if (budget.unpricedCalls || (budget.limitUsd !== null && maxCost > (budget.remainingUsd ?? 0))) throw forbidden('AI budget cannot cover this video');
  const [job] = await t
    .insert(mediaJobs)
    .values({ tenantId, kind: 'ai_video', provider: ready.model!.provider, modelId: input.modelId, request: input, requestSha256: sha256Hex(canonicalJson(input)), requestedBy: actorRef(actor), costUsd: maxCost, requestedAt: deps.clock.now() })
    .returning();
  await audit(t, tenantId, actor, 'media.video_generation.requested', { type: 'media_job', id: job!.id }, { maxCostUsd: maxCost });
  return job!;
}

type Finish = (status: 'succeeded' | 'failed' | 'blocked' | 'queued', reason: string | null, patch?: Partial<typeof mediaJobs.$inferInsert>) => Promise<void>;
/** One short submit/poll step; the ordinary leased media queue persists the operation between steps. */
export async function runGenerativeVideo(deps: CoreDeps, row: typeof mediaJobs.$inferSelect, finish: Finish) {
  const tctx = { tenantId: row.tenantId, actor: 'system:video-generation' };
  const req = GenerativeVideoRequest.parse(row.request);
  let provenance = { ...row.provenance };
  const fail = async (reason: string, status: 'failed' | 'blocked' = 'failed') => {
    await finish(status, reason, { provenance });
    return { kind: status, jobId: row.id, reason };
  };
  try {
    const ready = await withTenant(deps.db, tctx, (t) => generativeVideoReadiness(t, deps, req.modelId));
    if (ready.missing.length || ready.model?.provider !== row.provider) return fail(`Approval/provider unavailable: ${ready.missing.join('; ')}`, 'blocked');
    if (deps.clock.now().getTime() - row.requestedAt.getTime() > 48 * 3_600_000) return fail('Generation timed out; reconcile any unresolved provider charge.');
    const provider = deps.videos![row.provider]!;
    const operationId = typeof provenance.operationId === 'string' ? provenance.operationId : null;
    if (!operationId) {
      const problems = await withTenant(deps.db, tctx, (t) => promptProblems(t, req.prompt));
      if (problems.length) return fail(problems.join('; '), 'blocked');
      if (!provider.supports(req) || row.costUsd === null || row.costUsd < req.seconds * ready.model!.usdPerVideoSecond!) return fail('Adapter capability or approved price changed; request a new job.', 'blocked');
      const budget = await withTenant(deps.db, tctx, (t) => getAiBudget(t, row.tenantId, deps.config, deps.clock.now()));
      if (budget.unpricedCalls || (budget.limitUsd !== null && budget.spentUsd + budget.reservedUsd > budget.limitUsd)) return fail('AI budget no longer covers queued generation.', 'blocked');
      // Persist unresolved billing BEFORE any external write. A crash must not release the reservation.
      provenance = { ...provenance, billingUnresolved: true };
      await withTenant(deps.db, tctx, (t) => t.update(mediaJobs).set({ provenance }).where(eq(mediaJobs.id, row.id)));
      const started = await provider.start({ ...req, idempotencyKey: `futuregrow:${row.tenantId}:${row.id}`, maxCostUsd: row.costUsd, signal: AbortSignal.timeout(20_000) });
      if (!started.operationId || started.operationId.length > 500) throw invalid('Invalid provider operation identity');
      provenance = { ...provenance, operationId: started.operationId };
      await finish('queued', 'Provider generation submitted', { provenance, nextAttemptAt: new Date(deps.clock.now().getTime() + 30_000) });
      return { kind: 'retry' as const, jobId: row.id, reason: 'provider pending' };
    }
    const result = await provider.poll(operationId, AbortSignal.timeout(20_000));
    if (result.status === 'pending') {
      await finish('queued', 'Provider generation pending', { provenance, nextAttemptAt: new Date(deps.clock.now().getTime() + 30_000) });
      return { kind: 'retry' as const, jobId: row.id, reason: 'provider pending' };
    }
    if (!Number.isFinite(result.actualCostUsd) || result.actualCostUsd < 0) throw invalid('Provider billing is unavailable; reservation retained.');
    await withTenant(deps.db, tctx, async (t) => {
      const [lease] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, row.id)).for('update');
      if (lease?.status !== 'running' || lease.leaseOwner !== row.leaseOwner) throw invalid('Generation lease was lost');
      const [charged] = await t
        .select()
        .from(costLedger)
        .where(and(eq(costLedger.refId, row.id), eq(costLedger.category, 'video_generation')));
      if (!charged) await recordCost(t, row.tenantId, { category: 'video_generation', provider: row.provider, unit: 'generation', quantity: 1, unitCostUsd: result.actualCostUsd, refType: 'media_job', refId: row.id, metadata: { operationId, modelId: row.modelId } });
    });
    provenance = { ...provenance, billingUnresolved: false, actualCostUsd: result.actualCostUsd };
    if (result.status === 'failed') return fail(result.reason);
    if (result.actualCostUsd > (row.costUsd ?? 0)) return fail('Provider exceeded its approved charge cap; output blocked for review.');
    if (!result.bytes.length || result.bytes.length > 100_000_000 || sniffMedia(result.bytes).mime !== 'video/mp4') return fail('Invalid or oversized MP4 output');
    const qa = await (deps.videoProbe ?? probeGeneratedVideo)(result.bytes);
    if (qa.width !== req.width || qa.height !== req.height || !Number.isFinite(qa.seconds) || Math.abs(qa.seconds - req.seconds) > 0.5) return fail('Output dimensions or duration failed QA');
    const assetId = await withTenant(deps.db, tctx, async (t) => {
      const [lease] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, row.id)).for('update');
      if (lease?.status !== 'running' || lease.leaseOwner !== row.leaseOwner) throw invalid('Generation lease was lost');
      const current = await generativeVideoReadiness(t, deps, req.modelId);
      if (current.missing.length) throw forbidden('Model or licence revoked while processing output');
      const ev = await admitInternalEvidence(t, row.tenantId, systemActor('video-generation'), {
        kind: 'document',
        owner: row.provider,
        uri: `generated-video://${row.id}`,
        content: { modelId: row.modelId, operationId, requestSha256: row.requestSha256, outputSha256: sha256Hex(result.bytes), qa, licenceId: current.licence!.id },
        summary: `Generated video from ${row.provider}/${row.modelId}; requires visual review`,
        confidence: 1,
        license: current.licence!.licenseIdOrCustomTerms,
        permittedUses: ['creative_generation', 'publishing'],
        now: deps.clock.now(),
      });
      const asset = await storeAsset(t, deps, row.tenantId, {
        bytes: result.bytes,
        mime: 'video/mp4',
        kind: 'video',
        title: req.title,
        origin: 'generated',
        width: qa.width,
        height: qa.height,
        manifest: { generationJobId: row.id, contains: { aiGenerated: true, likeness: true, music: false, voice: false }, provenanceEvidenceId: ev.evidenceId, claimIds: [] },
        disclosure: { isAiGenerated: true, disclosureText: 'AI-generated video' },
      });
      const [rights] = await t.select().from(assetRights).where(eq(assetRights.assetId, asset.id)).limit(1);
      if (!rights)
        await t.insert(assetRights).values(['source_media', 'model'].map((component) => ({ tenantId: row.tenantId, assetId: asset.id, component, rightsHolder: row.provider, licenseRef: current.licence!.exactName, artifactLicenseId: current.licence!.id, commercialUse: 'allowed', evidenceId: ev.evidenceId })));
      // Unknown likeness rights deliberately keep generated clips out of publishing until reviewed.
      await recomputeEligibility(t, deps, row.tenantId, asset.id);
      return asset.id;
    });
    await finish('succeeded', null, { assetId, provenance, costUsd: result.actualCostUsd });
    return { kind: 'succeeded' as const, jobId: row.id, assetId };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
