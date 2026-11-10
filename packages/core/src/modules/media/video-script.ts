import { PROMPTS } from '@futuregrow/agent-kernel';
import { z } from 'zod';
import { runAgent } from '../../agents.js';
import type { CoreDeps } from '../../deps.js';
import { type CurriculumPack, packVersion, type Unit, verifyCurriculumText } from '../studio/curriculum.js';
import { VIDEO_PRESETS, type VideoPreset } from './formats.js';
import { MAX_VIDEO_SECONDS, type Storyboard, StoryboardSchema } from './video.js';

/**
 * Automatic scripts and storyboards for the daily video automation (D-053). A topic comes from a
 * brand's own verified material only: a curriculum unit, a human-approved Content Studio item,
 * an approved claim, or (with AI) a content pillar. A script is either written by the approved
 * model gateway (grounded in approved claims, IDs checked, never repaired) or built from a fixed
 * template that quotes the verified material verbatim. Either way it becomes an ordinary Video
 * Studio storyboard (StoryboardSchema) and passes the same rights, claims and disclosure gates.
 */

const PRESET_KEYS = Object.keys(VIDEO_PRESETS) as [VideoPreset, ...VideoPreset[]];

/** Curriculum unit kinds that make a good short video (notices and weekly challenges do not). */
export const CURRICULUM_VIDEO_KINDS = ['vocab', 'hangul', 'grammar', 'mistake', 'dialogue', 'quiz'] as const;
/** A general brand's pseudo-category: videos built around one approved product claim. */
export const CLAIMS_CATEGORY = 'approved_claims';

export interface VideoTopic {
  /** Stable identity for duplicate prevention: `eps:<pack>:<unit>`, `item:<id>`, `claim:<id>`, `pillar:<key>:<day>:<n>`. */
  key: string;
  category: string;
  source: 'curriculum' | 'content_item' | 'claim' | 'pillar';
  title: string;
  /** What the video should say (an approved item's key message, a claim, a pillar description). */
  angle: string;
  hook: string;
  claimIds: string[];
  programId: string;
  pack?: string;
  packVersion?: string;
  unitId?: string;
  itemId?: string;
}

export const ScriptSceneSchema = z
  .object({
    onScreenText: z.string().trim().max(160),
    voiceover: z.string().trim().max(400),
    subtitle: z.string().trim().max(200),
    seconds: z.number().int().min(2).max(15),
    mediaHint: z.string().trim().max(160).default(''),
  })
  .strict();

export const VideoScriptSchema = z
  .object({
    title: z.string().trim().min(3).max(140),
    hook: z.string().trim().min(1).max(160),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
    platform: z.string().max(20),
    preset: z.enum(PRESET_KEYS),
    scenes: z.array(ScriptSceneSchema).min(2).max(10),
    cta: z.string().trim().max(60),
    suggestedMedia: z.array(z.string().trim().min(2).max(160)).max(10).default([]),
    claimIds: z.array(z.string().uuid()).max(10).default([]),
    evidenceIds: z.array(z.string()).max(10).default([]),
    curriculum: z.object({ pack: z.string(), version: z.string(), unitId: z.string() }).strict().nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    const total = s.scenes.reduce((a, x) => a + x.seconds, 0);
    if (total > MAX_VIDEO_SECONDS) ctx.addIssue({ code: 'custom', path: ['scenes'], message: `total length ${total}s exceeds ${MAX_VIDEO_SECONDS}s` });
  });
export type VideoScript = z.infer<typeof VideoScriptSchema>;
type Scene = z.input<typeof ScriptSceneSchema>;

/** Platforms that natively show a format, best first. */
export const PRESET_PLATFORMS: Record<VideoPreset, readonly string[]> = {
  vertical_9x16: ['tiktok', 'instagram', 'youtube', 'facebook'],
  square_1x1: ['instagram', 'facebook', 'linkedin', 'x'],
  landscape_16x9: ['youtube', 'facebook', 'linkedin', 'x'],
};

export function platformFor(preset: VideoPreset, available: readonly string[]): string {
  return PRESET_PLATFORMS[preset].find((p) => available.includes(p)) ?? available[0] ?? PRESET_PLATFORMS[preset][0]!;
}

const fits = (s: string, max: number) => s.length > 0 && s.length <= max;
const scene = (onScreenText: string, subtitle: string, voiceover: string, seconds = 4): Scene => ({ onScreenText, subtitle, voiceover, seconds, mediaHint: '' });

/* ------------------------------------------------------------------ */
/* Curriculum (EPS-TOPIK Bangla) templates: verified unit content only  */
/* ------------------------------------------------------------------ */

export const EPS_DEFAULT_CTA = 'প্রতিদিন নতুন পাঠের জন্য ফলো করুন';
const OPTION_MARKS = ['ক', 'খ', 'গ', 'ঘ'];

function curriculumScenes(unit: Unit): { title: string; hook: string; scenes: Scene[] } | null {
  switch (unit.kind) {
    case 'vocab': {
      const v = unit.data;
      return {
        title: `${v.ko} — ${v.bn}`,
        hook: 'আজকের কোরিয়ান শব্দ',
        scenes: [
          scene('আজকের কোরিয়ান শব্দ', 'EPS-TOPIK প্রস্তুতি', 'চলুন আজকের কোরিয়ান শব্দটি শিখি।', 3),
          scene(v.ko, `উচ্চারণ: ${v.bnSound} (${v.rr})`, `${v.ko}। উচ্চারণ ${v.bnSound}।`),
          scene(`${v.ko} = ${v.bn}`, `অর্থ: ${v.bn}`, `এর অর্থ ${v.bn}।`),
          scene(v.example.ko, v.example.bn, `উদাহরণ: ${v.example.ko} — ${v.example.bn}`, 5),
        ],
      };
    }
    case 'hangul': {
      const h = unit.data;
      return {
        title: `কোরিয়ান বর্ণমালা: ${h.letter}`,
        hook: `কোরিয়ান বর্ণমালা: ${h.letter}`,
        scenes: [
          scene(`কোরিয়ান বর্ণমালা: ${h.letter}`, h.kind === 'vowel' ? 'স্বরবর্ণ' : 'ব্যঞ্জনবর্ণ', 'আজ আমরা একটি কোরিয়ান বর্ণ শিখব।', 3),
          scene(h.letter, `নাম: ${h.nameBn} (${h.nameKo})`, `এই বর্ণের নাম ${h.nameBn}।`),
          scene(`ধ্বনি: ${h.soundBn}`, `${h.letter} → ${h.soundBn}`, `এর ধ্বনি ${h.soundBn}।`),
          ...h.examples.slice(0, 2).map((e) => scene(e.ko, e.bn, `উদাহরণ: ${e.ko} — ${e.bn}`)),
        ],
      };
    }
    case 'grammar': {
      const g = unit.data;
      return {
        title: `ব্যাকরণ: ${g.pattern}`,
        hook: g.titleBn,
        scenes: [scene(g.titleBn, `ব্যাকরণ: ${g.pattern}`, `আজকের ব্যাকরণ: ${g.titleBn}।`, 3), scene(g.pattern, g.explainBn, g.explainBn, 5), ...g.rules.slice(0, 2).map((r) => scene(r.use, r.when, `${r.when}: ${r.use}`)), ...g.examples.slice(0, 2).map((e) => scene(e.ko, e.bn, `উদাহরণ: ${e.ko} — ${e.bn}`))],
      };
    }
    case 'mistake': {
      const m = unit.data;
      return {
        title: `সাধারণ ভুল: ${m.titleBn}`,
        hook: m.titleBn,
        scenes: [scene(m.titleBn, 'সাধারণ ভুল', `সাধারণ একটি ভুল: ${m.titleBn}।`, 3), scene(`❌ ${m.wrong.ko}`, m.wrong.bn, `ভুল: ${m.wrong.ko}`), scene(`✅ ${m.right.ko}`, m.right.bn, `সঠিক: ${m.right.ko}`), scene('মনে রাখুন', m.tipBn, m.tipBn, 5)],
      };
    }
    case 'dialogue': {
      const d = unit.data;
      return {
        title: `কথোপকথন: ${d.titleBn}`,
        hook: d.titleBn,
        scenes: [scene(d.titleBn, d.situationBn, d.situationBn, 4), ...d.lines.slice(0, 6).map((l) => scene(`${l.speaker}: ${l.ko}`, l.bn, `${l.ko} — ${l.bn}`))],
      };
    }
    case 'quiz': {
      const q = unit.data;
      const question = q.form === 'meaning' ? `${q.vocab.ko} মানে কী?` : `“${q.vocab.bn}” কোরিয়ান ভাষায় কী?`;
      const options = q.options.map((o, i) => `${OPTION_MARKS[i]}) ${o}`).join('  ');
      return {
        title: `কুইজ: ${question}`,
        hook: 'কুইজ: উত্তর দিতে পারবেন?',
        scenes: [scene('কুইজ: উত্তর দিতে পারবেন?', 'EPS-TOPIK প্রস্তুতি', 'চলুন একটি ছোট কুইজ খেলি।', 3), scene(question, options, `${question} উত্তর ভাবুন।`, 6), scene(`উত্তর: ${q.options[q.answer]}`, q.vocab.example.bn, `সঠিক উত্তর: ${q.options[q.answer]}। ${q.vocab.example.ko}`, 5)],
      };
    }
    default:
      return null;
  }
}

/** The whole spoken and shown copy of a script, for the independent checks. */
export const scriptCopy = (s: Pick<VideoScript, 'title' | 'hook' | 'scenes' | 'cta'>) => [s.title, s.hook, ...s.scenes.flatMap((x) => [x.onScreenText, x.subtitle, x.voiceover]), s.cta].filter(Boolean).join('\n');

/**
 * A curriculum video from one verified unit: every Korean string comes from the unit (checked
 * with the same verifier M23 uses for posts). Returns a reason instead when the unit's text does
 * not fit a scene without cutting it.
 */
export function curriculumScript(pack: CurriculumPack, unit: Unit, opts: { preset: VideoPreset; platform: string; cta?: string }): { script: VideoScript } | { reason: string } {
  if (!(CURRICULUM_VIDEO_KINDS as readonly string[]).includes(unit.kind)) return { reason: `unit kind ${unit.kind} is not used for videos` };
  const body = curriculumScenes(unit);
  if (!body) return { reason: `no video template for ${unit.kind}` };
  const cta = opts.cta && fits(opts.cta, 60) ? opts.cta : EPS_DEFAULT_CTA;
  const scenes = [...body.scenes, scene(cta, pack.title, cta, 3)];
  const tooLong = scenes.find((s) => s.onScreenText.length > 160 || s.subtitle.length > 200 || s.voiceover.length > 400);
  if (tooLong) return { reason: `unit ${unit.id} has text too long for a scene` };
  const parsed = VideoScriptSchema.safeParse({ title: body.title.slice(0, 140), hook: body.hook, language: pack.language, platform: opts.platform, preset: opts.preset, scenes, cta, suggestedMedia: [], curriculum: { pack: pack.id, version: packVersion(pack), unitId: unit.id } });
  if (!parsed.success) return { reason: `unit ${unit.id}: ${parsed.error.issues[0]?.message ?? 'invalid script'}` };
  const check = verifyCurriculumText(scriptCopy(parsed.data), { pack: pack.id, version: packVersion(pack), unitId: unit.id });
  if (!check.verified) return { reason: `curriculum check failed: ${check.problems.join('; ')}` };
  return { script: parsed.data };
}

/* ------------------------------------------------------------------ */
/* Approved-content templates (no model): verbatim approved wording     */
/* ------------------------------------------------------------------ */

/**
 * Template script for a general brand from human-approved material only: an approved Content
 * Studio item (its hook and key message) and approved claims quoted verbatim. Returns null when
 * there is not enough approved material for a truthful video.
 */
export function approvedContentScript(args: { brandName: string; language: string; topic: VideoTopic; claims: { id: string; text: string }[]; cta: string; preset: VideoPreset; platform: string }): VideoScript | null {
  const claims = args.claims.filter((c) => args.topic.claimIds.includes(c.id) && fits(c.text, 160)).slice(0, 3);
  const scenes: Scene[] = [];
  const hook = fits(args.topic.hook, 160) ? args.topic.hook : fits(args.topic.title, 160) ? args.topic.title : args.brandName.slice(0, 160);
  scenes.push(scene(hook, args.brandName.slice(0, 200), hook, 3));
  if (args.topic.source === 'content_item' && args.topic.angle && args.topic.angle !== hook) {
    scenes.push(fits(args.topic.angle, 160) ? scene(args.topic.angle, '', args.topic.angle.slice(0, 400), 5) : scene(args.topic.title.slice(0, 160), args.topic.angle.slice(0, 200), args.topic.angle.slice(0, 400), 6));
  }
  for (const c of claims) scenes.push(scene(c.text, '', c.text, 4));
  const contentScenes = scenes.length - 1;
  if (contentScenes < 1 || (args.topic.source === 'claim' && !claims.length)) return null;
  const cta = fits(args.cta, 60) ? args.cta : '';
  scenes.push(scene(cta || args.brandName.slice(0, 160), cta ? args.brandName.slice(0, 200) : '', cta || args.brandName, 3));
  const parsed = VideoScriptSchema.safeParse({ title: args.topic.title.slice(0, 140), hook, language: args.language, platform: args.platform, preset: args.preset, scenes, cta, claimIds: claims.map((c) => c.id) });
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------ */
/* AI script through the approved model gateway                         */
/* ------------------------------------------------------------------ */

const AiScriptOutputSchema = z.object({
  abstain: z.boolean(),
  abstainReason: z.string().max(500).nullable(),
  title: z.string().max(140),
  hook: z.string().max(160),
  scenes: z.array(z.object({ onScreenText: z.string().max(160), voiceover: z.string().max(400), subtitle: z.string().max(200), seconds: z.number().int().min(2).max(15), mediaHint: z.string().max(160) })).max(10),
  cta: z.string().max(60),
  suggestedMedia: z.array(z.string().max(160)).max(10),
  claimIds: z.array(z.string()).max(10),
  evidenceIds: z.array(z.string()).max(10),
});

export interface AiScriptInput {
  brand: { name: string; voice: unknown; audience: unknown };
  language: string;
  objective: string;
  audience: string;
  topic: VideoTopic;
  pillar: { key: string; name: string; description: string } | null;
  claims: { id: string; text: string }[];
  evidence: { id: string; summary: string; kind: string }[];
  recentTitles: string[];
  preset: VideoPreset;
  platform: string;
  cta: string;
}

/** Abstain reasons that mean "no model to ask" rather than "the model said no". */
const UNAVAILABLE = new Set(['MODEL_UNAVAILABLE', 'NO_APPROVED_MODEL', 'CIRCUIT_OPEN', 'KILL_SWITCH', 'UNAPPROVED_SERVING_MODEL']);

export type AiScriptOutcome = { ok: true; script: VideoScript; runId: string; model: string; costUsd: number | null } | { ok: false; unavailable: boolean; reason: string; runId: string | null; costUsd: number | null };

/**
 * One model call per script (registry approval, the tenant AI spending limit and kill switches
 * apply inside the gateway). The output is checked, never repaired: a cited ID that was not
 * provided, a recent title, a missing scene or an over-long video drops the script.
 */
export async function generateAiScript(deps: CoreDeps, tenantId: string, triggeredBy: string, input: AiScriptInput): Promise<AiScriptOutcome> {
  const request = {
    brand: input.brand,
    language: input.language,
    objective: input.objective,
    audience: input.audience,
    topic: { title: input.topic.title, angle: input.topic.angle, hook: input.topic.hook, source: input.topic.source },
    pillar: input.pillar,
    approvedClaims: input.claims,
    evidence: input.evidence,
    recentTitles: input.recentTitles.slice(0, 30),
    format: { preset: input.preset, aspect: input.preset === 'vertical_9x16' ? '9:16' : input.preset === 'square_1x1' ? '1:1' : '16:9', platform: input.platform, scenes: { min: 3, max: 8 }, secondsPerScene: { min: 2, max: 15 }, maxTotalSeconds: 60, onScreenTextMaxChars: 160, subtitleMaxChars: 200, ctaMaxChars: 60 },
    cta: input.cta,
  };
  let cost: number | null = null;
  const outcome = await runAgent(deps, tenantId, { kind: 'video_script', agentId: 'video-automation', triggeredBy, input: { topicKey: input.topic.key, preset: input.preset } }, async (ctx) => {
    const r = await ctx.think('script', PROMPTS.videoScript, { purpose: 'generation', messages: [{ role: 'user', content: JSON.stringify(request) }], outputSchema: AiScriptOutputSchema, maxTokens: 2500 });
    cost = r.costUsd ?? null;
    return { output: r.output, servedBy: r.servedBy };
  });
  if (outcome.status === 'abstained') return { ok: false, unavailable: UNAVAILABLE.has(outcome.reason), reason: `AI ${outcome.reason}`, runId: outcome.runId, costUsd: cost };
  if (outcome.status === 'failed') return { ok: false, unavailable: true, reason: `AI failed: ${outcome.error}`, runId: outcome.runId, costUsd: cost };
  const o = outcome.result.output;
  const fail = (reason: string): AiScriptOutcome => ({ ok: false, unavailable: false, reason, runId: outcome.runId, costUsd: cost });
  if (o.abstain) return fail(`the model abstained: ${o.abstainReason ?? 'not enough grounded material'}`);
  const claimIds = new Set(input.claims.map((c) => c.id));
  const evidenceIds = new Set(input.evidence.map((e) => e.id));
  if (o.claimIds.some((id) => !claimIds.has(id))) return fail('the script cites a claim that is not an approved brand claim');
  if (o.evidenceIds.some((id) => !evidenceIds.has(id))) return fail('the script cites evidence that was not provided');
  if (input.recentTitles.some((t) => t.trim().toLowerCase() === o.title.trim().toLowerCase())) return fail('the script repeats a recent title');
  if (o.scenes.length < 3) return fail('the script has fewer than three scenes');
  if (o.scenes.reduce((a, s) => a + s.seconds, 0) > 60) return fail('the script is longer than 60 seconds');
  const parsed = VideoScriptSchema.safeParse({ title: o.title, hook: o.hook, language: input.language, platform: input.platform, preset: input.preset, scenes: o.scenes, cta: o.cta, suggestedMedia: o.suggestedMedia.filter((m) => m.trim().length >= 2), claimIds: o.claimIds, evidenceIds: o.evidenceIds });
  if (!parsed.success) return fail(`the script is invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`);
  return { ok: true, script: parsed.data, runId: outcome.runId, model: outcome.result.servedBy, costUsd: cost };
}

/* ------------------------------------------------------------------ */
/* Storyboard builder                                                   */
/* ------------------------------------------------------------------ */

export interface StoryboardMedia {
  /** Owner-chosen library assets for this brand, used in order on the content scenes. */
  assetIds: string[];
  /** The brand's logo (brand profile) for the closing scene. */
  logoAssetId: string | null;
  /** Any of the chosen assets is AI-generated or synthetic: an on-screen disclosure is added. */
  aiGenerated: boolean;
}

/** A validated script → an ordinary Video Studio storyboard (same schema, limits and QA as a hand-made one). */
export function buildStoryboard(script: VideoScript, brand: { palette?: { accent: string; onAccent: string } | undefined }, media: StoryboardMedia): Storyboard {
  const brandColor = brand.palette?.accent ?? '#0f766e';
  const textColor = brand.palette?.onAccent ?? '#ffffff';
  const last = script.scenes.length - 1;
  let next = 0;
  const scenes = script.scenes.map((s, i) => {
    const assetId = i === last ? media.logoAssetId : i > 0 && media.assetIds.length ? (media.assetIds[next++ % media.assetIds.length] ?? null) : null;
    return {
      id: `s${i + 1}`,
      durationSeconds: s.seconds,
      text: s.onScreenText,
      subtitle: s.subtitle,
      assetId,
      transition: i === 0 ? ('cut' as const) : i % 2 ? ('fade' as const) : ('slide' as const),
      textPosition: assetId && i !== last ? ('bottom' as const) : ('center' as const),
      background: assetId ? null : brandColor,
    };
  });
  return StoryboardSchema.parse({
    preset: script.preset,
    brandColor,
    textColor,
    script: script.scenes
      .map((s) => s.voiceover)
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000),
    scenes,
    cta: script.cta,
    disclosureText: media.aiGenerated ? 'Made with AI' : '',
    audioAssetId: null,
    claimIds: script.claimIds,
  });
}

/** The Google Flow / generative prompt prepared from a script (a person runs it; nothing is submitted). */
export function generationPrompt(script: VideoScript, brandName: string): string {
  const aspect = script.preset === 'vertical_9x16' ? '9:16 vertical' : script.preset === 'square_1x1' ? '1:1 square' : '16:9 landscape';
  const seconds = script.scenes.reduce((a, s) => a + s.seconds, 0);
  const shots = script.scenes.map((s, i) => `${i + 1}. ${s.mediaHint || s.onScreenText}`).join(' ');
  return `A ${Math.min(seconds, 8)}-second ${aspect} clip for ${brandName}: ${script.hook}. Shots: ${shots}. No people's faces, no text overlays, no logos or brands other than ${brandName}.`.slice(0, 2000);
}
