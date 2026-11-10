import { canonicalJson } from '@futuregrow/contracts';
import { artifactLicenses, assetRights, assets, mediaJobs, type Tx, withTenant } from '@futuregrow/db';
import { invalid, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { recomputeEligibility, sniffMedia } from '../m14-assets/index.js';
import { VIDEO_PRESETS, type VideoPreset } from './formats.js';
import { assertVideoModeEnabled, GOOGLE_FLOW_URL } from './routing.js';
import { storeAsset } from './sources.js';
import { probeGeneratedVideo } from './video-probe.js';

/**
 * Google Flow import (manual mode). Flow has no automated free API, so the owner generates the
 * clip in Flow with their own Google account, downloads the MP4 and uploads it here. FUTUREGROW
 * never automates the Flow website or touches Flow credits. The upload is staged, then the media
 * worker runs technical QA (ffprobe), records provenance and the uploader's rights attestation,
 * and stores an AI-disclosed video asset that Remotion scenes and the Video Studio can use.
 */
export const MAX_FLOW_IMPORT_BYTES = 100 * 1024 * 1024;
export const MAX_FLOW_IMPORT_SECONDS = 90;
/** Artifact licence record that documents Google's generative-AI terms for Flow output (Governance › licences). */
export const FLOW_LICENCE_NAME = 'google/flow';

export const FlowImportMetaSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** When set, the clip's aspect ratio must match the preset. */
    preset: z
      .enum(Object.keys(VIDEO_PRESETS) as [VideoPreset, ...VideoPreset[]])
      .nullable()
      .default(null),
    prompt: z.string().trim().max(2000).default(''),
    flowProjectUrl: z.string().url().startsWith('https://').max(500).nullable().default(null),
    attestation: z
      .object({
        /** The clip was generated with Google Flow under the uploader's own Google account. */
        generatedWithGoogleFlow: z.literal(true),
        ownAccount: z.literal(true),
        /** The uploader confirms their Google plan terms permit commercial use of this output. */
        commercialUseConfirmed: z.boolean(),
        containsPeople: z.boolean(),
        containsMusic: z.boolean(),
        containsVoice: z.boolean(),
        containsThirdPartyBrands: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type FlowImportMeta = z.infer<typeof FlowImportMetaSchema>;

export async function requestFlowImport(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, metaRaw: unknown, bytes: Uint8Array) {
  requireRole(actor, ['owner', 'admin', 'growth_operator'], 'importing a Google Flow clip');
  await assertVideoModeEnabled(t, tenantId, 'google_flow', 'import');
  const meta = FlowImportMetaSchema.parse(metaRaw);
  if (meta.attestation.containsThirdPartyBrands) throw invalid('Clips showing third-party brands or logos cannot be imported; regenerate without them.');
  if (bytes.byteLength === 0) throw invalid('empty upload');
  if (bytes.byteLength > MAX_FLOW_IMPORT_BYTES) throw invalid(`the clip exceeds ${MAX_FLOW_IMPORT_BYTES / 1024 / 1024} MB`);
  if (sniffMedia(bytes).mime !== 'video/mp4') throw invalid('Google Flow imports must be MP4 files');
  const sha = sha256Hex(bytes);
  const requestSha256 = sha256Hex(canonicalJson({ sha256: sha, meta }));
  const [prior] = await t
    .select()
    .from(mediaJobs)
    .where(and(eq(mediaJobs.kind, 'video_import'), eq(mediaJobs.requestSha256, requestSha256), inArray(mediaJobs.status, ['queued', 'running', 'succeeded'])))
    .limit(1);
  if (prior) return { job: prior, duplicate: true };
  const [existing] = await t.select({ id: assets.id }).from(assets).where(eq(assets.sha256, sha));
  if (existing) throw invalid(`this clip is already in the asset library (asset ${existing.id})`);
  const put = await deps.store.put(tenantKey(tenantId, 'imports', sha), bytes, 'video/mp4');
  const [job] = await t
    .insert(mediaJobs)
    .values({ tenantId, kind: 'video_import', provider: 'google_flow', request: { objectKey: put.key, sha256: sha, bytes: bytes.byteLength, meta }, requestSha256, costUsd: 0, requestedBy: actorRef(actor), requestedAt: deps.clock.now() })
    .returning();
  await audit(t, tenantId, actor, 'media.video_import.requested', { type: 'media_job', id: job!.id }, { sha256: sha, bytes: bytes.byteLength, commercialUseConfirmed: meta.attestation.commercialUseConfirmed });
  return { job: job!, duplicate: false };
}

type Finish = (status: 'succeeded' | 'failed' | 'blocked' | 'queued' | 'cancelled', reason: string | null, patch?: Partial<typeof mediaJobs.$inferInsert>) => Promise<void>;

/** Worker step: verify the staged bytes, probe, then store the asset with provenance and attested rights. */
export async function runVideoImport(deps: CoreDeps, row: typeof mediaJobs.$inferSelect, finish: Finish) {
  const tctx = { tenantId: row.tenantId, actor: 'system:video-import' };
  const req = row.request as { objectKey: string; sha256: string; meta: unknown };
  const done = async (status: 'failed' | 'blocked', reason: string) => {
    await deps.store.delete(req.objectKey).catch(() => {});
    await finish(status, reason);
    return { kind: status, jobId: row.id, reason };
  };
  try {
    const meta = FlowImportMetaSchema.parse(req.meta);
    const off = await withTenant(deps.db, tctx, (t) =>
      assertVideoModeEnabled(t, row.tenantId, 'google_flow', 'import').then(
        () => null,
        (e: Error) => e.message,
      ),
    );
    if (off) return done('blocked', off);
    const bytes = await deps.store.get(req.objectKey);
    if (!bytes || sha256Hex(bytes) !== req.sha256) return done('failed', 'The staged upload is missing or changed.');
    if (bytes.byteLength > MAX_FLOW_IMPORT_BYTES || sniffMedia(bytes).mime !== 'video/mp4') return done('failed', 'Not an MP4 within the size limit.');
    let qa: Awaited<ReturnType<typeof probeGeneratedVideo>>;
    try {
      qa = await (deps.videoProbe ?? probeGeneratedVideo)(bytes, { allowAudio: true });
    } catch (err) {
      return done('failed', `Technical QA failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const problems: string[] = [];
    if (qa.seconds < 1 || qa.seconds > MAX_FLOW_IMPORT_SECONDS) problems.push(`duration ${qa.seconds.toFixed(1)}s is outside 1–${MAX_FLOW_IMPORT_SECONDS}s`);
    if (Math.min(qa.width, qa.height) < 256 || Math.max(qa.width, qa.height) > 4096) problems.push(`${qa.width}×${qa.height} is outside the supported size range`);
    if (meta.preset) {
      const p = VIDEO_PRESETS[meta.preset];
      if (Math.abs(qa.width / qa.height - p.width / p.height) > 0.01) problems.push(`aspect ratio ${qa.width}×${qa.height} does not match ${meta.preset}`);
    }
    if (problems.length) return done('failed', `Technical QA failed: ${problems.join('; ')}`);
    const a = meta.attestation;
    const assetId = await withTenant(deps.db, tctx, async (t) => {
      const [lease] = await t.select().from(mediaJobs).where(eq(mediaJobs.id, row.id)).for('update');
      if (lease?.status !== 'running' || lease.leaseOwner !== row.leaseOwner) throw invalid('Import lease was lost');
      const [licence] = await t
        .select()
        .from(artifactLicenses)
        .where(and(eq(artifactLicenses.exactName, FLOW_LICENCE_NAME), eq(artifactLicenses.approvedForProduction, true)))
        .limit(1);
      const ev = await admitInternalEvidence(t, row.tenantId, systemActor('video-import'), {
        kind: 'document',
        owner: 'google_flow',
        uri: `google-flow-import://${row.id}`,
        content: { sha256: req.sha256, qa, prompt: meta.prompt, flowProjectUrl: meta.flowProjectUrl, flowUrl: GOOGLE_FLOW_URL, attestation: a, attestedBy: row.requestedBy },
        summary: `Google Flow clip imported by ${row.requestedBy} with a rights attestation; requires visual review`,
        confidence: 1,
        license: a.commercialUseConfirmed ? 'Google Flow output; uploader attests their Google terms permit commercial use' : 'Google Flow output; commercial use not confirmed',
        permittedUses: ['creative_generation', 'publishing'],
        now: deps.clock.now(),
      });
      const asset = await storeAsset(t, deps, row.tenantId, {
        bytes,
        mime: 'video/mp4',
        kind: 'video',
        title: meta.title,
        origin: 'generated',
        width: qa.width,
        height: qa.height,
        manifest: {
          importJobId: row.id,
          generator: 'google_flow',
          contains: { aiGenerated: true, likeness: a.containsPeople, music: a.containsMusic, voice: a.containsVoice },
          hasAudio: qa.hasAudio ?? false,
          durationSeconds: qa.seconds,
          provenanceEvidenceId: ev.evidenceId,
          claimIds: [],
        },
        disclosure: { isAiGenerated: true, disclosureText: 'AI-generated video (Google Flow)' },
      });
      const [rights] = await t.select().from(assetRights).where(eq(assetRights.assetId, asset.id)).limit(1);
      if (!rights) {
        const commercialUse = a.commercialUseConfirmed ? 'allowed' : 'unknown';
        await t.insert(assetRights).values({ tenantId: row.tenantId, assetId: asset.id, component: 'source_media', rightsHolder: `${row.requestedBy} (Google Flow attestation)`, licenseRef: 'Google Flow output under the uploader’s Google account terms', commercialUse, evidenceId: ev.evidenceId });
        // The model component needs the reviewed Google terms recorded once as an artifact licence.
        if (licence) await t.insert(assetRights).values({ tenantId: row.tenantId, assetId: asset.id, component: 'model', rightsHolder: 'Google', licenseRef: licence.exactName, artifactLicenseId: licence.id, commercialUse: licence.commercialUse, evidenceId: ev.evidenceId });
      }
      await recomputeEligibility(t, deps, row.tenantId, asset.id);
      return asset.id;
    });
    await deps.store.delete(req.objectKey).catch(() => {});
    await finish('succeeded', null, { assetId, provenance: { qa, sha256: req.sha256 } });
    return { kind: 'succeeded' as const, jobId: row.id, assetId };
  } catch (err) {
    if ((err as { code?: unknown }).code === 'FORBIDDEN') return done('blocked', (err as Error).message);
    return done('failed', err instanceof Error ? err.message : String(err));
  }
}
