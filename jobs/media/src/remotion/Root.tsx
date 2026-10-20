import type React from 'react';
import { AbsoluteFill, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

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
          <AbsoluteFill>
            {m.mime.startsWith('video/') ? (
              <OffthreadVideo src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} muted />
            ) : (
              <Img src={staticFile(m.file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            )}
          </AbsoluteFill>
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
      <span style={{ background: 'rgba(255,255,255,0.92)', color: '#111', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 52, fontWeight: 700, lineHeight: 1.35, padding: '8px 18px', borderRadius: 12, boxDecorationBreak: 'clone' }}>
        {captions[idx]}
      </span>
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
    {p.headline ? (
      <div style={{ position: 'absolute', bottom: 520, left: 64, right: 64, color: '#fff', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 76, fontWeight: 800, textShadow: '0 4px 24px rgba(0,0,0,0.6)' }}>{p.headline}</div>
    ) : null}
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

const Root: React.FC = () => (
  <>
    <Composition id="product-showcase" component={ProductShowcase} width={1080} height={1920} fps={30} durationInFrames={450} defaultProps={defaults} />
    <Composition id="ugc-captioned" component={UgcCaptioned} width={1080} height={1920} fps={30} durationInFrames={600} defaultProps={defaults} />
    <Composition id="persona-story" component={PersonaStory} width={1080} height={1920} fps={30} durationInFrames={600} defaultProps={defaults} />
  </>
);

registerRoot(Root);
