/** Studio image formats (D-044): the sizes every creative media source must deliver. */
export const MEDIA_FORMATS = {
  portrait_4x5: { width: 1080, height: 1350 },
  square_1x1: { width: 1080, height: 1080 },
  landscape_191x1: { width: 1200, height: 628 },
  story_9x16: { width: 1080, height: 1920 },
} as const;
export type MediaFormat = keyof typeof MEDIA_FORMATS;

/** Video Studio output presets (P3-04); shared by the Remotion renderer and the video router. */
export const VIDEO_PRESETS = {
  vertical_9x16: { width: 1080, height: 1920, label: 'Vertical 9:16 (TikTok, Reels, Shorts)' },
  square_1x1: { width: 1080, height: 1080, label: 'Square 1:1 (feeds)' },
  landscape_16x9: { width: 1920, height: 1080, label: 'Landscape 16:9 (YouTube)' },
} as const;
export type VideoPreset = keyof typeof VIDEO_PRESETS;
