import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deterministic typesetting for social cards (D-040). Korean and Bangla text is shaped with
 * HarfBuzz (the shaping engine browsers use, so Bangla conjuncts and vowel signs come out right)
 * and drawn as glyph outlines. No text is ever left for an image model or a renderer's font
 * fallback to spell, and every line is measured exactly, so overflow is a checkable fact.
 */

type Hb = typeof import('harfbuzzjs');
type HbFont = InstanceType<Hb['Font']>;

export type Family = 'kr' | 'bn';
export interface FontSource {
  family: Family;
  file: string;
  license: string;
}

/** Bundled fonts: both SIL Open Font License 1.1 (commercial use, embedding and rendering allowed). */
export const FONT_SOURCES: readonly FontSource[] = [
  { family: 'kr', file: 'NotoSansKR[wght].ttf', license: 'SIL OFL 1.1 (OFL-NotoSansKR.txt)' },
  { family: 'bn', file: 'NotoSansBengali[wdth,wght].ttf', license: 'SIL OFL 1.1 (OFL-NotoSansBengali.txt)' },
];

/** Bundled next to the bundle in production (scripts/build.mjs copies them), beside src/ in development. */
export function fontsDir(): string {
  const candidates = [process.env.FG_FONTS_DIR, fileURLToPath(new URL('./fonts/', import.meta.url)), fileURLToPath(new URL('../fonts/', import.meta.url))].filter((d): d is string => Boolean(d));
  const dir = candidates.find((d) => fs.existsSync(path.join(d, FONT_SOURCES[0]!.file)));
  if (!dir) throw new Error(`card fonts not found (looked in ${candidates.join(', ')})`);
  return dir;
}

const BENGALI = (cp: number) => (cp >= 0x0980 && cp <= 0x09ff) || cp === 0x0964 || cp === 0x0965;
const JOINER = (cp: number) => cp === 0x200c || cp === 0x200d;

export interface ShapedGlyph {
  family: Family;
  gid: number;
  /** Pen position in px from the run start. */
  x: number;
  dx: number;
  dy: number;
}

export interface ShapedRun {
  width: number;
  glyphs: ShapedGlyph[];
  /** Characters no bundled font can draw (would render as empty boxes). */
  missing: string[];
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TextStyle {
  size: number;
  weight: number;
}

export interface Line {
  text: string;
  width: number;
  glyphs: ShapedGlyph[];
}

export interface TextLayout {
  lines: Line[];
  /** Widest line in px. */
  width: number;
  lineHeight: number;
  height: number;
  missing: string[];
  /** A single word is wider than the box, so it cannot wrap. */
  wordTooWide: boolean;
}

export class Typesetter {
  private readonly fonts = new Map<string, HbFont>();
  private readonly glyphPaths = new Map<string, { type: string; values: number[] }[]>();

  private constructor(
    private readonly hb: Hb,
    private readonly faces: Record<Family, InstanceType<Hb['Face']>>,
    private readonly coverage: Record<Family, Set<number>>,
    readonly upem: Record<Family, number>,
  ) {}

  static async load(dir = fontsDir()): Promise<Typesetter> {
    const hb = await import('harfbuzzjs');
    const faces = {} as Record<Family, InstanceType<Hb['Face']>>;
    const coverage = {} as Record<Family, Set<number>>;
    const upem = {} as Record<Family, number>;
    for (const src of FONT_SOURCES) {
      const face = new hb.Face(new hb.Blob(fs.readFileSync(path.join(dir, src.file))));
      faces[src.family] = face;
      coverage[src.family] = new Set(face.collectUnicodes());
      upem[src.family] = face.upem;
    }
    return new Typesetter(hb, faces, coverage, upem);
  }

  private font(family: Family, weight: number): HbFont {
    const key = `${family}:${weight}`;
    let f = this.fonts.get(key);
    if (!f) {
      f = new this.hb.Font(this.faces[family]);
      f.setVariations([new this.hb.Variation('wght', weight)]);
      this.fonts.set(key, f);
    }
    return f;
  }

  /** Splits text into runs per font: Bangla in Noto Sans Bengali, everything else in Noto Sans KR. */
  private itemize(text: string): { family: Family | null; text: string }[] {
    const runs: { family: Family | null; text: string }[] = [];
    let prev: Family | null = null;
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      let fam: Family | null = JOINER(cp) && prev ? prev : BENGALI(cp) ? 'bn' : 'kr';
      if (fam && !this.coverage[fam].has(cp) && !JOINER(cp)) fam = fam === 'kr' && this.coverage.bn.has(cp) ? 'bn' : fam === 'bn' && this.coverage.kr.has(cp) ? 'kr' : null;
      const last = runs[runs.length - 1];
      if (last && last.family === fam) last.text += ch;
      else runs.push({ family: fam, text: ch });
      prev = fam;
    }
    return runs;
  }

  shape(text: string, style: TextStyle): ShapedRun {
    const glyphs: ShapedGlyph[] = [];
    const missing: string[] = [];
    let pen = 0;
    for (const run of this.itemize(text.normalize('NFC'))) {
      if (!run.family) {
        missing.push(...run.text);
        continue;
      }
      const font = this.font(run.family, style.weight);
      const scale = style.size / this.upem[run.family];
      const buf = new this.hb.Buffer();
      buf.addText(run.text);
      buf.guessSegmentProperties();
      this.hb.shape(font, buf);
      for (const g of buf.getGlyphInfosAndPositions()) {
        if (g.codepoint === 0) missing.push(run.text.slice(g.cluster, g.cluster + 1));
        glyphs.push({ family: run.family, gid: g.codepoint, x: pen, dx: (g.xOffset ?? 0) * scale, dy: (g.yOffset ?? 0) * scale });
        pen += (g.xAdvance ?? 0) * scale;
      }
    }
    return { width: pen, glyphs, missing };
  }

  /**
   * Greedy word wrap at spaces (Korean and Bangla both separate words with spaces; Korean words are
   * never split mid-word, like CSS word-break: keep-all). Explicit newlines start a new line.
   */
  layout(text: string, style: TextStyle & { maxWidth: number; lineHeight?: number }): TextLayout {
    const lineHeight = style.size * (style.lineHeight ?? 1.32);
    const space = this.shape(' ', style).width;
    const lines: Line[] = [];
    const missing: string[] = [];
    let wordTooWide = false;
    for (const para of text.split('\n')) {
      const words = para.split(/ +/).filter(Boolean);
      let cur: { words: string[]; width: number; runs: ShapedRun[] } = { words: [], width: 0, runs: [] };
      const flush = () => {
        const glyphs: ShapedGlyph[] = [];
        let x = 0;
        cur.runs.forEach((r, i) => {
          if (i > 0) x += space;
          for (const g of r.glyphs) glyphs.push({ ...g, x: g.x + x });
          x += r.width;
        });
        lines.push({ text: cur.words.join(' '), width: cur.width, glyphs });
        cur = { words: [], width: 0, runs: [] };
      };
      if (!words.length) {
        lines.push({ text: '', width: 0, glyphs: [] });
        continue;
      }
      for (const w of words) {
        const r = this.shape(w, style);
        missing.push(...r.missing);
        if (r.width > style.maxWidth) wordTooWide = true;
        const next = cur.words.length ? cur.width + space + r.width : r.width;
        if (cur.words.length && next > style.maxWidth) flush();
        cur.words.push(w);
        cur.runs.push(r);
        cur.width = cur.words.length === 1 ? r.width : cur.width + space + r.width;
      }
      flush();
    }
    const width = Math.max(0, ...lines.map((l) => l.width));
    return { lines, width, lineHeight, height: lines.length * lineHeight, missing: [...new Set(missing)], wordTooWide };
  }

  /** Ink bounds in px of a line drawn with its baseline at (x, y): what QA checks for clipping and overlap. */
  inkBox(glyphs: ShapedGlyph[], x: number, y: number, style: TextStyle): Box | null {
    let box: Box | null = null;
    for (const g of glyphs) {
      const e = this.font(g.family, style.weight).glyphExtents(g.gid);
      if (!e || (e.width === 0 && e.height === 0)) continue;
      const s = style.size / this.upem[g.family];
      const x0 = x + g.x + g.dx + e.xBearing * s;
      const top = y - g.dy - e.yBearing * s;
      const b: Box = { x0, y0: top, x1: x0 + e.width * s, y1: top - e.height * s };
      box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
    }
    return box;
  }

  /** One SVG path for a line, baseline at (x, y), in px. */
  linePath(glyphs: ShapedGlyph[], x: number, y: number, style: TextStyle): string {
    const out: string[] = [];
    const r = (v: number) => Math.round(v * 10) / 10;
    for (const g of glyphs) {
      const key = `${g.family}:${style.weight}:${g.gid}`;
      let cmds = this.glyphPaths.get(key);
      if (!cmds) {
        cmds = this.font(g.family, style.weight).glyphToJson(g.gid) as { type: string; values: number[] }[];
        this.glyphPaths.set(key, cmds);
      }
      const s = style.size / this.upem[g.family];
      const ox = x + g.x + g.dx;
      const oy = y - g.dy;
      for (const c of cmds) {
        const v = c.values;
        const pts: number[] = [];
        for (let i = 0; i < v.length; i += 2) pts.push(r(ox + v[i]! * s), r(oy - v[i + 1]! * s));
        out.push(`${c.type}${pts.join(' ')}`);
      }
    }
    return out.join('');
  }
}
