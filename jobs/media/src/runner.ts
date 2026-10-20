import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetsModule, type CoreDeps, evidence, record, systemActor } from '@futuregrow/core';
import { assetRights, assets, renderJobs, tenantSettings, withSystem, withTenant } from '@futuregrow/db';
import { sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { and, eq, inArray, sql } from 'drizzle-orm';

export interface RenderInput {
  file: string;
  mime: string;
  bytes: Uint8Array;
}

export interface RenderedVideo {
  path: string;
  metadata: { width: number; height: number; fps: number; durationInSeconds: number | null; codec: string; canPlayInVideoTag: boolean };
  engineVersion: string;
}

/** Rendering engine boundary (Remotion in production). */
export interface Renderer {
  render(args: { composition: string; props: Record<string, unknown>; inputs: RenderInput[]; jobId: string }): Promise<RenderedVideo>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Remotion + its bundled FFmpeg/ffprobe (D-005). The bundle is built once per process. */
export class RemotionRenderer implements Renderer {
  private bundleDir: Promise<string> | null = null;

  private async bundleOnce(): Promise<string> {
    if (!this.bundleDir) {
      this.bundleDir = (async () => {
        const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-remotion-'));
        // Container images ship a bundle built at image-build time; copy it so job inputs can be
        // written into its public/ directory without touching the read-only image layer.
        const prebuilt = process.env.FG_REMOTION_BUNDLE_DIR;
        if (prebuilt) {
          await fs.cp(prebuilt, outDir, { recursive: true });
          return outDir;
        }
        const { bundle } = await import('@remotion/bundler');
        return bundle({ entryPoint: path.join(here, 'remotion', 'Root.tsx'), outDir, publicDir: null });
      })();
    }
    return this.bundleDir;
  }

  async render(args: { composition: string; props: Record<string, unknown>; inputs: RenderInput[]; jobId: string }): Promise<RenderedVideo> {
    const { ensureBrowser, getVideoMetadata, renderMedia, selectComposition } = await import('@remotion/renderer');
    await ensureBrowser();
    const serveUrl = await this.bundleOnce();
    const pub = path.join(serveUrl, 'public', args.jobId);
    await fs.mkdir(pub, { recursive: true });
    const media: { file: string; mime: string }[] = [];
    for (const i of args.inputs) {
      await fs.writeFile(path.join(pub, i.file), i.bytes);
      media.push({ file: `${args.jobId}/${i.file}`, mime: i.mime });
    }
    const inputProps = { ...args.props, media };
    // Remotion ids allow only [a-zA-Z0-9-]; internal names use underscores.
    const composition = await selectComposition({ serveUrl, id: args.composition.replaceAll('_', '-'), inputProps });
    const outputLocation = path.join(os.tmpdir(), `fg-render-${args.jobId}.mp4`);
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation, inputProps, concurrency: Number(process.env.RENDER_CONCURRENCY ?? 1) });
    // getVideoMetadata is deprecated upstream in favour of Mediabunny; it remains functional in 4.0.x.
    const md = await getVideoMetadata(outputLocation);
    await fs.rm(pub, { recursive: true, force: true });
    const { VERSION } = await import('remotion/version');
    return {
      path: outputLocation,
      metadata: { width: md.width, height: md.height, fps: md.fps, durationInSeconds: md.durationInSeconds, codec: md.codec, canPlayInVideoTag: md.canPlayInVideoTag },
      engineVersion: `remotion@${VERSION}`,
    };
  }
}

export type RenderOutcome = { kind: 'none' } | { kind: 'completed'; jobId: string; assetId: string } | { kind: 'failed'; jobId: string; reason: string } | { kind: 'blocked'; jobId: string; reason: string };

const MAX_ATTEMPTS = 3;
const ext = (mime: string) => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3' })[mime] ?? 'bin';

export async function processNextRender(deps: CoreDeps, renderer: Renderer, workerId = `media:${process.pid}`): Promise<RenderOutcome> {
  const job = await withSystem(deps.db, 'system:media-job', async (tx) => {
    await tx.execute(sql`update render_jobs set status = 'queued', locked_by = null where status = 'rendering' and started_at < now() - interval '2 hours'`);
    const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
      update render_jobs set status = 'rendering', started_at = now(), attempts = attempts + 1, locked_by = ${workerId}
      where id = (select id from render_jobs where status = 'queued' and attempts < ${MAX_ATTEMPTS} order by requested_at for update skip locked limit 1)
      returning id, tenant_id`);
    return r.rows[0] ?? null;
  });
  if (!job) return { kind: 'none' };
  const tenantId = job.tenant_id;
  const actor = systemActor('media-job');
  const tctx = { tenantId, actor: 'system:media-job' };

  const fail = async (reason: string, terminal = false): Promise<RenderOutcome> => {
    await withTenant(deps.db, tctx, async (tx) => {
      const [j] = await tx.select().from(renderJobs).where(eq(renderJobs.id, job.id));
      const final = terminal || (j?.attempts ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
      await tx
        .update(renderJobs)
        .set({ status: final ? 'failed' : 'queued', statusReason: reason.slice(0, 2000), lockedBy: null, finishedAt: final ? new Date() : null })
        .where(eq(renderJobs.id, job.id));
    });
    return { kind: 'failed', jobId: job.id, reason };
  };

  try {
    const prep = await withTenant(deps.db, tctx, async (tx) => {
      const [j] = await tx.select().from(renderJobs).where(eq(renderJobs.id, job.id));
      const [settings] = await tx.select().from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
      const inputs = await tx.select().from(assets).where(inArray(assets.id, j!.inputAssetIds));
      const rights = await tx.select().from(assetRights).where(inArray(assetRights.assetId, j!.inputAssetIds));
      return { j: j!, licence: settings?.remotionLicense ?? null, inputs, rights };
    });
    if (!prep.licence) {
      await withTenant(deps.db, tctx, (tx) => tx.update(renderJobs).set({ status: 'blocked_license', statusReason: 'Remotion licence eligibility not recorded (B-014)', lockedBy: null }).where(eq(renderJobs.id, job.id)));
      return { kind: 'blocked', jobId: job.id, reason: 'remotion licence' };
    }
    const cfg = prep.j.workflowConfig as { composition: string; width: number; height: number; fps: number; durationInFrames: number; props: Record<string, unknown>; inputs: { assetId: string; sha256: string; mime: string }[]; claimIds?: string[] };
    const files: RenderInput[] = [];
    for (const [n, spec] of cfg.inputs.entries()) {
      const a = prep.inputs.find((x) => x.id === spec.assetId);
      if (!a) return fail(`input asset ${spec.assetId} no longer exists`, true);
      const bytes = await deps.store.get(a.objectKey);
      if (!bytes) return fail(`input asset ${a.id} bytes missing`, true);
      // Integrity: the bytes rendered must be exactly the bytes approved in the workflow config.
      if (sha256Hex(bytes) !== spec.sha256) return fail(`input asset ${a.id} content hash changed since the render was requested`, true);
      files.push({ file: `input-${n}.${ext(a.mime)}`, mime: a.mime, bytes });
    }

    const out = await renderer.render({ composition: cfg.composition, props: cfg.props, inputs: files, jobId: job.id });
    const md = out.metadata;
    const expectedSeconds = cfg.durationInFrames / cfg.fps;
    const problems: string[] = [];
    if (md.width !== cfg.width || md.height !== cfg.height) problems.push(`dimensions ${md.width}x${md.height} != ${cfg.width}x${cfg.height}`);
    if (md.codec !== 'h264') problems.push(`codec ${md.codec} != h264`);
    if (md.durationInSeconds === null || Math.abs(md.durationInSeconds - expectedSeconds) > 0.25) problems.push(`duration ${md.durationInSeconds}s != ${expectedSeconds}s`);
    if (!md.canPlayInVideoTag) problems.push('not playable in standard video players');
    const bytes = new Uint8Array(await fs.readFile(out.path));
    await fs.rm(out.path, { force: true });
    const sha = sha256Hex(bytes);
    const put = await deps.store.put(tenantKey(tenantId, 'assets', sha), bytes, 'video/mp4');
    const contains = prep.inputs.reduce(
      (acc, a) => {
        const c = (a.manifest as { contains?: Record<string, boolean> }).contains ?? {};
        return { music: acc.music || !!c.music, voice: acc.voice || !!c.voice, likeness: acc.likeness || !!c.likeness || !!a.personaId, aiGenerated: acc.aiGenerated || !!c.aiGenerated };
      },
      { music: false, voice: false, likeness: false, aiGenerated: false },
    );
    const props = cfg.props as { headline?: string; captions?: string[]; cta?: string; disclosureText?: string };
    const result = await withTenant(deps.db, tctx, async (tx) => {
      const prov = await evidence.admitInternalEvidence(tx, tenantId, actor, {
        kind: 'document',
        owner: 'futuregrow-media-job',
        uri: `render://${job.id}`,
        content: { renderJobId: job.id, configSha256: prep.j.configSha256, inputs: cfg.inputs, engine: out.engineVersion, outputSha256: sha, metadata: md, licence: prep.licence },
        summary: `Render provenance for job ${job.id}`,
        confidence: 1,
        license: 'tenant-owned render output; inputs carry their own rights',
        permittedUses: ['creative_generation', 'publishing'],
        now: deps.clock.now(),
      });
      const [asset] = await tx
        .insert(assets)
        .values({
          tenantId,
          kind: 'video',
          title: `${cfg.composition} render ${job.id.slice(0, 8)}`,
          objectKey: put.key,
          sha256: sha,
          mime: 'video/mp4',
          bytes: put.bytes,
          width: md.width,
          height: md.height,
          durationMs: md.durationInSeconds === null ? null : Math.round(md.durationInSeconds * 1000),
          origin: 'render',
          briefId: prep.j.briefId,
          renderJobId: job.id,
          personaId: prep.j.personaId,
          manifest: {
            workflowConfig: cfg,
            configSha256: prep.j.configSha256,
            engine: out.engineVersion,
            inputs: cfg.inputs,
            contains,
            captions: [props.headline, ...(props.captions ?? []), props.cta].filter(Boolean).join('\n'),
            claimIds: cfg.claimIds ?? [],
            provenanceEvidenceId: prov.evidenceId,
          },
          qa: { technical: { passed: problems.length === 0, problems, metadata: md } },
          disclosure: { isAiGenerated: contains.aiGenerated || !!prep.j.personaId, syntheticPersonaId: prep.j.personaId, overlayText: props.disclosureText ?? '' },
          createdBy: 'system:media-job',
        })
        .onConflictDoNothing()
        .returning();
      const target =
        asset ??
        (
          await tx
            .select()
            .from(assets)
            .where(and(eq(assets.sha256, sha)))
        )[0]!;
      if (asset) {
        await tx.insert(assetRights).values({
          tenantId,
          assetId: target.id,
          component: 'template',
          rightsHolder: 'tenant (FUTUREGROW composition templates)',
          licenseRef: `remotion:${(prep.licence as { eligibility: string }).eligibility}`,
          commercialUse: 'allowed',
          evidenceId: prov.evidenceId,
        });
        for (const r of prep.rights) {
          await tx.insert(assetRights).values({ tenantId, assetId: target.id, component: r.component, rightsHolder: r.rightsHolder, licenseRef: r.licenseRef, artifactLicenseId: r.artifactLicenseId, commercialUse: r.commercialUse, evidenceId: r.evidenceId, expiresAt: r.expiresAt });
        }
      }
      await assetsModule.recomputeEligibility(tx, deps, tenantId, target.id);
      await tx
        .update(renderJobs)
        .set({ status: 'completed', outputAssetId: target.id, finishedAt: new Date(), lockedBy: null, statusReason: problems.length ? `technical QA: ${problems.join('; ')}` : null })
        .where(eq(renderJobs.id, job.id));
      await record(tx, tenantId, actor, 'media.render.completed', { type: 'render_job', id: job.id }, { assetId: target.id, sha256: sha, qaPassed: problems.length === 0 });
      return target.id;
    });
    return { kind: 'completed', jobId: job.id, assetId: result };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
