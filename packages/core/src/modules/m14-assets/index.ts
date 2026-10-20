import { desc, eq, inArray } from 'drizzle-orm';
import { canonicalJson } from '@futuregrow/contracts';
import { type DbOrTx, type Tx, artifactLicenses, assetRights, assets, evidenceRecords, renderJobs, syntheticPersonas, tenantSettings } from '@futuregrow/db';
import { forbidden, invalid, notFound, sha256Hex } from '@futuregrow/observability';
import { tenantKey } from '@futuregrow/storage';
import { z } from 'zod';
import { type Actor, type CoreDeps, actorRef } from '../../deps.js';
import { audit, record, requireMfa, requireRole } from '../../util.js';
import { lintCopy } from '../m03-knowledge/index.js';
import { getTenantSettingsRow } from '../m24-governance/index.js';
import { personaContentCheck } from '../m15-personas/index.js';

/* ------------------------------------------------------------------ */
/* Media sniffing (uploads)                                            */
/* ------------------------------------------------------------------ */

export function sniffMedia(b: Uint8Array): { mime: string | null; width: number | null; height: number | null } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { mime: 'image/gif', width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1]!;
      const len = dv.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mime: 'image/jpeg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (b.length > 12 && String.fromCharCode(...b.slice(4, 8)) === 'ftyp') return { mime: 'video/mp4', width: null, height: null };
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return { mime: 'image/webp', width: null, height: null };
  if (b.length > 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))) return { mime: 'audio/mpeg', width: null, height: null };
  return { mime: null, width: null, height: null };
}

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'audio/mpeg']);

export const UploadMetaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio']),
  title: z.string().min(1).max(200),
  briefId: z.string().uuid().nullable().default(null),
  personaId: z.string().uuid().nullable().default(null),
  contains: z.object({ music: z.boolean().default(false), voice: z.boolean().default(false), likeness: z.boolean().default(false), aiGenerated: z.boolean().default(false) }).default({ music: false, voice: false, likeness: false, aiGenerated: false }),
  captions: z.string().max(5000).default(''),
  claimIds: z.array(z.string().uuid()).default([]),
});

export async function uploadAsset(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, metaRaw: unknown, bytes: Uint8Array) {
  const meta = UploadMetaSchema.parse(metaRaw);
  if (bytes.byteLength === 0) throw invalid('empty upload');
  const sniff = sniffMedia(bytes);
  if (!sniff.mime || !ALLOWED_MIME.has(sniff.mime)) throw invalid('unsupported or unrecognised media type');
  if (!sniff.mime.startsWith(meta.kind)) throw invalid(`content is ${sniff.mime}, declared kind ${meta.kind}`);
  const sha = sha256Hex(bytes);
  const [existing] = await tx.select().from(assets).where(eq(assets.sha256, sha));
  if (existing) return existing;
  const put = await deps.store.put(tenantKey(tenantId, 'assets', `${sha}`), bytes, sniff.mime);
  const [row] = await tx
    .insert(assets)
    .values({
      tenantId,
      kind: meta.kind,
      title: meta.title,
      objectKey: put.key,
      sha256: sha,
      mime: sniff.mime,
      bytes: put.bytes,
      width: sniff.width,
      height: sniff.height,
      origin: 'upload',
      briefId: meta.briefId,
      personaId: meta.personaId,
      manifest: { contains: meta.contains, captions: meta.captions, claimIds: meta.claimIds, uploadedBy: actorRef(actor) },
      qa: { technical: { passed: true, mime: sniff.mime, width: sniff.width, height: sniff.height } },
      disclosure: { isAiGenerated: meta.contains.aiGenerated || meta.personaId !== null, syntheticPersonaId: meta.personaId },
      createdBy: actorRef(actor),
    })
    .returning();
  await audit(tx, tenantId, actor, 'media.asset.uploaded', { type: 'asset', id: row!.id }, { sha256: sha, mime: sniff.mime, bytes: put.bytes });
  return recomputeEligibility(tx, deps, tenantId, row!.id);
}

/* ------------------------------------------------------------------ */
/* Rights manifest + publish eligibility (M14 AC, FG-P1-004)           */
/* ------------------------------------------------------------------ */

export const RightsSchema = z.array(
  z.object({
    component: z.enum(['source_media', 'music', 'voice', 'likeness', 'font', 'model', 'plugin', 'template']),
    rightsHolder: z.string().min(2).max(200),
    licenseRef: z.string().min(2).max(500),
    artifactLicenseId: z.string().uuid().nullable().default(null),
    commercialUse: z.enum(['allowed', 'restricted', 'unknown']),
    evidenceId: z.string().uuid(),
    expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  }),
).min(1).max(20);

export async function addRights(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, assetId: string, raw: unknown) {
  requireRole(actor, ['owner', 'admin', 'legal_approver', 'growth_operator'], 'recording asset rights');
  const items = RightsSchema.parse(raw);
  const [a] = await tx.select().from(assets).where(eq(assets.id, assetId));
  if (!a) throw notFound('asset');
  for (const r of items) {
    await tx.insert(assetRights).values({ tenantId, assetId, ...r, expiresAt: r.expiresAt ? new Date(r.expiresAt) : null });
  }
  await audit(tx, tenantId, actor, 'media.asset.rights_recorded', { type: 'asset', id: assetId }, { components: items.map((i) => i.component) });
  return recomputeEligibility(tx, deps, tenantId, assetId);
}

export async function recomputeEligibility(tx: Tx, deps: CoreDeps, tenantId: string, assetId: string) {
  const now = deps.clock.now();
  const [a] = await tx.select().from(assets).where(eq(assets.id, assetId));
  if (!a) throw notFound('asset');
  const rights = await tx.select().from(assetRights).where(eq(assetRights.assetId, assetId));
  const reasons: string[] = [];
  const has = (c: string) => rights.some((r) => r.component === c);
  const manifest = a.manifest as { contains?: { music?: boolean; voice?: boolean; likeness?: boolean; aiGenerated?: boolean }; captions?: string; claimIds?: string[] };
  if (!has('source_media')) reasons.push('missing source-media rights');
  if (a.origin === 'render' && !has('template')) reasons.push('missing template rights for rendered asset');
  if (a.origin === 'generated' && !has('model')) reasons.push('missing model/weights licence for generated asset');
  if (manifest.contains?.music && !has('music')) reasons.push('contains music without music rights');
  if (manifest.contains?.voice && !has('voice')) reasons.push('contains voice without voice consent/licence');
  if ((manifest.contains?.likeness || a.personaId) && !has('likeness')) reasons.push('contains a likeness without likeness rights');
  const evIds = rights.map((r) => r.evidenceId);
  const evs = evIds.length ? await tx.select().from(evidenceRecords).where(inArray(evidenceRecords.id, evIds)) : [];
  const artIds = rights.map((r) => r.artifactLicenseId).filter((x): x is string => Boolean(x));
  const arts = artIds.length ? await tx.select().from(artifactLicenses).where(inArray(artifactLicenses.id, artIds)) : [];
  for (const r of rights) {
    if (r.commercialUse !== 'allowed') reasons.push(`${r.component}: commercial use is ${r.commercialUse}`);
    if (r.expiresAt && r.expiresAt <= now) reasons.push(`${r.component}: rights expired`);
    const ev = evs.find((e) => e.id === r.evidenceId);
    if (!ev || ev.status !== 'admitted') reasons.push(`${r.component}: rights evidence not admitted`);
    if (r.artifactLicenseId) {
      const art = arts.find((x) => x.id === r.artifactLicenseId);
      if (!art || !art.approvedForProduction) reasons.push(`${r.component}: artifact licence not approved for production`);
    }
    if ((r.component === 'model' || r.component === 'plugin') && !r.artifactLicenseId) reasons.push(`${r.component}: must reference a registered artifact licence`);
  }
  const disclosure = a.disclosure as { isAiGenerated?: boolean };
  if ((a.origin === 'generated' || a.personaId || manifest.contains?.aiGenerated) && !disclosure.isAiGenerated) reasons.push('synthetic content must carry an AI-generated disclosure');
  if (a.personaId) {
    const [p] = await tx.select().from(syntheticPersonas).where(eq(syntheticPersonas.id, a.personaId));
    if (!p || p.status !== 'approved') reasons.push('persona is not approved');
  }
  const qa = a.qa as { technical?: { passed?: boolean } };
  if (qa.technical?.passed !== true) reasons.push('technical QA has not passed');
  let claimsQa: unknown = null;
  if (manifest.captions?.trim()) {
    const lint = await lintCopy(tx, manifest.captions, { claimIds: manifest.claimIds ?? [], now });
    const personaCheck = a.personaId ? personaContentCheck(manifest.captions) : { passed: true, findings: [] };
    claimsQa = { lint: { passed: lint.passed, violations: lint.violations }, persona: personaCheck };
    if (!lint.passed) reasons.push('caption copy failed claim/brand lint');
    if (!personaCheck.passed) reasons.push('persona caption makes first-person customer-experience claims');
  }
  const eligible = reasons.length === 0;
  const [row] = await tx
    .update(assets)
    .set({ publishEligible: eligible, eligibilityReasons: reasons, qa: { ...qa, claims: claimsQa, evaluatedAt: now.toISOString() } })
    .where(eq(assets.id, assetId))
    .returning();
  if (eligible !== a.publishEligible) {
    await record(tx, tenantId, { type: 'system', id: 'asset-qa', roles: [], mfaVerified: false }, 'media.asset.eligibility_changed', { type: 'asset', id: assetId }, { eligible, reasons });
  }
  return row!;
}

/* ------------------------------------------------------------------ */
/* Rendering (Remotion licence gate, D-005/B-014)                      */
/* ------------------------------------------------------------------ */

export const RemotionLicenseSchema = z.discriminatedUnion('eligibility', [
  z.object({ eligibility: z.literal('free_license'), basis: z.enum(['individual', 'organization_up_to_3_people', 'non_profit']), teamSize: z.number().int().positive().max(3).optional(), attestation: z.string().min(20) }),
  z.object({ eligibility: z.literal('company_license'), licenseRef: z.string().min(3), attestation: z.string().min(20) }),
]);

export async function recordRemotionLicense(tx: Tx, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, ['owner'], 'recording the Remotion licence');
  requireMfa(actor, 'recording the Remotion licence');
  const lic = RemotionLicenseSchema.parse(raw);
  const value = { ...lic, recordedBy: actorRef(actor), recordedAt: new Date().toISOString() };
  const existing = await getTenantSettingsRow(tx, tenantId);
  if (existing) await tx.update(tenantSettings).set({ remotionLicense: value, updatedAt: new Date() }).where(eq(tenantSettings.tenantId, tenantId));
  else await tx.insert(tenantSettings).values({ tenantId, policy: { version: 1, configured: false, categories: {} }, remotionLicense: value, updatedBy: actorRef(actor) });
  await audit(tx, tenantId, actor, 'media.remotion_license.recorded', { type: 'tenant_settings', id: tenantId }, { eligibility: lic.eligibility });
  return value;
}

export const COMPOSITIONS = {
  product_showcase: { width: 1080, height: 1920, fps: 30, durationInFrames: 450 },
  ugc_captioned: { width: 1080, height: 1920, fps: 30, durationInFrames: 600 },
  persona_story: { width: 1080, height: 1920, fps: 30, durationInFrames: 600 },
} as const;

export const RenderRequestSchema = z.object({
  composition: z.enum(['product_showcase', 'ugc_captioned', 'persona_story']),
  inputAssetIds: z.array(z.string().uuid()).min(1).max(12),
  props: z.object({
    headline: z.string().max(120).default(''),
    captions: z.array(z.string().max(200)).max(20).default([]),
    cta: z.string().max(60).default(''),
    brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#111111'),
    disclosureText: z.string().max(120).default(''),
  }),
  claimIds: z.array(z.string().uuid()).default([]),
  briefId: z.string().uuid().nullable().default(null),
  personaId: z.string().uuid().nullable().default(null),
});

export async function requestRender(tx: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  const req = RenderRequestSchema.parse(raw);
  const inputs = await tx.select().from(assets).where(inArray(assets.id, req.inputAssetIds));
  if (inputs.length !== new Set(req.inputAssetIds).size) throw invalid('input asset not found');
  for (const i of inputs) {
    const rights = await tx.select().from(assetRights).where(eq(assetRights.assetId, i.id));
    if (!rights.some((r) => r.component === 'source_media' && r.commercialUse === 'allowed')) throw forbidden(`input asset ${i.id} lacks cleared source-media rights`);
  }
  let disclosure = req.props.disclosureText;
  if (req.composition === 'persona_story' || req.personaId) {
    if (!req.personaId) throw invalid('persona_story requires personaId');
    const [p] = await tx.select().from(syntheticPersonas).where(eq(syntheticPersonas.id, req.personaId));
    if (!p || p.status !== 'approved') throw forbidden('persona is not approved');
    disclosure = p.disclosureCopy; // mandatory on-screen disclosure overlay
    const check = personaContentCheck([req.props.headline, ...req.props.captions].join('\n'));
    if (!check.passed) throw invalid('persona script contains first-person customer-experience claims');
  }
  const lint = await lintCopy(tx, [req.props.headline, ...req.props.captions, req.props.cta].join('\n'), { claimIds: req.claimIds, now: deps.clock.now() });
  if (!lint.passed) throw invalid(`render copy failed lint: ${lint.violations.map((v) => v.code).join(', ')}`);
  const settings = await getTenantSettingsRow(tx, tenantId);
  const licensed = Boolean(settings?.remotionLicense);
  const spec = COMPOSITIONS[req.composition];
  const workflowConfig = {
    engine: 'remotion',
    composition: req.composition,
    ...spec,
    codec: 'h264',
    props: { ...req.props, disclosureText: disclosure },
    inputs: inputs.map((i) => ({ assetId: i.id, sha256: i.sha256, mime: i.mime })),
    claimIds: req.claimIds,
  };
  const [job] = await tx
    .insert(renderJobs)
    .values({
      tenantId,
      composition: req.composition,
      inputProps: workflowConfig.props,
      inputAssetIds: req.inputAssetIds,
      briefId: req.briefId,
      personaId: req.personaId,
      status: licensed ? 'queued' : 'blocked_license',
      statusReason: licensed ? null : 'Remotion licence eligibility not recorded (B-014)',
      workflowConfig,
      configSha256: sha256Hex(canonicalJson(workflowConfig)),
      requestedBy: actorRef(actor),
    })
    .returning();
  if (licensed) await record(tx, tenantId, actor, 'media.render.requested', { type: 'render_job', id: job!.id }, { composition: req.composition });
  else await audit(tx, tenantId, actor, 'media.render.blocked', { type: 'render_job', id: job!.id }, { reason: 'remotion licence not recorded' });
  return job!;
}

export async function listAssets(tx: DbOrTx) {
  return tx.select().from(assets).orderBy(desc(assets.createdAt)).limit(500);
}

export async function assetDetail(tx: DbOrTx, id: string) {
  const [a] = await tx.select().from(assets).where(eq(assets.id, id));
  if (!a) throw notFound('asset');
  const rights = await tx.select().from(assetRights).where(eq(assetRights.assetId, id));
  return { asset: a, rights };
}

export async function listRenderJobs(tx: DbOrTx) {
  return tx.select().from(renderJobs).orderBy(desc(renderJobs.requestedAt)).limit(200);
}

