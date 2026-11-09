import type React from 'react';
import { AbsoluteFill, Audio, type CalculateMetadataFunction, Composition, Img, interpolate, OffthreadVideo, registerRoot, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

export interface RenderProps {
  headline: string;
  captions: string[];
  cta: string;
  brandColor: string;
  disclosureText: string;
  /** Files placed in the bundle's public directory by the job runner. */
  media: { file: string; mime: string }[];
  [key: string]: unknown;
}

const defaults: RenderProps = { headline: '', captions: [], cta: '', brandColor: '#111111', disclosureText: '', media: [] };

/** Persistent disclosure banner (AI-generated / sponsored). Never fades out. */
const Disclosure: React.FC<{ text: string }> = ({ text }) =>
  text ? (
    <div
      style={{
        position: 'absolute',
        top: 48,
        left: 48,
        right: 48,
        padding: '18px 28px',
        borderRadius: 18,
        background: 'rgba(0,0,0,0.72)',
        color: '#fff',
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 34,
        fontWeight: 700,
        letterSpacing: 0.3,
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  ) : null;

const MediaLayer: React.FC<{ media: RenderProps['media'] }> = ({ media }) => {
  const { durationInFrames } = useVideoConfig();
  if (media.length === 0) return null;
  const per = Math.max(1, Math.floor(durationInFrames / media.length));
  return (
    <>
      {media.map((m, i) => (
        <Sequence key={m.file} from={i * per} durationInFrames={i === media.length - 1 ? durationInFrames - i * per : per}>
          <AbsoluteFill>{m.mime.startsWith('video/') ? <OffthreadVideo src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted /> : <Img src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}</AbsoluteFill>
        </Sequence>
      ))}
    </>
  );
};

const Captions: React.FC<{ captions: string[]; bottom?: number }> = ({ captions, bottom = 360 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  if (captions.length === 0) return null;
  const per = Math.max(1, Math.floor((durationInFrames * 0.85) / captions.length));
  const idx = Math.min(captions.length - 1, Math.floor(frame / per));
  const local = frame - idx * per;
  const opacity = interpolate(local, [0, 6, per - 6, per], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 64, right: 64, bottom, textAlign: 'center', opacity }}>
      <span style={{ background: 'rgba(255,255,255,0.92)', color: '#111', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 52, fontWeight: 700, lineHeight: 1.35, padding: '8px 18px', borderRadius: 12, boxDecorationBreak: 'clone' }}>{captions[idx]}</span>
    </div>
  );
};

const EndCard: React.FC<{ cta: string; color: string }> = ({ cta, color }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const start = Math.floor(durationInFrames * 0.85);
  if (frame < start || !cta) return null;
  const s = spring({ frame: frame - start, fps, config: { damping: 200 } });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', background: `${color}e6` }}>
      <div style={{ transform: `scale(${0.8 + 0.2 * s})`, color: '#fff', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 84, fontWeight: 800, textAlign: 'center', padding: 48 }}>{cta}</div>
    </AbsoluteFill>
  );
};

export const ProductShowcase: React.FC<RenderProps> = (p) => (
  <AbsoluteFill style={{ background: p.brandColor }}>
    <MediaLayer media={p.media} />
    {p.headline ? <div style={{ position: 'absolute', bottom: 520, left: 64, right: 64, color: '#fff', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 76, fontWeight: 800, textShadow: '0 4px 24px rgba(0,0,0,0.6)' }}>{p.headline}</div> : null}
    <Captions captions={p.captions} />
    <EndCard cta={p.cta} color={p.brandColor} />
    <Disclosure text={p.disclosureText} />
  </AbsoluteFill>
);

/** "UGC-style" is a format (vertical, captioned, handheld feel), not a claim of genuine customer testimony. */
export const UgcCaptioned: React.FC<RenderProps> = (p) => (
  <AbsoluteFill style={{ background: '#000' }}>
    <MediaLayer media={p.media} />
    <Captions captions={p.captions} bottom={420} />
    <EndCard cta={p.cta} color={p.brandColor} />
    <Disclosure text={p.disclosureText} />
  </AbsoluteFill>
);

export const PersonaStory: React.FC<RenderProps> = (p) => (
  <AbsoluteFill style={{ background: p.brandColor }}>
    <MediaLayer media={p.media} />
    <Captions captions={p.captions} bottom={420} />
    <EndCard cta={p.cta} color={p.brandColor} />
    <Disclosure text={p.disclosureText} />
  </AbsoluteFill>
);

/* ------------------------------------------------------------------ */
/* Scene story (P3-04 Video Studio): storyboard scenes in any preset   */
/* ------------------------------------------------------------------ */

interface StoryScene {
  id: string;
  durationSeconds: number;
  text: string;
  subtitle: string;
  mediaIndex: number | null;
  transition: 'cut' | 'fade' | 'slide';
  textPosition: 'top' | 'center' | 'bottom';
  background: string | null;
}
interface StoryProps extends RenderProps {
  storyboard: { preset: 'vertical_9x16' | 'square_1x1' | 'landscape_16x9'; brandColor: string; textColor: string; scenes: StoryScene[]; cta: string; disclosureText: string; audioIndex: number | null };
}

const PRESET_SIZE = { vertical_9x16: [1080, 1920], square_1x1: [1080, 1080], landscape_16x9: [1920, 1080] } as const;
const STORY_FPS = 30;

const storyDefaults: StoryProps = {
  ...defaults,
  storyboard: { preset: 'square_1x1', brandColor: '#0f766e', textColor: '#ffffff', scenes: [{ id: 's1', durationSeconds: 2, text: '', subtitle: '', mediaIndex: null, transition: 'cut', textPosition: 'center', background: null }], cta: '', disclosureText: '', audioIndex: null },
};

/** Size, fps and length come from the storyboard, so one composition serves every preset. */
const storyMetadata: CalculateMetadataFunction<StoryProps> = ({ props }) => {
  const [width, height] = PRESET_SIZE[props.storyboard.preset];
  const seconds = props.storyboard.scenes.reduce((a, s) => a + s.durationSeconds, 0);
  return { width, height, fps: STORY_FPS, durationInFrames: Math.max(1, Math.round(seconds * STORY_FPS)) };
};

const StoryScene: React.FC<{ scene: StoryScene; media: RenderProps['media']; frames: number; color: string; textColor: string; scale: number }> = ({ scene, media, frames, color, textColor, scale }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = scene.transition === 'fade' ? interpolate(frame, [0, 8, frames - 8, frames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;
  const slide = scene.transition === 'slide' ? interpolate(spring({ frame, fps, config: { damping: 200 } }), [0, 1], [100, 0]) : 0;
  const m = scene.mediaIndex === null ? null : media[scene.mediaIndex];
  const justify = scene.textPosition === 'top' ? 'flex-start' : scene.textPosition === 'bottom' ? 'flex-end' : 'center';
  return (
    <AbsoluteFill style={{ background: scene.background ?? color, opacity: fade, transform: `translateX(${slide}%)` }}>
      {m ? <AbsoluteFill>{m.mime.startsWith('video/') ? <OffthreadVideo src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted /> : <Img src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}</AbsoluteFill> : null}
      {scene.text ? (
        <AbsoluteFill style={{ justifyContent: justify, alignItems: 'center', padding: 80 * scale }}>
          <div style={{ color: textColor, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 84 * scale, fontWeight: 800, textAlign: 'center', lineHeight: 1.15, textShadow: m ? '0 4px 24px rgba(0,0,0,0.65)' : 'none' }}>{scene.text}</div>
        </AbsoluteFill>
      ) : null}
      {scene.subtitle ? (
        <div style={{ position: 'absolute', left: 60 * scale, right: 60 * scale, bottom: 120 * scale, textAlign: 'center' }}>
          <span style={{ background: 'rgba(0,0,0,0.72)', color: '#fff', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 44 * scale, fontWeight: 600, lineHeight: 1.4, padding: `${8 * scale}px ${16 * scale}px`, borderRadius: 10, boxDecorationBreak: 'clone' }}>{scene.subtitle}</span>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export const SceneStory: React.FC<StoryProps> = (p) => {
  const { width, height } = useVideoConfig();
  const scale = Math.min(width, height) / 1080;
  const sb = p.storyboard;
  let from = 0;
  const audio = sb.audioIndex === null ? null : p.media[sb.audioIndex];
  return (
    <AbsoluteFill style={{ background: sb.brandColor }}>
      {sb.scenes.map((sc) => {
        const frames = Math.max(1, Math.round(sc.durationSeconds * STORY_FPS));
        const at = from;
        from += frames;
        return (
          <Sequence key={sc.id} from={at} durationInFrames={frames}>
            <StoryScene scene={sc} media={p.media} frames={frames} color={sb.brandColor} textColor={sb.textColor} scale={scale} />
          </Sequence>
        );
      })}
      {audio ? <Audio src={staticFile(audio.file)} /> : null}
      <EndCard cta={sb.cta} color={sb.brandColor} />
      <Disclosure text={sb.disclosureText} />
    </AbsoluteFill>
  );
};

const Root: React.FC = () => (
  <>
    <Composition id="product-showcase" component={ProductShowcase} width={1080} height={1920} fps={30} durationInFrames={450} defaultProps={defaults} />
    <Composition id="ugc-captioned" component={UgcCaptioned} width={1080} height={1920} fps={30} durationInFrames={600} defaultProps={defaults} />
    <Composition id="persona-story" component={PersonaStory} width={1080} height={1920} fps={30} durationInFrames={600} defaultProps={defaults} />
    <Composition id="scene-story" component={SceneStory} width={1080} height={1080} fps={STORY_FPS} durationInFrames={60} defaultProps={storyDefaults} calculateMetadata={storyMetadata} />
  </>
);

registerRoot(Root);
