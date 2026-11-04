import { describe, expect, it } from 'vitest';
import { clipText, wellFormed, wellFormedJson } from '../src/util.js';

const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('surrogate-safe text clipping', () => {
  it('never leaves half an emoji at the cut, so the text stays valid inside jsonb', () => {
    // Bangla caption with an emoji whose two UTF-16 units straddle the 120-unit cut.
    const caption = `${'ক'.repeat(119)}💬 আপনার উত্তর`;
    expect(caption.slice(0, 120)).not.toSatisfy(isWellFormed);
    const clipped = clipText(caption, 120);
    expect(clipped).toSatisfy(isWellFormed);
    expect(clipped).toBe('ক'.repeat(119));
    expect(() => JSON.parse(JSON.stringify({ clipped }))).not.toThrow();
  });

  it('keeps short text, Hangul and complete emoji unchanged', () => {
    expect(clipText('안전모 🪖', 50)).toBe('안전모 🪖');
    expect(clipText('ab💬', 4)).toBe('ab💬');
    expect(clipText('abc', 2)).toBe('ab');
  });

  it('replaces lone surrogates deep inside a JSON value', () => {
    const broken = `x${'\uD83D'}`;
    expect(wellFormed(broken)).toBe('x�');
    const v = wellFormedJson({ a: [broken, 1, null], b: { c: broken }, d: true });
    expect(v).toEqual({ a: ['x�', 1, null], b: { c: 'x�' }, d: true });
    expect(JSON.stringify(v)).not.toMatch(/\\ud83d/i);
  });
});
