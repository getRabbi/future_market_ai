import { artifactLicenses, modelRegistry, tenantSettings, type DbOrTx, type Tx } from '@futuregrow/db';
import { forbidden, invalid } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { defaultTenantPolicy } from '@futuregrow/policies';
import { type Actor, actorRef, type CoreDeps } from '../../deps.js';
import { audit, requireMfa, requireRole } from '../../util.js';

/**
 * Tenant-controlled video routing. A configured OFF switch blocks new submissions.
 * Flow is manual-only. Paid cloud routes never activate merely because their toggle
 * is ON: the approved provider, rights, price, budget and explicit mode still matter.
 */
export const VideoModeSchema = z.enum(['remotion', 'google_flow', 'wan_cloud', 'higgsfield']);
export type VideoMode = z.infer<typeof VideoModeSchema>;
export const VideoRoutingSchema = z.object({
  enabled: z.object({
    remotion: z.boolean(),
    google_flow: z.boolean(),
    wan_cloud: z.boolean(),
    higgsfield: z.boolean(),
  }).strict(),
  selected: z.enum(['smart', ...VideoModeSchema.options] as ['smart', ...VideoMode[]]),
  dailyTarget: z.number().int().min(1).max(10),
  maxPaidUsdPerDay: z.number().finite().min(0).max(1000),
}).strict();
export type VideoRouting = z.infer<typeof VideoRoutingSchema>;

export const DEFAULT_VIDEO_ROUTING: VideoRouting = {
  enabled: { remotion: true, google_flow: false, wan_cloud: false, higgsfield: false },
  selected: 'smart',
  dailyTarget: 5,
  maxPaidUsdPerDay: 0,
};

export function normalizeVideoRouting(raw: unknown): VideoRouting {
  return raw == null ? DEFAULT_VIDEO_ROUTING : VideoRoutingSchema.parse(raw);
}

export async function storedVideoRouting(tx: DbOrTx, tenantId: string): Promise<{ settings: VideoRouting; configured: boolean }> {
  const [row] = await tx.select({ videoRouting: tenantSettings.videoRouting }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  return { settings: normalizeVideoRouting(row?.videoRouting), configured: row?.videoRouting != null };
}

type ModeStatus = { id: VideoMode; enabled: boolean; ready: boolean; kind: 'automatic' | 'manual' | 'paid'; requires: string[]; note: string };
const SOURCE_META: Record<VideoMode, { kind: ModeStatus['kind']; note: string }> = {
  remotion: { kind: 'automatic', note: 'CPU template render with approved Remotion licence; no generative GPU.' },
  google_flow: { kind: 'manual', note: 'Generate at Google Flow and upload the result to Assets. No official free automation API.' },
  wan_cloud: { kind: 'paid', note: 'Remote Wan/ComfyUI GPU adapter; GPU time may be billed.' },
  higgsfield: { kind: 'paid', note: 'Higgsfield developer API; provider charges apply, not website free credits.' },
};

export async function videoRoutingOverview(tx: DbOrTx, deps: Pick<CoreDeps, 'videos'>, tenantId: string) {
  const { settings, configured } = await storedVideoRouting(tx, tenantId);
  const [tenant] = await tx.select({ remotionLicense: tenantSettings.remotionLicense }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId));
  const models = await tx.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
  const licences = await tx.select().from(artifactLicenses).where(eq(artifactLicenses.approvedForProduction, true));
  const output: ModeStatus[] = [];
  for (const id of VideoModeSchema.options) {
    const requires: string[] = [];
    if (id === 'remotion' && !tenant?.remotionLicense) requires.push('Record eligible Remotion licence first.');
    if (id === 'wan_cloud' || id === 'higgsfield') {
      const eligible = models.find((m) => m.provider === id && m.status === 'active' && m.purposes.includes('video_generation') && m.commercialUse === 'allowed' && m.trainingOnCustomerData === 'no' && m.usdPerVideoSecond != null && Number.isFinite(m.usdPerVideoSecond) && m.usdPerVideoSecond >= 0 && licences.some((l) => l.exactName === `${m.provider}/${m.modelId}` && l.commercialUse === 'allowed'));
      if (!eligible) requires.push('Approved, priced model plus commercially cleared output licence.');
      if (!deps.videos?.[id]) requires.push('Verified, credentialed provider adapter with bounded/replay-safe billing.');
      if (settings.maxPaidUsdPerDay <= 0) requires.push('Set a nonzero daily paid budget cap.');
    }
    output.push({ id, enabled: settings.enabled[id], ready: requires.length === 0, kind: SOURCE_META[id].kind, requires, note: SOURCE_META[id].note });
  }
  return { settings, configured, modes: output, route: chooseVideoRoute(settings, output) };
}

/** Smart never silently routes to a chargeable provider. Explicit paid mode is required. */
export function chooseVideoRoute(settings: VideoRouting, modes: ModeStatus[]) {
  const available = (id: VideoMode) => settings.enabled[id] && modes.some((m) => m.id === id && m.ready);
  if (settings.selected === 'smart') {
    if (available('remotion')) return { mode: 'remotion' as VideoMode, execution: 'automatic' as const, reason: 'Free-first template rendering.' };
    if (available('google_flow')) return { mode: 'google_flow' as VideoMode, execution: 'manual' as const, reason: 'Free manual Flow generation and asset import; no background generation.' };
    return { mode: null, execution: 'unavailable' as const, reason: 'No free operational mode enabled; paid fallback requires explicit selection.' };
  }
  if (!available(settings.selected)) return { mode: null, execution: 'unavailable' as const, reason: `${settings.selected} is disabled or not ready.` };
  const execution = settings.selected === 'google_flow' ? 'manual' as const : settings.selected === 'remotion' ? 'automatic' as const : 'approval_required' as const;
  return { mode: settings.selected, execution, reason: execution === 'approval_required' ? 'Paid provider requires explicit generation and approved budget; ON never charges by itself.' : 'Selected mode ready.' };
}

export async function updateVideoRouting(tx: Tx, deps: Pick<CoreDeps, 'videos'>, tenantId: string, actor: Actor, input: unknown) {
  requireRole(actor, ['owner', 'admin'], 'updating video generation modes');
  requireMfa(actor, 'changing video generation modes');
  const settings = VideoRoutingSchema.parse(input);
  const overview = await videoRoutingOverview(tx, deps, tenantId);
  // A disabled provider may always be turned OFF, but enabling an unready paid provider is refused.
  for (const id of ['wan_cloud', 'higgsfield'] as const) {
    if (settings.enabled[id] && !overview.settings.enabled[id]) {
      if (!deps.videos?.[id]) throw forbidden(`${id} adapter and credentials are not verified; cannot enable paid generation.`);
      const valid = overview.modes.find((m) => m.id === id)?.requires.filter((r) => !r.startsWith('Set a nonzero daily paid budget'));
      if (valid?.length) throw forbidden(`${id} missing: ${valid.join('; ')}`);
    }
    if (settings.enabled[id] && settings.maxPaidUsdPerDay <= 0) throw invalid('A nonzero daily paid budget is required for an enabled paid mode.');
  }
  if (settings.selected !== 'smart' && !settings.enabled[settings.selected]) throw invalid('Selected video mode must be enabled.');
  await tx.insert(tenantSettings)
    .values({ tenantId, policy: defaultTenantPolicy(), videoRouting: settings, updatedBy: actorRef(actor) })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { videoRouting: settings, updatedAt: new Date(), updatedBy: actorRef(actor) } });
  await audit(tx, tenantId, actor, 'media.video_routing.updated', { type: 'tenant_settings', id: tenantId }, { enabled: settings.enabled, selected: settings.selected, dailyTarget: settings.dailyTarget, maxPaidUsdPerDay: settings.maxPaidUsdPerDay });
  return videoRoutingOverview(tx, deps, tenantId);
}

/** If the tenant has configured the switchboard, OFF is enforced server-side. */
export async function assertVideoModeEnabled(tx: DbOrTx, tenantId: string, mode: VideoMode, expectedCostUsd = 0): Promise<void> {
  const { settings, configured } = await storedVideoRouting(tx, tenantId);
  // Existing tenants without a router record retain the previous licensed provider gates.
  if (!configured) return;
  if (!settings.enabled[mode]) throw forbidden(`${mode} video mode is OFF.`);
  if (mode === 'google_flow') throw forbidden('Google Flow is manual-only; upload finished clips to Assets.');
  if ((mode === 'higgsfield' || mode === 'wan_cloud') && (settings.selected !== mode || expectedCostUsd > settings.maxPaidUsdPerDay || settings.maxPaidUsdPerDay <= 0)) {
    throw forbidden('Select the paid provider explicitly and configure a sufficient daily spending cap.');
  }
}
