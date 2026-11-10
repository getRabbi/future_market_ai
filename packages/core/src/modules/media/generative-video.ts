import { canonicalJson } from '@futuregrow/contracts';
import { artifactLicenses, assetRights, assets, costLedger, type DbOrTx, mediaJobs, modelRegistry, type Tx, withTenant } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAiBudget } from '../../ai-budget.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { recomputeEligibility, sniffMedia } from '../m14-assets/index.js';
import { recordCost } from '../m24-governance/index.js';
import { assertVideoModeEnabled, isPaidVideoMode, type PaidVideoMode, paidBudgetProblems, paidVideoUsage, type VideoRouting } from './routing.js';
import { promptProblems, storeAsset } from './sources.js';
import { probeGeneratedVideo } from './video-probe.js';

export const GenerativeVideoRequest = z
  .object({
    modelId: z.string().min(1).max(120),
    prompt: z.string().trim().min(5).max(2000),
    seconds: z.number().int().min(1).max(15),
    width: z.number().int().min(256).max(1920),
    height: z.number().int().min(256).max(1920),
    title: z.string().trim().min(1).max(200),
    /** Image-to-video: a cleared, publish-eligible image asset used as the first frame/reference. */
    imageAssetId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type VideoRequest = z.infer<typeof GenerativeVideoRequest>;

/** The API body: the stored request plus the explicit paid authorization and an idempotency key. */
export const GenerativeVideoInput = GenerativeVideoRequest.extend({
  /** Repeating a request with the same key returns the original job; never a second billable one. */
  idempotencyKey: z
    .string()
    .regex(/^[\x21-\x7e]{8,128}$/, '8–128 visible ASCII characters')
    .optional(),
  /** The maximum charge the requester explicitly accepts. Required for every paid job. */
  authorizedMaxUsd: z.number().finite().min(0).max(1000).optional(),
}).strict();

/**
 * provider_reported = the provider returned the charge; estimated_compute = FUTUREGROW estimated GPU
 * time from the worker's own timestamps (not an invoice); unreported = the API returns no charge and
 * the reservation stays until an owner reconciles it from the provider's billing records.
 */
export type VideoCostBasis = 'provider_reported' | 'estimated_compute' | 'unreported';
export type VideoPollResult = { status: 'pending' } | { status: 'failed'; reason: string; actualCostUsd: number | null; costBasis?: VideoCostBasis } | { status: 'succeeded'; bytes: Uint8Array; actualCostUsd: number | null; costBasis?: VideoCostBasis };
export interface VideoStartInput extends VideoRequest {
  idempotencyKey: string;
  maxCostUsd: number;
  signal: AbortSignal;
  /** Present for image-to-video: verified bytes and a short-lived presigned URL (null on the filesystem store). */
  image: { bytes: Uint8Array; mime: string; url: string | null } | null;
}

/** Implement only against verified official APIs. Adapters enforce timeouts, download limits and SSRF-safe output retrieval. */
export interface GenerativeVideoProvider {
  /**
   * True only when the provider documents that a resubmission with the same idempotency key never
   * creates or charges a second generation. Otherwise an ambiguous submission is never retried.
   */
  readonly replaySafe?: boolean;
  readonly imageToVideo?: boolean;
  /** Output sizes the adapter can deliver exactly (the router picks a same-aspect size when needed). */
  readonly sizes?: readonly { width: number; height: number }[];
  /** Wall-clock limit after submission; the runner cancels at the provider and fails the job beyond it. */
  readonly maxRunSeconds?: number;
  start(input: VideoStartInput): Promise<{ operationId: string }>;
  poll(operationId: string, signal: AbortSignal): Promise<VideoPollResult>;
  cancel?(operationId: string, signal: AbortSignal): Promise<{ cancelled: boolean; reason?: string }>;
  supports(input: VideoRequest): boolean;
}

const money = (n: number) => `$${n.toFixed(2)}`;

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

async function lockBudget(t: Tx, tenantId: string) {
  await t.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`video-budget:${tenantId}`}, 0))`);
}

/** Paid switchboard budgets (per video, day, month) and the tenant AI limit. Call under lockBudget. */
async function assertBudgets(t: Tx, deps: CoreDeps, tenantId: string, settings: VideoRouting, maxCost: number) {
  const problems = paidBudgetProblems(settings, await paidVideoUsage(t, tenantId, deps.clock.now()), maxCost);
  if (problems.length) throw forbidden(`Paid video budget: ${problems.join(' ')}`, { code: 'VIDEO_BUDGET' });
  const budget = await getAiBudget(t, tenantId, deps.config, deps.clock.now());
  if (budget.unpricedCalls || (budget.limitUsd !== null && maxCost > (budget.remainingUsd ?? 0))) throw forbidden('AI budget cannot cover this video');
}

/** An image-to-video input must be the tenant's own image with recorded, publish-eligible rights. */
async function imageInput(t: DbOrTx, id: string) {
  const [a] = await t.select().from(assets).where(eq(assets.id, id));
  if (!a) throw notFound('input image');
  if (a.kind !== 'image') throw invalid('image-to-video needs an image asset');
  if (!a.publishEligible) throw forbidden(`input image is not cleared: ${(a.eligibilityReasons ?? []).join('; ') || 'rights not recorded'}`);
  return a;
}

export async function requestGenerativeVideo(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'generating video');
  const { idempotencyKey, authorizedMaxUsd, ...rest } = GenerativeVideoInput.parse(raw);
  const input = GenerativeVideoRequest.parse(rest);
  const ready = await generativeVideoReadiness(t, deps, input.modelId);
  if (ready.missing.length) throw forbidden(`Generative video unavailable: ${ready.missing.join('; ')}`);
  const mode = ready.model!.provider;
  if (!isPaidVideoMode(mode)) throw forbidden(`${mode} is not a video switchboard provider (wan_cloud or higgsfield).`);
  const settings = await assertVideoModeEnabled(t, tenantId, mode);
  if (!deps.videos![mode]!.supports(input)) throw invalid('Adapter does not support these video parameters');
  const problems = await promptProblems(t, input.prompt);
  if (problems.length) throw invalid(problems.join('; '));
  if (input.imageAssetId) await imageInput(t, input.imageAssetId);
  const maxCost = input.seconds * ready.model!.usdPerVideoSecond!;
  if (authorizedMaxUsd === undefined || authorizedMaxUsd + 1e-9 < maxCost) throw forbidden(`Paid generation needs your explicit authorization of the maximum charge (${money(maxCost)}).`, { code: 'PAID_AUTHORIZATION_REQUIRED', maxCostUsd: maxCost });
  const requestSha256 = sha256Hex(canonicalJson(input));
  await lockBudget(t, tenantId);
  if (idempotencyKey) {
    const [prior] = await t
      .select()
      .from(mediaJobs)
      .where(and(eq(mediaJobs.tenantId, tenantId), eq(mediaJobs.idempotencyKey, idempotencyKey)));
    if (prior) {
      if (prior.kind !== 'ai_video' || prior.requestSha256 !== requestSha256) throw conflict('This idempotency key was already used with different request parameters.');
      return prior;
    }
  }
  const [active] = await t
    .select({ id: mediaJobs.id })
    .from(mediaJobs)
    .where(and(eq(mediaJobs.kind, 'ai_video'), eq(mediaJobs.requestSha256, requestSha256), inArray(mediaJobs.status, ['awaiting_approval', 'queued', 'running'])))
    .limit(1);
  if (active) throw conflict(`An identical generation is already pending (job ${active.id}).`);
  await assertBudgets(t, deps, tenantId, settings, maxCost);
  const status = settings.requirePaidApproval ? 'awaiting_approval' : 'queued';
  const [job] = await t
    .insert(mediaJobs)
    .values({
      tenantId,
      kind: 'ai_video',
      provider: mode,
      modelId: input.modelId,
      request: input,
      requestSha256,
      requestedBy: actorRef(actor),
      costUsd: maxCost,
      status,
      statusReason: status === 'awaiting_approval' ? 'Waiting for an owner/admin to approve the paid generation.' : null,
      idempotencyKey: idempotencyKey ?? null,
      provenance: { authorizedMaxUsd, authorizedBy: actorRef(actor) },
      requestedAt: deps.clock.now(),
    })
    .returning();
  await audit(t, tenantId, actor, 'media.video_generation.requested', { type: 'media_job', id: job!.id }, { mode, maxCostUsd: maxCost, authorizedMaxUsd, status });
  return job!;
}

/** Owner/admin (MFA) approval of a paid job: prerequisites and budgets are re-checked under the budget lock. */
export async function approveVideoGeneration(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin'], 'approving paid video generation');
  requireMfa(actor, 'approving paid video generation');
  await lockBudget(t, tenantId);
  const [job] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, id)).for('update');
  if (job?.kind !== 'ai_video') throw notFound('video generation');
  if (job.status !== 'awaiting_approval') throw conflict(`the job is ${job.status}, not awaiting approval`);
  const req = GenerativeVideoRequest.parse(job.request);
  const ready = await generativeVideoReadiness(t, deps, req.modelId);
  if (ready.missing.length || ready.model?.provider !== job.provider || !isPaidVideoMode(job.provider)) throw forbidden(`Generative video unavailable: ${ready.missing.join('; ') || 'provider changed'}`);
  const settings = await assertVideoModeEnabled(t, tenantId, job.provider);
  const maxCost = req.seconds * ready.model.usdPerVideoSecond!;
  if (job.costUsd === null || job.costUsd + 1e-9 < maxCost) throw forbidden('The approved price changed since the request; request the generation again.');
  await assertBudgets(t, deps, tenantId, settings, job.costUsd);
  const [row] = await t
    .update(mediaJobs)
    .set({ status: 'queued', statusReason: null, nextAttemptAt: null, provenance: { ...job.provenance, approvedBy: actorRef(actor), approvedAt: deps.clock.now().toISOString() } })
    .where(eq(mediaJobs.id, id))
    .returning();
  await audit(t, tenantId, actor, 'media.video_generation.approved', { type: 'media_job', id }, { maxCostUsd: job.costUsd, mode: job.provider });
  return row!;
}

/**
 * Before submission a job is simply cancelled (nothing was sent, nothing reserved). After
 * submission the worker asks the provider to cancel on its next step; the reservation stays
 * until the charge is reconciled, because providers may bill work that already started.
 */
export async function cancelVideoGeneration(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'cancelling video generation');
  const [job] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, id)).for('update');
  if (!job || (job.kind !== 'ai_video' && job.kind !== 'video_import')) throw notFound('video job');
  const p = job.provenance as { operationId?: string; billingUnresolved?: boolean };
  if (job.status === 'awaiting_approval' || (job.status === 'queued' && !p.operationId && p.billingUnresolved !== true)) {
    const [row] = await t
      .update(mediaJobs)
      .set({ status: 'cancelled', statusReason: `Cancelled by ${actorRef(actor)} before submission`, finishedAt: deps.clock.now() })
      .where(eq(mediaJobs.id, id))
      .returning();
    await audit(t, tenantId, actor, 'media.video_generation.cancelled', { type: 'media_job', id }, { submitted: false });
    return row!;
  }
  if (job.kind === 'ai_video' && (job.status === 'queued' || job.status === 'running')) {
    const [row] = await t
      .update(mediaJobs)
      .set({ provenance: { ...job.provenance, cancelRequested: true, cancelRequestedBy: actorRef(actor) }, ...(job.status === 'queued' ? { nextAttemptAt: deps.clock.now() } : {}) })
      .where(eq(mediaJobs.id, id))
      .returning();
    await audit(t, tenantId, actor, 'media.video_generation.cancel_requested', { type: 'media_job', id }, { submitted: true });
    return row!;
  }
  throw conflict(`the job is ${job.status}; it can no longer be cancelled`);
}

export const ReconcileSchema = z.object({ actualCostUsd: z.number().finite().min(0).max(10_000), invoiceRef: z.string().trim().min(2).max(200), note: z.string().trim().max(500).optional() }).strict();

/**
 * Records the authoritative provider charge for a finished paid job (from the provider invoice or
 * billing records). The ledger is append-only: the difference to what was recorded (an estimate
 * or nothing) is added as an adjustment row, then the reservation is released.
 */
export async function reconcileVideoCharge(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'finance_approver'], 'reconciling video charges');
  requireMfa(actor, 'reconciling video charges');
  const body = ReconcileSchema.parse(raw);
  await lockBudget(t, tenantId);
  const [job] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, id)).for('update');
  if (job?.kind !== 'ai_video' || !isPaidVideoMode(job.provider)) throw notFound('paid video generation');
  if (['awaiting_approval', 'queued', 'running'].includes(job.status)) throw conflict('wait until the job has finished before reconciling its charge');
  const rows = await t
    .select({ amountUsd: costLedger.amountUsd })
    .from(costLedger)
    .where(and(eq(costLedger.refId, id), eq(costLedger.category, 'video_generation')));
  const recorded = rows.reduce((a, r) => a + (r.amountUsd ?? 0), 0);
  const delta = body.actualCostUsd - recorded;
  if (Math.abs(delta) > 1e-9) await recordCost(t, tenantId, { category: 'video_generation', provider: job.provider, unit: 'invoice_adjustment', quantity: 1, unitCostUsd: delta, refType: 'media_job', refId: id, metadata: { costBasis: 'invoice', invoiceRef: body.invoiceRef, previouslyRecordedUsd: recorded } });
  const billing = { basis: 'invoice', invoiceRef: body.invoiceRef, actualCostUsd: body.actualCostUsd, note: body.note ?? null, reconciledBy: actorRef(actor), reconciledAt: deps.clock.now().toISOString() };
  const [row] = await t
    .update(mediaJobs)
    .set({ costUsd: body.actualCostUsd, provenance: { ...job.provenance, billingUnresolved: false, actualCostUsd: body.actualCostUsd, costBasis: 'invoice', billing } })
    .where(eq(mediaJobs.id, id))
    .returning();
  await audit(t, tenantId, actor, 'media.video_generation.reconciled', { type: 'media_job', id }, { actualCostUsd: body.actualCostUsd, previouslyRecordedUsd: recorded, invoiceRef: body.invoiceRef });
  return row!;
}

type Finish = (status: 'succeeded' | 'failed' | 'blocked' | 'queued' | 'cancelled', reason: string | null, patch?: Partial<typeof mediaJobs.$inferInsert>) => Promise<void>;
type Outcome = { kind: 'retry'; jobId: string; reason: string } | { kind: 'failed' | 'blocked' | 'refused'; jobId: string; reason: string } | { kind: 'succeeded'; jobId: string; assetId: string };

/** One short submit/poll step; the ordinary leased media queue persists the operation between steps. */
export async function runGenerativeVideo(deps: CoreDeps, row: typeof mediaJobs.$inferSelect, finish: Finish): Promise<Outcome> {
  const tctx = { tenantId: row.tenantId, actor: 'system:video-generation' };
  const req = GenerativeVideoRequest.parse(row.request);
  let provenance: Record<string, unknown> = { ...row.provenance };
  const fail = async (reason: string, status: 'failed' | 'blocked' = 'failed'): Promise<Outcome> => {
    await finish(status, reason, { provenance });
    return { kind: status, jobId: row.id, reason };
  };
  const cancelled = async (reason: string): Promise<Outcome> => {
    await finish('cancelled', reason, { provenance });
    return { kind: 'refused', jobId: row.id, reason };
  };
  const later = async (reason: string, ms = 30_000): Promise<Outcome> => {
    await finish('queued', reason, { provenance, nextAttemptAt: new Date(deps.clock.now().getTime() + ms) });
    return { kind: 'retry', jobId: row.id, reason };
  };
  try {
    const provider = deps.videos?.[row.provider];
    const operationId = typeof provenance.operationId === 'string' ? provenance.operationId : null;
    if (provenance.cancelRequested === true && provenance.cancelHandled !== true) {
      if (!operationId) return cancelled(provenance.billingUnresolved === true ? 'Cancelled; an earlier ambiguous submission may still be billed — reconcile the charge.' : 'Cancelled before provider submission.');
      let refusal = 'the provider has no cancellation endpoint';
      if (provider?.cancel) {
        try {
          const c = await provider.cancel(operationId, AbortSignal.timeout(20_000));
          if (c.cancelled) {
            provenance = { ...provenance, cancelledAtProvider: true };
            return cancelled('Cancelled at the provider; the reservation stays until the charge is reconciled.');
          }
          refusal = c.reason ?? 'the provider refused';
        } catch (err) {
          refusal = err instanceof Error ? err.message : String(err);
        }
      }
      // Work already started: keep polling so the output and its charge are captured, not lost.
      provenance = { ...provenance, cancelHandled: true, cancelRefused: refusal };
    }
    const ready = await withTenant(deps.db, tctx, (t) => generativeVideoReadiness(t, deps, req.modelId));
    if (ready.missing.length || ready.model?.provider !== row.provider || !provider) return fail(`Approval/provider unavailable: ${ready.missing.join('; ')}`, 'blocked');
    if (deps.clock.now().getTime() - row.requestedAt.getTime() > 48 * 3_600_000) return fail('Generation timed out; reconcile any unresolved provider charge.');
    if (!operationId) {
      const problems = await withTenant(deps.db, tctx, (t) => promptProblems(t, req.prompt));
      if (problems.length) return fail(problems.join('; '), 'blocked');
      if (!provider.supports(req) || row.costUsd === null || row.costUsd < req.seconds * ready.model!.usdPerVideoSecond!) return fail('Adapter capability or approved price changed; request a new job.', 'blocked');
      // The switchboard can be turned OFF (or paid disabled) after queueing: nothing is submitted then.
      const gate = await withTenant(deps.db, tctx, async (t) => {
        const settings = await assertVideoModeEnabled(t, row.tenantId, row.provider as PaidVideoMode).catch((e: Error) => e);
        if (settings instanceof Error) return settings.message;
        const usage = await paidVideoUsage(t, row.tenantId, deps.clock.now());
        // This job's own reservation is already in usage.reservedUsd (it is running).
        return paidBudgetProblems(settings, usage, 0).join(' ') || null;
      });
      if (gate) return fail(gate, 'blocked');
      const budget = await withTenant(deps.db, tctx, (t) => getAiBudget(t, row.tenantId, deps.config, deps.clock.now()));
      if (budget.unpricedCalls || (budget.limitUsd !== null && budget.spentUsd + budget.reservedUsd > budget.limitUsd)) return fail('AI budget no longer covers queued generation.', 'blocked');
      let image: VideoStartInput['image'] = null;
      if (req.imageAssetId) {
        const a = await withTenant(deps.db, tctx, (t) => imageInput(t, req.imageAssetId!));
        const bytes = await deps.store.get(a.objectKey);
        if (!bytes || sha256Hex(bytes) !== a.sha256) return fail('The input image is missing or changed since it was cleared.', 'blocked');
        image = { bytes, mime: a.mime, url: await deps.store.presign(a.objectKey, 'GET', 900) };
      }
      // Persist unresolved billing BEFORE any external write. A crash must not release the reservation.
      provenance = { ...provenance, billingUnresolved: true, submittedAt: provenance.submittedAt ?? deps.clock.now().toISOString() };
      await withTenant(deps.db, tctx, (t) => t.update(mediaJobs).set({ provenance }).where(eq(mediaJobs.id, row.id)));
      let started: { operationId: string };
      try {
        started = await provider.start({ ...req, image, idempotencyKey: `futuregrow:${row.tenantId}:${row.id}`, maxCostUsd: row.costUsd, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        // Only a provider that documents replay-safe idempotency keys may see the same submission again.
        if (provider.replaySafe && row.attempts < 3) return later(`Submission outcome unknown; retrying with the same idempotency key: ${err instanceof Error ? err.message : String(err)}`, 60_000 * 2 ** row.attempts);
        throw err;
      }
      if (!started.operationId || started.operationId.length > 500) throw invalid('Invalid provider operation identity');
      provenance = { ...provenance, operationId: started.operationId };
      return later('Provider generation submitted');
    }
    const submittedAt = typeof provenance.submittedAt === 'string' ? Date.parse(provenance.submittedAt) : Number.NaN;
    if (provider.maxRunSeconds && Number.isFinite(submittedAt) && deps.clock.now().getTime() - submittedAt > provider.maxRunSeconds * 1000) {
      const c = await provider.cancel?.(operationId, AbortSignal.timeout(20_000)).catch(() => null);
      provenance = { ...provenance, cancelledAtProvider: Boolean(c?.cancelled) };
      return fail(`Provider run exceeded ${provider.maxRunSeconds}s${c?.cancelled ? ' and was cancelled' : ''}; reconcile the charge.`);
    }
    const result = await provider.poll(operationId, AbortSignal.timeout(20_000));
    if (result.status === 'pending') return later('Provider generation pending');
    const cost = result.actualCostUsd;
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw invalid('Provider billing is unavailable; reservation retained.');
    const costBasis: VideoCostBasis = cost === null ? 'unreported' : (result.costBasis ?? 'provider_reported');
    if (cost !== null) {
      await withTenant(deps.db, tctx, async (t) => {
        const [lease] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, row.id)).for('update');
        if (lease?.status !== 'running' || lease.leaseOwner !== row.leaseOwner) throw invalid('Generation lease was lost');
        const [charged] = await t
          .select()
          .from(costLedger)
          .where(and(eq(costLedger.refId, row.id), eq(costLedger.category, 'video_generation')));
        if (!charged) await recordCost(t, row.tenantId, { category: 'video_generation', provider: row.provider, unit: 'generation', quantity: 1, unitCostUsd: cost, refType: 'media_job', refId: row.id, metadata: { operationId, modelId: row.modelId, costBasis } });
      });
      provenance = { ...provenance, billingUnresolved: false, actualCostUsd: cost, costBasis };
    } else {
      // No verifiable charge: the full reservation stays until an owner reconciles it.
      provenance = { ...provenance, billingUnresolved: true, costBasis, billing: { basis: 'unreported', note: 'The provider API reports no charge; reconcile from its billing records.' } };
    }
    if (result.status === 'failed') return fail(result.reason);
    if (cost !== null && cost > (row.costUsd ?? 0)) return fail('Provider exceeded its approved charge cap; output blocked for review.');
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
        content: { modelId: row.modelId, operationId, requestSha256: row.requestSha256, outputSha256: sha256Hex(result.bytes), qa, licenceId: current.licence!.id, costBasis, imageAssetId: req.imageAssetId },
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
    await finish('succeeded', cost === null ? 'Output stored. The provider reported no charge: reconcile it from the billing records.' : null, { assetId, provenance, costUsd: cost ?? row.costUsd });
    return { kind: 'succeeded', jobId: row.id, assetId };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
