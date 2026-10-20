#!/usr/bin/env node
import fs from 'node:fs';
/**
 * Production bundles (D-014). Usage: node scripts/build.mjs [api|worker|media|all]
 *
 * First-party code (the @futuregrow/* workspace packages, TypeScript source) is bundled with
 * esbuild into dist/<service>/*.mjs. Third-party packages that read files from their own package
 * directory or ship native binaries stay external; they are copied together with their complete
 * dependency closure from the lockfile-installed node_modules into dist/<service>/node_modules,
 * so the runtime image contains exactly the pinned versions and nothing else. Run inside the
 * target platform (the Dockerfiles do this in a Linux builder stage) so platform-specific
 * optional dependencies resolve correctly.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));

const COMMON_EXTERNAL = ['graphile-worker', 'pg-native'];
const SERVICES = {
  api: { entries: { main: 'apps/api/src/main.ts', migrate: 'packages/db/src/cli/migrate.ts', probe: 'packages/db/src/cli/probe.ts' }, external: COMMON_EXTERNAL, migrations: true },
  worker: { entries: { main: 'apps/worker/src/main.ts' }, external: COMMON_EXTERNAL, migrations: false },
  media: { entries: { main: 'jobs/media/src/main.ts' }, external: [...COMMON_EXTERNAL, 'remotion', '@remotion/renderer', '@remotion/bundler', 'react', 'react-dom'], migrations: false },
};

function pkgDir(name, fromDir) {
  try {
    const r = createRequire(path.join(fromDir, 'noop.js'));
    return path.dirname(r.resolve(`${name}/package.json`));
  } catch {
    // Packages whose exports hide package.json: walk node_modules manually.
    for (let d = fromDir; ; d = path.dirname(d)) {
      const candidate = path.join(d, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.dirname(d) === d) return null;
    }
  }
}

/** Copy `name` and everything it depends on (installed optional/peer deps included). */
function copyClosure(names, outModules) {
  const seen = new Map();
  const visit = (name, fromDir, optional) => {
    const dir = pkgDir(name, fromDir);
    if (!dir) {
      if (optional) return;
      throw new Error(`cannot resolve ${name} from ${fromDir}`);
    }
    if (seen.has(dir)) return;
    seen.set(dir, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys(pkg.dependencies ?? {})) visit(d, dir, false);
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) visit(d, dir, true);
    for (const d of Object.keys(pkg.peerDependencies ?? {})) visit(d, dir, true);
  };
  for (const n of names) visit(n, root, false);
  let count = 0;
  for (const [dir] of seen) {
    // Preserve the node_modules-relative layout (hoisted and nested installs alike).
    const rel = path.relative(path.join(root, 'node_modules'), dir);
    if (rel.startsWith('..')) throw new Error(`${dir} is outside the root node_modules`);
    const dest = path.join(outModules, rel);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(dir, dest, { recursive: true, dereference: true, filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}.cache`) });
    count++;
  }
  return count;
}

async function buildService(name) {
  const svc = SERVICES[name];
  const out = path.join(root, 'dist', name);
  fs.rmSync(out, { recursive: true, force: true });
  const result = await build({
    entryPoints: Object.fromEntries(Object.entries(svc.entries).map(([k, v]) => [k, path.join(root, v)])),
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    legalComments: 'linked',
    metafile: true,
    external: svc.external,
    // CommonJS dependencies that call require() need it inside an ESM bundle.
    banner: { js: "import { createRequire as __fgCreateRequire } from 'node:module'; const require = __fgCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  const copied = copyClosure(
    svc.external.filter((e) => pkgDir(e, root)),
    path.join(out, 'node_modules'),
  );
  if (svc.migrations) fs.cpSync(path.join(root, 'packages/db/drizzle'), path.join(out, 'drizzle'), { recursive: true });
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: `futuregrow-${name}`, private: true, type: 'module' }, null, 2));
  const bytes = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(result.metafile));
  console.log(JSON.stringify({ service: name, entries: Object.keys(svc.entries), bundleBytes: bytes, externalPackagesCopied: copied }));
}

const arg = process.argv[2] ?? 'all';
const targets = arg === 'all' ? Object.keys(SERVICES) : [arg];
for (const t of targets) {
  if (!SERVICES[t]) {
    console.error(`unknown service ${t}; expected one of ${Object.keys(SERVICES).join(', ')}, all`);
    process.exit(2);
  }
  await buildService(t);
}
void require;
