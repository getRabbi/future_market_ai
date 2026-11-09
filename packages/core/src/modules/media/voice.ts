import { type PlannedCall, SpeechProviderError } from '@futuregrow/agent-kernel';
import { canonicalJson } from '@futuregrow/contracts';
import { artifactLicenses, assetRights, type DbOrTx, mediaJobs, modelRegistry, type Tx, withTenant } from '@futuregrow/db';
import { forbidden, invalid, sha256Hex } from '@futuregrow/observability';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getAiBudget, guardAiCall, releaseAiCall } from '../../ai-budget.js';
import { type Actor, actorRef, type CoreDeps, systemActor } from '../../deps.js';
import { audit, clipText, requireRole } from '../../util.js';
import { admitInternalEvidence } from '../m01-evidence/index.js';
import { recomputeEligibility } from '../m14-assets/index.js';
import { recordCost } from '../m24-governance/index.js';

/**
 * AI voiceover (P3-04): text → synthetic speech → an audio asset the Video Studio can use as its
 * soundtrack. Same gates as AI images: a registry-approved speech model (commercial use allowed,
 * no training on customer data) with a per-character price, a configured provider, an approved
 * licence record for the model's output terms, and room in the AI spending limit. Only the
 * provider's stock synthetic voices are offered (no voice cloning, no real person's voice), and
 * every voiceover is labelled AI-generated. A status read never calls a provider.
 */

const EDIT_ROLES = ['owner', 'admin', 'growth_operator'] as const;

export interface SpeechReadiness {
  model: { provider: string; modelId: string; usdPerMillionChars: number | null } | null;
  voices: string[];
  maxCharacters: number | null;
  providerConfigured: boolean;
  licence: { id: string; name: string } | null;
  missing: string[];
}

export async function speechReadiness(t: DbOrTx, deps: Pick<CoreDeps, 'speech'>, modelId?: string): Promise<SpeechReadiness> {
  const models = await t.select().from(modelRegistry).where(eq(modelRegistry.approvedForProduction, true));
  const m = models.find((x) => x.purposes.includes('speech_generation') && x.commercialUse === 'allowed' && x.trainingOnCustomerData === 'no' && x.status === 'active' && (!modelId || x.modelId === modelId)) ?? null;
  const missing: string[] = [];
  if (!m) missing.push('a speech model approved for speech_generation (commercial use allowed, no training on customer data)');
  const provider = m ? deps.speech?.[m.provider] : undefined;
  if (m && !provider) missing.push(`the ${m.provider} speech provider is not configured on this server`);
  let licence: { id: string; name: string } | null = null;
  if (m) {
    const [l] = await t
      .select({ id: artifactLicenses.id, name: artifactLicenses.exactName })
      .from(artifactLicenses)
      .where(and(eq(artifactLicenses.exactName, `${m.provider}/${m.modelId}`), eq(artifactLicenses.approvedForProduction, true), eq(artifactLicenses.commercialUse, 'allowed')))
      .limit(1);
    licence = l ?? null;
    if (!licence) missing.push(`an approved licence record named "${m.provider}/${m.modelId}" for the voice output terms (Governance › licences)`);
    if (m.usdPerMillionChars === null) missing.push('a price per million characters in the model registry (unpriced speech models are not used)');
  }
  return { model: m ? { provider: m.provider, modelId: m.modelId, usdPerMillionChars: m.usdPerMillionChars } : null, voices: m && provider ? provider.voices(m.modelId) : [], maxCharacters: m && provider ? provider.maxCharacters(m.modelId) : null, providerConfigured: Boolean(provider), licence, missing };
}

export const VoiceoverRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(4096),
    voice: z.string().min(1).max(40),
    speed: z.number().min(0.5).max(2).optional(),
    modelId: z.string().max(120).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Wording that would make a synthetic voice pass as a real person, or impersonate one. */
const IMPERSONATION = [/\b(in the voice of|sound(s|ing)? like|imitat(e|ing)|impersonat(e|ing))\b/i, /\b(this is (not )?an? (ai|robot)|i am a real (person|human))\b/i];

export async function voiceoverProblems(t: DbOrTx, text: string): Promise<string[]> {
  const out: string[] = [];
  if (IMPERSONATION[0]!.test(text)) out.push('voiceovers never imitate or impersonate a person');
  if (IMPERSONATION[1]!.test(text)) out.push('the script must not claim to be (or not to be) a real person or an AI; the asset is labelled AI-generated');
  const { promptProblems } = await import('./sources.js');
  for (const p of await promptProblems(t, text)) out.push(p.replace(/^prompts/, 'scripts'));
  return out;
}

const costOf = (chars: number, usdPerMillion: number) => Math.round((chars / 1_000_000) * usdPerMillion * 1e6) / 1e6;

/** Queues a voiceover after checking every gate; nothing is synthesized here. */
export async function requestVoiceover(t: Tx, deps: CoreDeps, tenantId: string, actor: Actor, raw: unknown) {
  requireRole(actor, [...EDIT_ROLES], 'generating voiceovers');
  const input = VoiceoverRequestSchema.parse(raw);
  const ready = await speechReadiness(t, deps, input.modelId);
  if (ready.missing.length) throw forbidden(`AI voiceover is not enabled: ${ready.missing.join('; ')}`);
  if (!ready.voices.includes(input.voice)) throw invalid(`choose one of the model's voices: ${ready.voices.join(', ')}`);
  if (ready.maxCharacters && input.text.length > ready.maxCharacters) throw invalid(`the script is longer than ${ready.maxCharacters} characters; split it into parts`);
  const problems = await voiceoverProblems(t, input.text);
  if (problems.length) throw invalid(`script refused: ${problems.join('; ')}`);
  const cost = costOf(input.text.length, ready.model!.usdPerMillionChars!);
  const budget = await getAiBudget(t, tenantId, deps.config, deps.clock.now());
  if (budget.limitUsd !== null && (budget.remainingUsd ?? 0) < cost) throw forbidden(`the AI spending limit has $${(budget.remainingUsd ?? 0).toFixed(2)} left this month; this voiceover costs about $${cost}`);
  const request = { ...input, modelId: ready.model!.modelId };
  const [job] = await t
    .insert(mediaJobs)
    .values({ tenantId, kind: 'voiceover', provider: ready.model!.provider, modelId: ready.model!.modelId, request, requestSha256: sha256Hex(canonicalJson(request)), requestedBy: actorRef(actor) })
    .returning();
  await audit(t, tenantId, actor, 'media.voiceover.requested', { type: 'media_job', id: job!.id }, { provider: ready.model!.provider, modelId: ready.model!.modelId, voice: input.voice, characters: input.text.length, estimatedUsd: cost, text: clipText(input.text, 200) });
  return job!;
}

type Finish = (status: 'succeeded' | 'failed' | 'refused' | 'blocked' | 'queued', reason: string | null, patch?: Partial<typeof mediaJobs.$inferInsert>) => Promise<void>;
type StoreAsset = (
  t: Tx,
  deps: CoreDeps,
  tenantId: string,
  v: { bytes: Uint8Array; mime: string; kind: 'image' | 'video' | 'audio'; title: string; origin: 'stock' | 'generated'; width: number | null; height: number | null; manifest: Record<string, unknown>; disclosure: Record<string, unknown> },
) => Promise<{ id: string }>;

/** The worker step for one leased voiceover job (called by processNextMediaJob). */
export async function runVoiceover(
  deps: CoreDeps,
  row: typeof mediaJobs.$inferSelect,
  io: { finish: Finish; retryOrFail: (reason: string, retryable: boolean) => Promise<{ kind: 'retry' | 'failed'; jobId: string; reason: string }>; storeAsset: StoreAsset },
): Promise<{ kind: 'succeeded'; jobId: string; assetId: string } | { kind: 'retry' | 'failed' | 'refused' | 'blocked'; jobId: string; reason: string }> {
  const tenantId = row.tenantId;
  const tctx = { tenantId, actor: 'system:media-sources' };
  const actor = systemActor('media-sources');
  const req = row.request as z.infer<typeof VoiceoverRequestSchema> & { modelId: string };
  const ready = await withTenant(deps.db, tctx, (t) => speechReadiness(t, deps, req.modelId));
  if (ready.missing.length) {
    await io.finish('blocked', `no longer enabled: ${ready.missing.join('; ')}`);
    return { kind: 'blocked', jobId: row.id, reason: ready.missing.join('; ') };
  }
  const problems = await withTenant(deps.db, tctx, (t) => voiceoverProblems(t, req.text));
  if (problems.length) {
    await io.finish('refused', problems.join('; '));
    return { kind: 'refused', jobId: row.id, reason: problems.join('; ') };
  }
  const provider = deps.speech![ready.model!.provider]!;
  const cost = costOf(req.text.length, ready.model!.usdPerMillionChars!);
  const call: PlannedCall = { provider: ready.model!.provider, modelId: req.modelId, purpose: 'speech_generation', maxCostUsd: cost };
  try {
    await guardAiCall(deps.db, deps.config, tenantId, call, deps.clock.now());
  } catch (err) {
    await io.finish('blocked', err instanceof Error ? err.message : String(err));
    return { kind: 'blocked', jobId: row.id, reason: 'budget' };
  }
  let speech: Awaited<ReturnType<typeof provider.synthesize>>;
  try {
    speech = await provider.synthesize({ model: req.modelId, voice: req.voice, text: req.text, ...(req.speed ? { speed: req.speed } : {}) });
  } catch (err) {
    releaseAiCall(call);
    if (err instanceof SpeechProviderError && (err.kind === 'refused' || err.kind === 'invalid_request')) {
      await io.finish('refused', err.message);
      return { kind: 'refused', jobId: row.id, reason: err.message };
    }
    return io.retryOrFail(err instanceof Error ? err.message : String(err), err instanceof SpeechProviderError ? err.retryable : true);
  }
  releaseAiCall(call);
  const disclosureText = 'AI-generated voice';
  const assetId = await withTenant(deps.db, tctx, async (t) => {
    await recordCost(t, tenantId, {
      category: 'speech_generation',
      provider: ready.model!.provider,
      unit: 'characters',
      quantity: speech.characters,
      unitCostUsd: ready.model!.usdPerMillionChars! / 1_000_000,
      refType: 'media_job',
      refId: row.id,
      metadata: { model: req.modelId, voice: req.voice, requestId: speech.requestId },
    });
    const ev = await admitInternalEvidence(t, tenantId, actor, {
      kind: 'document',
      owner: 'futuregrow-media-sources',
      uri: `generated://${row.id}`,
      content: { mediaJobId: row.id, provider: ready.model!.provider, modelId: req.modelId, voice: req.voice, script: req.text, characters: speech.characters, outputSha256: sha256Hex(speech.bytes), requestId: speech.requestId, licenceRecord: ready.licence },
      summary: `AI voiceover from ${ready.model!.provider}/${req.modelId} (${req.voice})`,
      confidence: 1,
      license: `generated speech under the ${ready.model!.provider} terms recorded as "${ready.licence!.name}"`,
      permittedUses: ['creative_generation', 'publishing'],
      now: deps.clock.now(),
    });
    const asset = await io.storeAsset(t, deps, tenantId, {
      bytes: speech.bytes,
      mime: speech.mime,
      kind: 'audio',
      title: req.title ?? clipText(`AI voiceover: ${req.text}`, 200),
      origin: 'generated',
      width: null,
      height: null,
      manifest: { contains: { music: false, voice: true, likeness: false, aiGenerated: true }, captions: req.text, claimIds: [], model: { provider: ready.model!.provider, modelId: req.modelId, voice: req.voice }, provenanceEvidenceId: ev.evidenceId },
      disclosure: { isAiGenerated: true, syntheticPersonaId: null, disclosureText },
    });
    const existing = await t.select({ component: assetRights.component }).from(assetRights).where(eq(assetRights.assetId, asset.id));
    if (!existing.length) {
      await t.insert(assetRights).values([
        { tenantId, assetId: asset.id, component: 'source_media', rightsHolder: 'tenant (generated output)', licenseRef: `generated by ${ready.model!.provider}/${req.modelId}`, artifactLicenseId: null, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null },
        { tenantId, assetId: asset.id, component: 'model', rightsHolder: ready.model!.provider, licenseRef: ready.licence!.name, artifactLicenseId: ready.licence!.id, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null },
        // A synthetic stock voice: no person's voice is used, so the voice right is the model's output licence.
        { tenantId, assetId: asset.id, component: 'voice', rightsHolder: `${ready.model!.provider} (synthetic voice "${req.voice}")`, licenseRef: ready.licence!.name, artifactLicenseId: ready.licence!.id, commercialUse: 'allowed', evidenceId: ev.evidenceId, expiresAt: null },
      ]);
    }
    await recomputeEligibility(t, deps, tenantId, asset.id);
    return asset.id;
  });
  await io.finish('succeeded', null, { assetId, costUsd: cost, provenance: { model: req.modelId, voice: req.voice, requestId: speech.requestId, characters: speech.characters } });
  return { kind: 'succeeded', jobId: row.id, assetId };
}
