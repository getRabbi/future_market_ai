import fs from 'node:fs';
import { createRequire } from 'node:module';

type ResvgModule = typeof import('@resvg/resvg-wasm');

let ready: Promise<ResvgModule> | null = null;

/** resvg (WASM) rasterizes the card SVG; it is initialized once per process. */
function resvg(): Promise<ResvgModule> {
  if (!ready) {
    ready = (async () => {
      const mod = await import('@resvg/resvg-wasm');
      const wasm = fs.readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await mod.initWasm(wasm);
      return mod;
    })();
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

export interface Raster {
  png: Uint8Array;
  width: number;
  height: number;
}

/** The card's text is already glyph outlines, so no font is loaded here. */
export async function rasterize(svg: string, width: number): Promise<Raster> {
  const { Resvg } = await resvg();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false }, shapeRendering: 2, imageRendering: 0 });
  try {
    const img = r.render();
    try {
      return { png: img.asPng(), width: img.width, height: img.height };
    } finally {
      img.free();
    }
  } finally {
    r.free();
  }
}

/**
 * 64-bit difference hash of the composition (grey 9×8 thumbnail, each bit = left brighter than
 * right). Two cards within a Hamming distance of ~8 look alike at feed size.
 */
export async function differenceHash(svg: string): Promise<string> {
  const { Resvg } = await resvg();
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: 72 }, font: { loadSystemFonts: false } });
  const img = r.render();
  try {
    const { width: w, height: h } = img;
    const px = img.pixels;
    const grey = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
    };
    // Area-average into a 9×8 grid.
    const cell = (cx: number, cy: number) => {
      const x0 = Math.floor((cx * w) / 9);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 9));
      const y0 = Math.floor((cy * h) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 8));
      let s = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += grey(x, y);
      return s / ((x1 - x0) * (y1 - y0));
    };
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) bits = (bits << 1n) | (cell(x, y) > cell(x + 1, y) ? 1n : 0n);
    }
    return bits.toString(16).padStart(16, '0');
  } finally {
    img.free();
    r.free();
  }
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
