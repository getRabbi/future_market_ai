/** Studio image formats (D-044): the sizes every creative media source must deliver. */
export const MEDIA_FORMATS = {
  portrait_4x5: { width: 1080, height: 1350 },
  square_1x1: { width: 1080, height: 1080 },
  landscape_191x1: { width: 1200, height: 628 },
  story_9x16: { width: 1080, height: 1920 },
} as const;
export type MediaFormat = keyof typeof MEDIA_FORMATS;
