import { artifactLicenses, type DbOrTx, mediaJobs, modelRegistry, renderJobs, type Tx, tenantSettings } from '@futuregrow/db';
import { conflict, forbidden } from '@futuregrow/observability';
import { defaultTenantPolicy } from '@futuregrow/policies';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';
import { VIDEO_PRESETS, type VideoPreset } from './formats.js';

/**
 * Four-mode video switchboard. Each mode has an independent tenant ON/OFF switch that the
 * server enforces at submission time:
 *  - remotion:    CPU template rendering (Remotion + FFmpeg); needs the recorded Remotion licence.
 *  - google_flow: manual generation at Google Flow, then a validated MP4 import. There is no
 *                 automated free API, so FUTUREGROW never submits work to Flow.
 *  - wan_cloud:   an operator-hosted Wan/ComfyUI GPU worker (GPU time is billed by its host).
 *  - higgsfield:  the official Higgsfield developer API (provider charges apply).
 * Switching a mode ON never makes it operational by itself: readiness (adapter, credentials,
 * approved priced model, output licence, budgets) is computed from real records every time,
 * and paid execution additionally needs an explicit per-request authorization.
 */
export const VIDEO_MODES = ['remotion', 'google_flow', 'wan_cloud', 'higgsfield'] as const;
export const VideoModeSchema = z.enum(VIDEO_MODES);
export type VideoMode = z.infer<typeof VideoModeSchema>;
export type PaidVideoMode = 'wan_cloud' | 'higgsfield';
export const PAID_VIDEO_MODES: readonly PaidVideoMode[] = ['wan_cloud', 'higgsfield'];
export const isPaidVideoMode = (m: string): m is PaidVideoMode => m === 'wan_cloud' || m === 'higgsfield';
export const isVideoMode = (m: string): m is VideoMode => (VIDEO_MODES as readonly string[]).includes(m);
/** Official Google Flow web app (Google Labs). Manual use only: no automation, no credit bypass. */
export const GOOGLE_FLOW_URL = 'https://labs.google/fx/tools/flow';

const usd = (max: number) => z.number().finite().min(0).max(max);

const PRESET_KEYS = Object.keys(VIDEO_PRESETS) as [VideoPreset, ...VideoPreset[]];

/**
 * Daily automation per brand (D-053): how many videos a brand may get per day, which content
 * categories (pillar keys, curriculum unit kinds, or "approved_claims") and formats it uses, and
 * which library assets (cleared, owner-chosen) its scenes may show. Nothing here enables a mode.
 */
export const VideoAutomationBrandSchema = z
  .object({
    brandId: z.string().uuid(),
    enabled: z.boolean().default(true),
    dailyQuota: z.number().int().min(1).max(10).default(2),
    /** Empty = every category the brand's content program offers. */
    categories: z
      .array(z.string().regex(/^[a-z0-9_]{2,32}$/))
      .max(16)
      .default([]),
    presets: z.array(z.enum(PRESET_KEYS)).min(1).max(3).default(['vertical_9x16']),
    assetIds: z.array(z.string().uuid()).max(20).default([]),
  })
  .strict();
export type VideoAutomationBrand = z.infer<typeof VideoAutomationBrandSchema>;

export const VideoAutomationSchema = z
  .object({
    brands: z.array(VideoAutomationBrandSchema).max(20).default([]),
    /** smart = the router (template storyboards go to Remotion); a mode name asks for that mode. */
    preferredMode: z.enum(['smart', ...VIDEO_MODES]).default('smart'),
    /** OFF = curriculum and approved-content templates only (no model calls, no AI spend). */
    useAi: z.boolean().default(true),
    /** Bounded work per run: at most this many scripts are written per tick. */
    maxScriptsPerRun: z.number().int().min(1).max(5).default(3),
  })
  .strict();
export type VideoAutomation = z.infer<typeof VideoAutomationSchema>;
export const DEFAULT_VIDEO_AUTOMATION: VideoAutomation = Object.freeze({ brands: [], preferredMode: 'smart', useAi: true, maxScriptsPerRun: 3 }) as VideoAutomation;

export const VideoRoutingSchema = z
  .object({
    enabled: z.object({ remotion: z.boolean(), google_flow: z.boolean(), wan_cloud: z.boolean(), higgsfield: z.boolean() }).strict(),
    /** Smart Mode ON: the router picks per request. OFF: requests go to defaultProvider. */
    smartMode: z.boolean(),
    defaultProvider: VideoModeSchema,
    /** Tie-break order inside the same cost class (free before paid always holds). */
    providerPriority: z.array(VideoModeSchema).length(4),
    /** A goal for the daily automation, not a guarantee of successful renders. */
    dailyTarget: z.number().int().min(1).max(10),
    dailyAutomation: z.boolean(),
    maxPaidUsdPerVideo: usd(1000),
    dailyPaidBudgetUsd: usd(10_000),
    monthlyPaidBudgetUsd: usd(100_000),
    /** Paid jobs wait for an owner/admin (MFA) approval before anything is submitted. */
    requirePaidApproval: z.boolean(),
    /** Global kill switch for every paid video provider. */
    paidGenerationDisabled: z.boolean(),
    automation: VideoAutomationSchema.prefault({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    const brandIds = s.automation.brands.map((b) => b.brandId);
    if (new Set(brandIds).size !== brandIds.length) ctx.addIssue({ code: 'custom', path: ['automation', 'brands'], message: 'list each brand once' });
    if (new Set(s.providerPriority).size !== VIDEO_MODES.length) ctx.addIssue({ code: 'custom', path: ['providerPriority'], message: 'list each mode exactly once' });
    if (s.dailyPaidBudgetUsd > s.monthlyPaidBudgetUsd) ctx.addIssue({ code: 'custom', path: ['dailyPaidBudgetUsd'], message: 'the daily paid budget cannot exceed the monthly paid budget' });
    if (s.maxPaidUsdPerVideo > s.dailyPaidBudgetUsd) ctx.addIssue({ code: 'custom', path: ['maxPaidUsdPerVideo'], message: 'the per-video maximum cannot exceed the daily paid budget' });
    if (!s.smartMode && !s.enabled[s.defaultProvider]) ctx.addIssue({ code: 'custom', path: ['defaultProvider'], message: 'with Smart Mode OFF the default provider must be ON' });
  });
export type VideoRouting = z.infer<typeof VideoRoutingSchema>;

/** Free-first defaults: Remotion ON (still needs its licence), everything paid OFF with a $0 budget. */
export const DEFAULT_VIDEO_ROUTING: VideoRouting = Object.freeze({
  enabled: { remotion: true, google_flow: false, wan_cloud: false, higgsfield: false },
  smartMode: true,
  defaultProvider: 'remotion',
  providerPriority: ['remotion', 'google_flow', 'wan_cloud', 'higgsfield'],
  dailyTarget: 5,
  dailyAutomation: false,
  maxPaidUsdPerVideo: 0,
  dailyPaidBudgetUsd: 0,
  monthlyPaidBudgetUsd: 0,
  requirePaidApproval: true,
  paidGenerationDisabled: true,
  automation: DEFAULT_VIDEO_AUTOMATION,
}) as VideoRouting;

/** A stored record that no longer validates fails closed: every mode OFF and paid disabled. */
export function normalizeVideoRouting(raw: unknown): VideoRouting {
  if (raw == null) return structuredClone(DEFAULT_VIDEO_ROUTING);
  const merged = typeof raw === 'object' ? { ...structuredClone(DEFAULT_VIDEO_ROUTING), ...(raw as Record<string, unknown>) } : raw;
  const parsed = VideoRoutingSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  return { ...structuredClone(DEFAULT_VIDEO_ROUTING), enabled: { remotion: false, google_flow: false, wan_cloud: false, higgsfield: false }, paidGenerationDisabled: true };
}

export async function storedVideoRouting(tx: DbOrTx, tenantId: string) {
  const [row] = await tx.select({ videoRouting: tenantSettings.videoRouting, version: tenantSettings.videoRoutingVersion, remotionLicense: tenantSettings.remotionLicense }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return { settings: normalizeVideoRouting(row?.videoRouting), version: row?.version ?? 0, configured: row?.videoRouting != null, remotionLicensed: Boolean(row?.remotionLicense) };
}

/* ------------------------------------------------------------------ */
/* Paid usage and budgets (server-side, tenant-scoped)                 */
/* ------------------------------------------------------------------ */

export interface PaidVideoUsage {
  dayStart: string;
  monthStart: string;
  daySpentUsd: number;
  monthSpentUsd: number;
  /** Queued/running paid jobs plus every job whose provider charge is not reconciled yet. */
  reservedUsd: number;
  unreconciledJobs: number;
  awaitingApproval: number;
  awaitingApprovalUsd: number;
  /** Ledger rows without an amount make spend unmeasurable: paid generation then fails closed. */
  unpricedCharges: number;
}

export async function paidVideoUsage(t: DbOrTx, tenantId: string, now: Date): Promise<PaidVideoUsage> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const paid = [...PAID_VIDEO_MODES];
  const ledger = await t.execute<{ day: number; month: number; unpriced: number }>(sql`
    select coalesce(sum(amount_usd) filter (where occurred_at >= ${day}), 0)::float8 as day, coalesce(sum(amount_usd), 0)::float8 as month,
           count(*) filter (where amount_usd is null)::int as unpriced
    from cost_ledger where tenant_id = ${tenantId} and category = 'video_generation' and provider in (${sql.join(
      paid.map((p) => sql`${p}`),
      sql`, `,
    )}) and occurred_at >= ${month}`);
  const jobs = await t.execute<{ reserved: number; unreconciled: number; awaiting: number; awaiting_usd: number }>(sql`
    select coalesce(sum(cost_usd) filter (where status in ('queued','running') or provenance->>'billingUnresolved' = 'true'), 0)::float8 as reserved,
           count(*) filter (where provenance->>'billingUnresolved' = 'true')::int as unreconciled,
           count(*) filter (where status = 'awaiting_approval')::int as awaiting,
           coalesce(sum(cost_usd) filter (where status = 'awaiting_approval'), 0)::float8 as awaiting_usd
    from media_jobs where tenant_id = ${tenantId} and kind = 'ai_video' and provider in (${sql.join(
      paid.map((p) => sql`${p}`),
      sql`, `,
    )})`);
  const l = ledger.rows[0];
  const j = jobs.rows[0];
  return {
    dayStart: day.toISOString(),
    monthStart: month.toISOString(),
    daySpentUsd: l?.day ?? 0,
    monthSpentUsd: l?.month ?? 0,
    reservedUsd: j?.reserved ?? 0,
    unreconciledJobs: j?.unreconciled ?? 0,
    awaitingApproval: j?.awaiting ?? 0,
    awaitingApprovalUsd: j?.awaiting_usd ?? 0,
    unpricedCharges: l?.unpriced ?? 0,
  };
}

const money = (n: number) => `$${n.toFixed(2)}`;

/** Every reason a paid generation of `estimateUsd` may not be reserved now. Empty = allowed. */
export function paidBudgetProblems(settings: VideoRouting, usage: PaidVideoUsage, estimateUsd: number | null): string[] {
  const out: string[] = [];
  if (settings.paidGenerationDisabled) out.push('Paid generation is disabled (Disable all paid generation is ON).');
  if (estimateUsd === null || !Number.isFinite(estimateUsd) || estimateUsd < 0) {
    out.push('The maximum charge is unknown; paid generation fails closed without a reviewed price.');
    return out;
  }
  if (usage.unpricedCharges) out.push(`${usage.unpricedCharges} paid video charge(s) have no recorded amount; reconcile them before new paid jobs.`);
  if (estimateUsd > settings.maxPaidUsdPerVideo) out.push(`Maximum charge ${money(estimateUsd)} exceeds the per-video limit of ${money(settings.maxPaidUsdPerVideo)}.`);
  const committed = usage.reservedUsd + estimateUsd;
  if (usage.daySpentUsd + committed > settings.dailyPaidBudgetUsd) out.push(`Daily paid budget ${money(settings.dailyPaidBudgetUsd)} cannot cover it (spent ${money(usage.daySpentUsd)}, reserved ${money(usage.reservedUsd)}).`);
  if (usage.monthSpentUsd + committed > settings.monthlyPaidBudgetUsd) out.push(`Monthly paid budget ${money(settings.monthlyPaidBudgetUsd)} cannot cover it (spent ${money(usage.monthSpentUsd)}, reserved ${money(usage.reservedUsd)}).`);
  return out;
}

/* ------------------------------------------------------------------ */
/* Readiness                                                           */
/* ------------------------------------------------------------------ */

export type VideoModeState = 'ready' | 'setup_required' | 'disabled';
type Model = typeof modelRegistry.$inferSelect;

export interface VideoModeStatus {
  id: VideoMode;
  label: string;
  enabled: boolean;
  /** Enabled AND every prerequisite met. Paid modes still need a per-request authorization. */
  ready: boolean;
  state: VideoModeState;
  kind: 'automatic' | 'manual' | 'paid';
  /** Prerequisites that are missing (shown as "Setup required"). */
  requires: string[];
  note: string;
  outputs: string[];
  estimatedCost: { usdPerSecond: number | null; basis: string };
  model: { provider: string; modelId: string; usdPerVideoSecond: number } | null;
  imageToVideo: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  configure: { label: string; href: string | null; detail: string };
}

const META: Record<VideoMode, Pick<VideoModeStatus, 'label' | 'kind' | 'note' | 'outputs' | 'configure'>> = {
  remotion: {
    label: 'Remotion + FFmpeg',
    kind: 'automatic',
    note: 'CPU template rendering: scenes, transitions, subtitles, branding, voiceover and CTA. No generative GPU.',
    outputs: ['MP4 9:16, 1:1, 16:9', 'thumbnail', 'SRT subtitles'],
    configure: { label: 'Record the Remotion licence in Governance', href: '/governance', detail: 'Remotion requires a company licence for most commercial teams; record your eligibility once.' },
  },
  google_flow: {
    label: 'Google Flow (manual)',
    kind: 'manual',
    note: 'Manual generation — no automated free API. Generate in Google Flow with your own account, then import the MP4 here.',
    outputs: ['imported MP4 clips for Remotion scenes and the asset library'],
    configure: { label: 'Open Google Flow', href: GOOGLE_FLOW_URL, detail: 'Download the finished clip from Flow and use "Import from Google Flow".' },
  },
  wan_cloud: {
    label: 'Wan (open-source, cloud GPU)',
    kind: 'paid',
    note: 'Operator-hosted Wan/ComfyUI GPU worker. FUTUREGROW never rents or starts GPUs; the host bills GPU time.',
    outputs: ['silent text-to-video clips', 'image-to-video when an image workflow is configured'],
    configure: { label: 'Server setup (docs/VIDEO_GENERATION_MODES.md)', href: null, detail: 'Set FG_WAN_COMFYUI_URL, FG_WAN_COMFYUI_TOKEN, a workflow file and FG_WAN_USD_PER_GPU_HOUR, then approve a priced wan_cloud model and its licence.' },
  },
  higgsfield: {
    label: 'Higgsfield API',
    kind: 'paid',
    note: 'Official Higgsfield developer API (not website credits). Charges are not reported by the API and are reconciled from billing records.',
    outputs: ['clips from the configured Higgsfield video models'],
    configure: { label: 'Server setup (docs/VIDEO_GENERATION_MODES.md)', href: null, detail: 'Set HF_API_KEY_ID, HF_API_KEY_SECRET and FG_HIGGSFIELD_MODELS_JSON, then approve a priced higgsfield model and its commercial licence.' },
  },
};

const priced = (m: Model) => m.usdPerVideoSecond != null && Number.isFinite(m.usdPerVideoSecond) && m.usdPerVideoSecond >= 0;

/** The approved model for a paid mode (deterministic: lowest price, then model id). */
export function eligibleVideoModel(models: Model[], licences: (typeof artifactLicenses.$inferSelect)[], mode: PaidVideoMode, modelId?: string): Model | null {
  return (
    models
      .filter((m) => m.provider === mode && (!modelId || m.modelId === modelId) && m.status === 'active' && m.approvedForProduction && m.purposes.includes('video_generation') && m.commercialUse === 'allowed' && m.trainingOnCustomerData === 'no' && priced(m))
      .filter((m) => licences.some((l) => l.exactName === `${m.provider}/${m.modelId}` && l.approvedForProduction && l.commercialUse === 'allowed'))
      .sort((a, b) => a.usdPerVideoSecond! - b.usdPerVideoSecond! || a.modelId.localeCompare(b.modelId))[0] ?? null
  );
}

async function lastOutcomes(t: DbOrTx) {
  const out: Record<VideoMode, { success: Date | null; error: string | null }> = { remotion: { success: null, error: null }, google_flow: { success: null, error: null }, wan_cloud: { success: null, error: null }, higgsfield: { success: null, error: null } };
  const [ok] = await t
    .select({ at: renderJobs.finishedAt })
    .from(renderJobs)
    .where(and(eq(renderJobs.composition, 'scene_story'), eq(renderJobs.status, 'completed')))
    .orderBy(desc(renderJobs.finishedAt))
    .limit(1);
  const [bad] = await t
    .select({ reason: renderJobs.statusReason, status: renderJobs.status })
    .from(renderJobs)
    .where(and(eq(renderJobs.composition, 'scene_story'), inArray(renderJobs.status, ['failed', 'blocked_license'])))
    .orderBy(desc(renderJobs.requestedAt))
    .limit(1);
  out.remotion = { success: ok?.at ?? null, error: bad ? (bad.reason ?? bad.status) : null };
  for (const mode of ['google_flow', 'wan_cloud', 'higgsfield'] as const) {
    const [s] = await t
      .select({ at: mediaJobs.finishedAt })
      .from(mediaJobs)
      .where(and(eq(mediaJobs.provider, mode), eq(mediaJobs.status, 'succeeded')))
      .orderBy(desc(mediaJobs.finishedAt))
      .limit(1);
    const [f] = await t
      .select({ reason: mediaJobs.statusReason })
      .from(mediaJobs)
      .where(and(eq(mediaJobs.provider, mode), inArray(mediaJobs.status, ['failed', 'blocked'])))
      .orderBy(desc(mediaJobs.requestedAt))
      .limit(1);
    out[mode] = { success: s?.at ?? null, error: f?.reason ?? null };
  }
  return out;
}

export async function videoModeStatuses(t: DbOrTx, deps: Pick<CoreDeps, 'videos'>, settings: VideoRouting, remotionLicensed: boolean): Promise<VideoModeStatus[]> {
  const models = await t.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
  const licences = await t.select().from(artifactLicenses).where(eq(artifactLicenses.approvedForProduction, true));
  const last = await lastOutcomes(t);
  return VIDEO_MODES.map((id) => {
    const requires: string[] = [];
    let model: Model | null = null;
    if (id === 'remotion' && !remotionLicensed) requires.push('Record the Remotion licence eligibility (Governance › Remotion licence).');
    if (isPaidVideoMode(id)) {
      model = eligibleVideoModel(models, licences, id);
      if (!deps.videos?.[id]) requires.push(id === 'wan_cloud' ? 'Configure a remote Wan/ComfyUI GPU worker endpoint and token on the server (no GPU is provisioned automatically).' : 'Configure Higgsfield API credentials and model map on the server.');
      if (!model) requires.push(`Approve a priced ${id} video_generation model (commercial use, no training on customer data) and an approved output licence record "${id}/<model>".`);
      if (settings.paidGenerationDisabled) requires.push('Turn OFF "Disable all paid generation".');
      if (settings.maxPaidUsdPerVideo <= 0 || settings.dailyPaidBudgetUsd <= 0 || settings.monthlyPaidBudgetUsd <= 0) requires.push('Set a nonzero per-video maximum, daily and monthly paid budget.');
    }
    const enabled = settings.enabled[id];
    const adapter = isPaidVideoMode(id) ? deps.videos?.[id] : undefined;
    const usdPerSecond = id === 'remotion' || id === 'google_flow' ? 0 : (model?.usdPerVideoSecond ?? null);
    return {
      id,
      ...META[id],
      enabled,
      ready: enabled && requires.length === 0,
      state: !enabled ? 'disabled' : requires.length ? 'setup_required' : 'ready',
      requires,
      estimatedCost: {
        usdPerSecond,
        basis: id === 'remotion' ? 'No provider charge (CPU render on the media worker).' : id === 'google_flow' ? 'No FUTUREGROW charge; Flow credits belong to your Google plan.' : model ? 'Reviewed maximum USD per output second (model registry).' : 'Unknown until a priced model is approved.',
      },
      model: model ? { provider: model.provider, modelId: model.modelId, usdPerVideoSecond: model.usdPerVideoSecond! } : null,
      imageToVideo: Boolean(adapter?.imageToVideo),
      lastSuccessAt: last[id].success?.toISOString() ?? null,
      lastError: last[id].error,
    } satisfies VideoModeStatus;
  });
}

/* ------------------------------------------------------------------ */
/* Smart router (pure, deterministic)                                  */
/* ------------------------------------------------------------------ */

export const VideoRouteRequestSchema = z
  .object({
    /** Absent = the tenant policy (Smart Mode, or the default provider when Smart is OFF). */
    provider: z.enum(['smart', ...VIDEO_MODES]).optional(),
    /** template = branded scenes Remotion can render; cinematic = an AI-generated clip is required. */
    quality: z.enum(['template', 'cinematic']).default('template'),
    preset: z.enum(Object.keys(VIDEO_PRESETS) as [VideoPreset, ...VideoPreset[]]).default('vertical_9x16'),
    seconds: z.number().int().min(1).max(90).default(8),
    width: z.number().int().min(256).max(1920).optional(),
    height: z.number().int().min(256).max(1920).optional(),
    imageAssetId: z.string().uuid().nullable().default(null),
    /** Explicit consent to consider paid providers for this request (never implied). */
    allowPaid: z.boolean().default(false),
  })
  .strict();
export type VideoRouteRequest = z.infer<typeof VideoRouteRequestSchema>;

export type VideoExecution = 'automatic' | 'manual' | 'approval_required' | 'paid_automatic' | 'needs_authorization' | 'unavailable';

export interface VideoCandidate {
  mode: VideoMode;
  eligible: boolean;
  paid: boolean;
  estimateUsd: number | null;
  output: { width: number; height: number } | null;
  modelId: string | null;
  problems: string[];
}

export interface VideoRouteDecision {
  policy: 'smart' | VideoMode;
  mode: VideoMode | null;
  execution: VideoExecution;
  reason: string;
  estimateUsd: number | null;
  output: { width: number; height: number } | null;
  modelId: string | null;
  candidates: VideoCandidate[];
  /** Actionable steps when nothing (or nothing free) is eligible. */
  setup: string[];
}

export function decideVideoRoute(settings: VideoRouting, req: VideoRouteRequest, candidates: VideoCandidate[]): VideoRouteDecision {
  const policy = req.provider ?? (settings.smartMode ? 'smart' : settings.defaultProvider);
  const byMode = (m: VideoMode) => candidates.find((c) => c.mode === m)!;
  const base = { policy, candidates } as const;
  const done = (c: VideoCandidate, execution: VideoExecution, reason: string): VideoRouteDecision => ({ ...base, mode: c.mode, execution, reason, estimateUsd: c.estimateUsd, output: c.output, modelId: c.modelId, setup: [] });
  const none = (reason: string, setup: string[]): VideoRouteDecision => ({ ...base, mode: null, execution: 'unavailable', reason, estimateUsd: null, output: null, modelId: null, setup: [...new Set(setup)] });
  const paidExecution = (c: VideoCandidate): VideoRouteDecision =>
    req.allowPaid
      ? done(c, settings.requirePaidApproval ? 'approval_required' : 'paid_automatic', settings.requirePaidApproval ? 'Paid provider: the job waits for an owner/admin approval before submission.' : 'Paid provider authorized for this request within the configured budgets.')
      : done(c, 'needs_authorization', `Paid provider ${c.mode}: confirm a maximum charge of $${(c.estimateUsd ?? 0).toFixed(2)} to continue. Nothing is submitted until you do.`);

  if (policy !== 'smart') {
    const c = byMode(policy);
    if (!c.eligible) return none(`${META[policy].label} cannot take this request.`, c.problems);
    if (policy === 'google_flow') return done(c, 'manual', 'Generate the clip in Google Flow, then import the MP4. FUTUREGROW does not automate Flow.');
    if (policy === 'remotion') return done(c, 'automatic', 'Template render on the CPU media worker.');
    return paidExecution(c);
  }

  const order = (a: VideoCandidate, b: VideoCandidate) => settings.providerPriority.indexOf(a.mode) - settings.providerPriority.indexOf(b.mode);
  if (req.quality === 'template') {
    const r = byMode('remotion');
    return r.eligible ? done(r, 'automatic', 'Smart: template-compatible video renders with Remotion (free-first).') : none('Smart: template videos need Remotion, which cannot run now.', r.problems);
  }
  const eligible = candidates.filter((c) => c.eligible && c.mode !== 'remotion');
  const free = eligible.filter((c) => !c.paid).sort(order);
  if (free[0]) return done(free[0], 'manual', 'Smart: a free manual mode is available; paid providers are never used as a silent fallback.');
  // Cheapest eligible paid provider; the tenant priority breaks ties. Budget problems already made others ineligible.
  const paid = eligible.filter((c) => c.paid).sort((a, b) => (a.estimateUsd ?? Infinity) - (b.estimateUsd ?? Infinity) || order(a, b));
  if (paid[0]) return paidExecution(paid[0]);
  return none(
    'Smart: no enabled and ready mode can generate a cinematic clip.',
    candidates.filter((c) => c.mode !== 'remotion').flatMap((c) => c.problems.map((p) => `${META[c.mode].label}: ${p}`)),
  );
}

const aspect = (w: number, h: number) => w / h;

/** Builds per-mode candidates from real readiness, provider capability, cost and budget, then decides. */
export async function previewVideoRoute(t: DbOrTx, deps: Pick<CoreDeps, 'videos' | 'clock'>, tenantId: string, raw: unknown): Promise<VideoRouteDecision & { usage: PaidVideoUsage }> {
  const req = VideoRouteRequestSchema.parse(raw);
  const stored = await storedVideoRouting(t, tenantId);
  const statuses = await videoModeStatuses(t, deps, stored.settings, stored.remotionLicensed);
  const usage = await paidVideoUsage(t, tenantId, deps.clock.now());
  const preset = VIDEO_PRESETS[req.preset];
  const want = { width: req.width ?? preset.width, height: req.height ?? preset.height };
  const candidates = statuses.map((s): VideoCandidate => {
    const problems: string[] = [];
    if (!s.enabled) problems.push(`${s.label} is OFF.`);
    problems.push(...s.requires);
    let output: VideoCandidate['output'] = want;
    let estimateUsd: number | null = 0;
    if (s.id === 'remotion') {
      if (req.quality === 'cinematic') problems.push('Remotion renders templates and imported clips; it cannot generate a cinematic AI clip.');
    } else if (s.id === 'google_flow') {
      if (req.quality === 'template') problems.push('Google Flow produces clips, not branded template videos.');
    } else {
      const adapter = deps.videos?.[s.id];
      estimateUsd = s.model ? s.model.usdPerVideoSecond * req.seconds : null;
      if (adapter && s.model) {
        const probe = (w: number, h: number) => adapter.supports({ modelId: s.model!.modelId, prompt: 'capability check', seconds: req.seconds, width: w, height: h, title: 'capability check', imageAssetId: req.imageAssetId });
        if (!probe(want.width, want.height)) {
          const alt = adapter.sizes?.find((z) => Math.abs(aspect(z.width, z.height) - aspect(want.width, want.height)) < 0.01 && probe(z.width, z.height));
          if (alt) output = alt;
          else {
            output = null;
            problems.push(`The ${s.id} adapter does not support ${want.width}×${want.height}, ${req.seconds}s${req.imageAssetId ? ' image-to-video' : ''}.`);
          }
        }
      }
      if (req.quality === 'template') problems.push('Template videos render with Remotion; generative providers are used for cinematic clips.');
      if (s.enabled && s.requires.length === 0) problems.push(...paidBudgetProblems(stored.settings, usage, estimateUsd));
    }
    return { mode: s.id, eligible: problems.length === 0, paid: isPaidVideoMode(s.id), estimateUsd, output, modelId: s.model?.modelId ?? null, problems };
  });
  return { ...decideVideoRoute(stored.settings, req, candidates), usage };
}

/* ------------------------------------------------------------------ */
/* Overview, update (optimistic concurrency) and enforcement           */
/* ------------------------------------------------------------------ */

export async function videoRoutingOverview(t: DbOrTx, deps: Pick<CoreDeps, 'videos' | 'clock'>, tenantId: string) {
  const stored = await storedVideoRouting(t, tenantId);
  const modes = await videoModeStatuses(t, deps, stored.settings, stored.remotionLicensed);
  const usage = await paidVideoUsage(t, tenantId, deps.clock.now());
  return { settings: stored.settings, version: stored.version, configured: stored.configured, modes, usage, googleFlowUrl: GOOGLE_FLOW_URL };
}

export const VideoRoutingUpdateSchema = z.object({ settings: z.unknown(), expectedVersion: z.number().int().min(0) }).strict();

export async function updateVideoRouting(tx: Tx, deps: Pick<CoreDeps, 'videos' | 'clock'>, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner', 'admin'], 'changing video generation settings');
  requireMfa(actor, 'changing video generation settings');
  const { settings: rawSettings, expectedVersion } = VideoRoutingUpdateSchema.parse(raw);
  const before = await storedVideoRouting(tx, tenantId);
  // A client that only knows the switchboard fields keeps the stored automation configuration.
  const withAutomation = rawSettings && typeof rawSettings === 'object' && !('automation' in rawSettings) ? { ...rawSettings, automation: before.settings.automation } : rawSettings;
  const settings = VideoRoutingSchema.parse(withAutomation);
  if (before.version !== expectedVersion) throw conflict(`video settings changed in the meantime (version ${before.version}); reload and try again`);
  const next = expectedVersion + 1;
  const updated = await tx
    .insert(tenantSettings)
    .values({ tenantId, policy: defaultTenantPolicy(), videoRouting: settings, videoRoutingVersion: next, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { videoRouting: settings, videoRoutingVersion: next, updatedAt: deps.clock.now(), updatedBy: actorRef(actor) }, setWhere: eq(tenantSettings.videoRoutingVersion, expectedVersion) })
    .returning({ version: tenantSettings.videoRoutingVersion });
  if (!updated.length) throw conflict('video settings changed in the meantime; reload and try again');
  const changed = Object.fromEntries(Object.entries(settings).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((before.settings as Record<string, unknown>)[k])));
  await audit(tx, tenantId, actor, 'media.video_routing.updated', { type: 'tenant_settings', id: tenantId }, { version: next, changed, previous: Object.fromEntries(Object.keys(changed).map((k) => [k, (before.settings as Record<string, unknown>)[k]])) });
  return videoRoutingOverview(tx, deps, tenantId);
}

/** Server-side switch: an OFF mode refuses new work, and Google Flow never accepts automated generation. */
export async function assertVideoModeEnabled(tx: DbOrTx, tenantId: string, mode: VideoMode, purpose: 'generate' | 'import' = 'generate'): Promise<VideoRouting> {
  const { settings } = await storedVideoRouting(tx, tenantId);
  if (!settings.enabled[mode]) throw forbidden(`${META[mode].label} is OFF in Video Generation Settings.`, { code: 'VIDEO_MODE_OFF' });
  if (mode === 'google_flow' && purpose !== 'import') throw forbidden('Google Flow is manual-only: generate in Flow and import the MP4. FUTUREGROW does not automate Flow.');
  if (isPaidVideoMode(mode) && settings.paidGenerationDisabled) throw forbidden('Paid video generation is disabled.', { code: 'PAID_VIDEO_DISABLED' });
  return settings;
}
