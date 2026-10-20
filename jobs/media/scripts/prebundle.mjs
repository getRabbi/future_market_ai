/**
 * Build the Remotion site once at image-build time (FG_REMOTION_BUNDLE_DIR), so the media job
 * never runs webpack in production. Usage: node jobs/media/scripts/prebundle.mjs <outDir>
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: prebundle.mjs <outDir>');
  process.exit(2);
}
const entryPoint = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/remotion/Root.tsx');
const serveUrl = await bundle({ entryPoint, outDir: path.resolve(outDir), publicDir: null });
console.log(JSON.stringify({ serveUrl }));
