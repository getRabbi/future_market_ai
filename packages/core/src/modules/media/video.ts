import { canonicalJson } from '@futuregrow/contracts';
import { assetRights, assets, type DbOrTx, renderJobs, type Tx, videoProjects } from '@futuregrow/db';
import { conflict, forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, clipText, record, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { getTenantSettingsRow } from '../m24-governance/index.js';
import { VIDEO_PRESETS, type VideoPreset } from './formats.js';
import { assertVideoModeEnabled } from './routing.js';

export { VIDEO_PRESETS, type VideoPreset };

/**
 * Video Studio (P3-04): template-based short videos with the existing Remotion/FFmpeg media job,
 * no GPU needed. Idea → script → storyboard (scenes with on-screen text, subtitles, media and
 * transitions) → render → QA → preview → export (MP4 + thumbnail + SRT subtitles) → publish
 * through M16/M23 to video platforms. Every scene's media must have cleared rights, every line
 * of copy passes the claim/brand lint, and an AI-generated or synthetic scene keeps its disclosure.
 */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;

export const VIDEO_FPS = 30;
export const MAX_VIDEO_SECONDS = 90;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const SceneSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    durationSeconds: z.number().min(1).max(15),
    /** Large on-screen text (headline of the scene). */
    text: z.string().trim().max(160).default(''),
    /** Subtitle line (also exported as SRT). */
    subtitle: z.string().trim().max(200).default(''),
    assetId: z.string().uuid().nullable().default(null),
    transition: z.enum(['cut', 'fade', 'slide']).default('fade'),
    textPosition: z.enum(['top', 'center', 'bottom']).default('center'),
    background: hex.nullable().default(null),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const StoryboardSchema = z
  .object({
    preset: z.enum(Object.keys(VIDEO_PRESETS) as [VideoPreset, ...VideoPreset[]]),
    brandColor: hex.default('#0f766e'),
    textColor: hex.default('#ffffff'),
    script: z.string().trim().max(4000).default(''),
    scenes: z.array(SceneSchema).min(1).max(20),
    cta: z.string().trim().max(60).default(''),
    disclosureText: z.string().trim().max(120).default(''),
    audioAssetId: z.string().uuid().nullable().default(null),
    claimIds: z.array(z.string().uuid()).max(10).default([]),
  })
  .strict()
  .superRefine((s, ctx) => {
    const total = s.scenes.reduce((a, x) => a + x.durationSeconds, 0);
    if (total > MAX_VIDEO_SECONDS) ctx.addIssue({ code: 'custom', path: ['scenes'], message: `total length ${total}s exceeds ${MAX_VIDEO_SECONDS}s` });
    const ids = s.scenes.map((x) => x.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['scenes'], message: 'scene ids must be unique' });
  });
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const VideoProjectInputSchema = z.object({ title: z.string().trim().min(1).max(200), brandId: z.string().uuid().nullable().default(null), storyboard: StoryboardSchema }).strict();

export const totalSeconds = (s: Storyboard) => s.scenes.reduce((a, x) => a + x.durationSeconds, 0);

/** SRT subtitles from the scenes' subtitle lines (scenes without one leave a gap). */
export function toSrt(s: Storyboard): string {
  const ts = (sec: number) => {
    const ms = Math.round(sec * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const se = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(se).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  const out: string[] = [];
  let at = 0;
  let n = 1;
  for (const sc of s.scenes) {
    if (sc.subtitle) out.push(`${n++}\n${ts(at)} --> ${ts(at + sc.durationSeconds)}\n${sc.subtitle}\n`);
    at += sc.durationSeconds;
  }
  return out.join('\n');
}

/** Checks a storyboard can be rendered and published: media rights, copy lint, disclosures. */
export async function storyboardProblems(t: DbOrTx, deps: CoreDeps, s: Storyboard): Promise<string[]> {
  const problems: string[] = [];
  const ids = [...new Set([...s.scenes.map((x) => x.assetId).filter((x): x is string => Boolean(x)), ...(s.audioAssetId ? [s.audioAssetId] : [])])];
  const rows = ids.length ? await t.select().from(assets).where(inArray(assets.id, ids)) : [];
  const rights = ids.length ? await t.select().from(assetRights).where(inArray(assetRights.assetId, ids)) : [];
  const now = deps.clock.now();
  let needsAiDisclosure = false;
  for (const id of ids) {
    const a = rows.find((r) => r.id === id);
    if (!a) {
      problems.push(`asset ${id} not found`);
      continue;
    }
    if (id === s.audioAssetId ? a.kind !== 'audio' : a.kind !== 'image' && a.kind !== 'video') problems.push(`asset ${id} is ${a.kind}, which cannot be used there`);
    const cleared = rights.some((r) => r.assetId === id && r.component === 'source_media' && r.commercialUse === 'allowed' && (!r.expiresAt || r.expiresAt > now));
    if (!cleared) problems.push(`asset ${id} (“${clipText(a.title, 60)}”) lacks cleared source-media rights`);
    const contains = (a.manifest as { contains?: { music?: boolean; voice?: boolean; aiGenerated?: boolean } }).contains ?? {};
    if (contains.music && !rights.some((r) => r.assetId === id && r.component === 'music')) problems.push(`asset ${id} contains music without music rights`);
    if (contains.voice && !rights.some((r) => r.assetId === id && r.component === 'voice')) problems.push(`asset ${id} contains a voice without voice consent or licence`);
    if ((a.disclosure as { isAiGenerated?: boolean }).isAiGenerated || contains.aiGenerated || a.personaId) needsAiDisclosure = true;
  }
  if (needsAiDisclosure && !s.disclosureText) problems.push('a scene uses AI-generated or synthetic media: add an on-screen disclosure (e.g. "Made with AI")');
  const copy = [...s.scenes.flatMap((x) => [x.text, x.subtitle]), s.cta].filter(Boolean).join('\n');
  if (copy) {
    const lint = await lintCopy(t, copy, { claimIds: s.claimIds, now });
    for (const v of lint.violations.filter((x) => x.severity === 'block')) problems.push(`${v.code}: ${v.message}${v.excerpt ? ` (“${clipText(v.excerpt, 60)}”)` : ''}`);
  }
  return problems;
}

async function load(t: DbOrTx, id: string) {
  const [p] = await t.select().from(videoProjects).where(eq(videoProjects.id, id));
  if (!p) throw notFound('video project');
  return p;
}

export async function createVideoProject(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'creating a video');
  const input = VideoProjectInputSchema.parse(raw);
  const problems = await storyboardProblems(t, deps, input.storyboard);
  const [row] = await t
    .insert(videoProjects)
    .values({ tenantId, brandId: input.brandId, title: input.title, preset: input.storyboard.preset, storyboard: input.storyboard, qa: { storyboard: { passed: problems.length === 0, problems, checkedAt: deps.clock.now().toISOString() } }, createdBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'media.video.created', { type: 'video_project', id: row!.id }, { preset: input.storyboard.preset, scenes: input.storyboard.scenes.length, seconds: totalSeconds(input.storyboard) });
  return row!;
}

export async function updateStoryboard(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string, raw: { storyboard: unknown; expectedVersion: number; title?: string }) {
  requireRole(actor, [...EDIT_ROLES], 'editing a video');
  const p = await load(t, id);
  if (p.status === 'rendering') throw conflict('the video is rendering; wait for it to finish');
  const storyboard = StoryboardSchema.parse(raw.storyboard);
  const problems = await storyboardProblems(t, deps, storyboard);
  const [row] = await t
    .update(videoProjects)
    .set({
      storyboard,
      preset: storyboard.preset,
      title: raw.title ?? p.title,
      status: 'storyboard',
      statusReason: null,
      outputAssetId: null,
      thumbnailAssetId: null,
      subtitlesAssetId: null,
      renderJobId: null,
      qa: { storyboard: { passed: problems.length === 0, problems, checkedAt: deps.clock.now().toISOString() } },
      updatedBy: actorRef(actor),
      updatedAt: deps.clock.now(),
      version: p.version + 1,
    })
    .where(and(eq(videoProjects.id, id), eq(videoProjects.version, raw.expectedVersion)))
    .returning();
  if (!row) throw conflict('the video changed in the meantime; reload and try again');
  await audit(t, tenantId, actor, 'media.video.storyboard_updated', { type: 'video_project', id }, { version: row.version, problems: problems.length });
  return row;
}

/**
 * Queues the render (composition scene_story). Refused while the storyboard has problems; blocked
 * until the Remotion licence eligibility is recorded (B-014). The render config binds the exact
 * input bytes (content hashes) so the media job refuses inputs that changed afterwards.
 */
export async function renderVideoProject(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  requireRole(actor, [...EDIT_ROLES], 'rendering a video');
  return queueProjectRender(t, deps, tenantId, actor, id);
}

/**
 * The render itself, shared by an editor's request and the daily automation (which runs as a
 * system actor only after an owner or admin turned automation on). The Remotion switch is
 * enforced here, server-side, for both.
 */
export async function queueProjectRender(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, id: string) {
  await assertVideoModeEnabled(t, tenantId, 'remotion');
  const p = await load(t, id);
  if (p.status === 'rendering') throw conflict('already rendering');
  const s = StoryboardSchema.parse(p.storyboard);
  const problems = await storyboardProblems(t, deps, s);
  if (problems.length) throw invalid(`fix the storyboard first: ${problems.join('; ')}`);
  const ids = [...new Set([...s.scenes.map((x) => x.assetId).filter((x): x is string => Boolean(x)), ...(s.audioAssetId ? [s.audioAssetId] : [])])];
  const inputs = ids.length ? await t.select().from(assets).where(inArray(assets.id, ids)) : [];
  const settings = await getTenantSettingsRow(t, tenantId);
  const licensed = Boolean(settings?.remotionLicense);
  const dims = VIDEO_PRESETS[s.preset];
  const durationInFrames = Math.round(totalSeconds(s) * VIDEO_FPS);
  // Media is passed by index: the runner writes input-<n>.<ext> files in this order.
  const order = inputs.map((i) => i.id);
  const props = {
    headline: '',
    captions: [],
    cta: s.cta,
    brandColor: s.brandColor,
    disclosureText: s.disclosureText,
    storyboard: { ...s, scenes: s.scenes.map((x) => ({ ...x, mediaIndex: x.assetId ? order.indexOf(x.assetId) : null })), audioIndex: s.audioAssetId ? order.indexOf(s.audioAssetId) : null },
  };
  const workflowConfig = {
    engine: 'remotion',
    composition: 'scene_story',
    width: dims.width,
    height: dims.height,
    fps: VIDEO_FPS,
    durationInFrames,
    codec: 'h264',
    props,
    inputs: inputs.map((i) => ({ assetId: i.id, sha256: i.sha256, mime: i.mime })),
    claimIds: s.claimIds,
    outputs: { thumbnail: true, subtitles: toSrt(s) },
  };
  const [job] = await t
    .insert(renderJobs)
    .values({
      tenantId,
      composition: 'scene_story',
      inputProps: props,
      inputAssetIds: order.length ? order : [],
      status: licensed ? 'queued' : 'blocked_license',
      statusReason: licensed ? null : 'Remotion licence eligibility not recorded (B-014)',
      workflowConfig,
      configSha256: sha256Hex(canonicalJson(workflowConfig)),
      requestedBy: actorRef(actor),
    })
    .returning();
  const [row] = await t
    .update(videoProjects)
    .set({ status: licensed ? 'rendering' : 'storyboard', statusReason: licensed ? 'queued for the media job' : 'record the Remotion licence eligibility in Governance before rendering (B-014)', renderJobId: job!.id, updatedBy: actorRef(actor), updatedAt: deps.clock.now(), version: p.version + 1 })
    .where(eq(videoProjects.id, id))
    .returning();
  if (licensed) await record(t, tenantId, actor, 'media.render.requested', { type: 'render_job', id: job!.id }, { composition: 'scene_story', videoProjectId: id });
  else await audit(t, tenantId, actor, 'media.render.blocked', { type: 'render_job', id: job!.id }, { reason: 'remotion licence not recorded', videoProjectId: id });
  if (!licensed) throw forbidden('rendering needs the Remotion licence eligibility recorded in Governance (B-014); the storyboard is saved');
  return row!;
}

/**
 * Moves rendering projects forward from their render job's real state: completed → QA on the
 * MP4's recorded technical checks → ready (with the thumbnail and subtitle assets) or qa_failed;
 * failed → failed with the job's reason, so the owner can retry.
 */
export async function syncVideoProjects(t: Tx, tenantId: string): Promise<number> {
  const rendering = await t.select().from(videoProjects).where(eq(videoProjects.status, 'rendering'));
  let n = 0;
  for (const p of rendering) {
    if (!p.renderJobId) continue;
    const [job] = await t.select().from(renderJobs).where(eq(renderJobs.id, p.renderJobId));
    if (!job || job.status === 'queued' || job.status === 'rendering') continue;
    if (job.status === 'completed' && job.outputAssetId) {
      const [a] = await t.select().from(assets).where(eq(assets.id, job.outputAssetId));
      const qa = (a?.qa ?? {}) as { technical?: { passed?: boolean; problems?: string[] } };
      const m = (a?.manifest ?? {}) as { thumbnailAssetId?: string; subtitlesAssetId?: string };
      const passed = qa.technical?.passed === true;
      await t
        .update(videoProjects)
        .set({
          status: passed ? 'ready' : 'qa_failed',
          statusReason: passed ? null : `render QA failed: ${(qa.technical?.problems ?? []).join('; ')}`,
          outputAssetId: job.outputAssetId,
          thumbnailAssetId: m.thumbnailAssetId ?? null,
          subtitlesAssetId: m.subtitlesAssetId ?? null,
          qa: { ...(p.qa as Record<string, unknown>), render: qa.technical ?? null },
          updatedAt: new Date(),
        })
        .where(eq(videoProjects.id, p.id));
      await audit(t, tenantId, { type: 'system', id: 'video-studio', roles: [], mfaVerified: false }, passed ? 'media.video.ready' : 'media.video.qa_failed', { type: 'video_project', id: p.id }, { renderJobId: job.id, assetId: job.outputAssetId });
    } else {
      await t
        .update(videoProjects)
        .set({ status: 'failed', statusReason: job.statusReason ?? `render ${job.status}`, updatedAt: new Date() })
        .where(eq(videoProjects.id, p.id));
      await audit(t, tenantId, { type: 'system', id: 'video-studio', roles: [], mfaVerified: false }, 'media.video.failed', { type: 'video_project', id: p.id }, { renderJobId: job.id, reason: clipText(job.statusReason ?? job.status, 300) });
    }
    n++;
  }
  return n;
}

export async function listVideoProjects(t: DbOrTx) {
  return t.select().from(videoProjects).orderBy(desc(videoProjects.updatedAt)).limit(200);
}

export async function videoProject(t: Tx, tenantId: string, id: string) {
  await syncVideoProjects(t, tenantId);
  const p = await load(t, id);
  const ids = [p.outputAssetId, p.thumbnailAssetId, p.subtitlesAssetId].filter((x): x is string => Boolean(x));
  const files = ids.length ? await t.select({ id: assets.id, kind: assets.kind, mime: assets.mime, width: assets.width, height: assets.height, durationMs: assets.durationMs, publishEligible: assets.publishEligible, eligibilityReasons: assets.eligibilityReasons }).from(assets).where(inArray(assets.id, ids)) : [];
  return { project: p, files, srt: toSrt(StoryboardSchema.parse(p.storyboard)) };
}
