#!/usr/bin/env node
/**
 * Software bill of materials (product plan P0: "every production dependency has pinned version/
 * hash and approved rights"). Writes dist/sbom/futuregrow.cdx.json (CycloneDX 1.5) combining:
 *   - npm production dependencies (`npm sbom`, lockfile versions + SHA-512 integrity + licences),
 *   - pinned Python requirements of the analytics job (licences from the job venv when present),
 *   - container base images pinned by digest in infra/docker/*.Dockerfile.
 * Then applies the licence policy: strong-copyleft, source-available or unknown licences in
 * production dependencies fail the run unless covered by a reviewed exception.
 * Models and media artifacts are inventoried at runtime in the model/artifact registries (M24).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist', 'sbom');

/**
 * Reviewed exceptions. Remotion packages are source-available under the Remotion License (several
 * publish no SPDX field): free tier attested per tenant, company licence otherwise (B-014).
 */
function exceptionReason(name) {
  if (name === 'remotion' || name.startsWith('@remotion/')) return 'Remotion License (B-014)';
  return null;
}

/** Weak copyleft is allowed for unmodified, dynamically used libraries but listed for legal review. */
const WEAK_COPYLEFT = /\b(LGPL|MPL|EPL|CDDL)/i;

const DENY = /\b(A?GPL|SSPL|BUSL|Commons-Clause|CC-BY-NC|Elastic)/i;

function npmComponents() {
  const raw = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: process.platform === 'win32' });
  return JSON.parse(raw);
}

/**
 * Our own workspace packages. `npm sbom` names them `@futuregrow/api` on some platforms and by folder
 * (`api`) on others (Linux CI), so match name or folder together with the version: a bare name alone
 * would also hide unrelated registry packages such as `events`.
 */
function workspaceKeys() {
  const keys = new Set();
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  keys.add(`${rootPkg.name}@${rootPkg.version}`);
  for (const pattern of rootPkg.workspaces ?? []) {
    const dirs = pattern.endsWith('/*')
      ? fs
          .readdirSync(path.join(root, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => path.join(pattern.slice(0, -2), d.name))
      : [pattern];
    for (const dir of dirs) {
      const file = path.join(root, dir, 'package.json');
      if (!fs.existsSync(file)) continue;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      keys.add(`${pkg.name}@${pkg.version}`);
      keys.add(`${path.basename(dir)}@${pkg.version}`);
    }
  }
  return keys;
}

function isWorkspace(c, keys) {
  if (c.name.startsWith('@futuregrow/')) return true;
  const isPrivate = (c.properties ?? []).some((p) => p.name === 'cdx:npm:package:private' && p.value === 'true');
  return keys.has(`${c.name}@${c.version}`) && (isPrivate || !(c.hashes ?? []).length);
}

function licenseOf(c) {
  const l = (c.licenses ?? []).map((x) => x.license?.id ?? x.license?.name ?? x.expression).filter(Boolean);
  return l.length ? l.join(' OR ') : null;
}

function pythonComponents() {
  const req = fs.readFileSync(path.join(root, 'jobs/analytics/requirements.txt'), 'utf8');
  const site = ['jobs/analytics/.venv/Lib/site-packages', ...(fs.existsSync(path.join(root, 'jobs/analytics/.venv/lib')) ? fs.readdirSync(path.join(root, 'jobs/analytics/.venv/lib')).map((d) => `jobs/analytics/.venv/lib/${d}/site-packages`) : [])].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
  const out = [];
  for (const line of req.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z0-9_.-]+)(\[[^\]]+\])?==([^\s;#]+)/);
    if (!m) continue;
    const [, name, , version] = m;
    let license = null;
    if (site) {
      const dist = fs.readdirSync(site).find((d) => d.toLowerCase() === `${name.toLowerCase().replace(/-/g, '_')}-${version}.dist-info`);
      if (dist) {
        const meta = fs.readFileSync(path.join(site, dist, 'METADATA'), 'utf8');
        license = meta.match(/^License-Expression:\s*(.+)$/m)?.[1]?.trim() ?? meta.match(/^License:\s*(.+)$/m)?.[1]?.trim() ?? meta.match(/^Classifier: License :: OSI Approved :: (.+)$/m)?.[1]?.trim() ?? null;
      }
    }
    out.push({ type: 'library', name, version, purl: `pkg:pypi/${name.toLowerCase()}@${version}`, scope: 'required', licenses: license ? [{ license: { name: license } }] : [], properties: [{ name: 'futuregrow:component', value: 'analytics-job' }] });
  }
  return out;
}

function imageComponents() {
  const dir = path.join(root, 'infra/docker');
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.Dockerfile'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/(?:FROM|NODE_IMAGE=)\s*([a-z0-9./-]+):([A-Za-z0-9._-]+)@sha256:([a-f0-9]{64})/g)) {
      const [, image, tag, digest] = m;
      out.push({
        type: 'container',
        name: image,
        version: tag,
        hashes: [{ alg: 'SHA-256', content: digest }],
        purl: `pkg:docker/library/${image}@sha256%3A${digest}?tag=${tag}`,
        properties: [
          { name: 'futuregrow:dockerfile', value: `infra/docker/${f}` },
          { name: 'futuregrow:platform', value: 'linux/amd64' },
        ],
      });
    }
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.purl) ? false : seen.add(c.purl)));
}

const bom = npmComponents();
const wsKeys = workspaceKeys();
const npm = bom.components.filter((c) => !isWorkspace(c, wsKeys));
const py = pythonComponents();
const images = imageComponents();
bom.components = [...npm, ...py, ...images];
bom.metadata = {
  ...(bom.metadata ?? {}),
  properties: [...(bom.metadata?.properties ?? []), { name: 'futuregrow:models', value: 'runtime inventory: GET /v1/governance/models (model registry, licence/terms per model)' }, { name: 'futuregrow:artifacts', value: 'runtime inventory: GET /v1/governance/artifacts (fonts, media, weights, voices)' }],
};

const problems = [];
const weak = [];
const byLicense = {};
for (const c of [...npm, ...py]) {
  const lic = licenseOf(c) ?? 'UNKNOWN';
  byLicense[lic] = (byLicense[lic] ?? 0) + 1;
  if (exceptionReason(c.name)) continue;
  if (WEAK_COPYLEFT.test(lic)) weak.push(`${c.name}@${c.version}: ${lic}`);
  if (lic === 'UNKNOWN' || DENY.test(lic)) problems.push(`${c.name}@${c.version}: ${lic}`);
}
const missingHash = npm.filter((c) => !(c.hashes ?? []).length).map((c) => `${c.name}@${c.version}`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'futuregrow.cdx.json'), JSON.stringify(bom, null, 2));
const summary = {
  components: { npm: npm.length, python: py.length, containerImages: images.length },
  licenses: Object.fromEntries(Object.entries(byLicense).sort((a, b) => b[1] - a[1])),
  exceptions: npm.filter((c) => exceptionReason(c.name)).map((c) => `${c.name}@${c.version}: ${exceptionReason(c.name)}`),
  weakCopyleftForLegalReview: weak,
  withoutIntegrityHash: missingHash,
  policyViolations: problems,
};
fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (problems.length) {
  console.error(`licence policy: ${problems.length} production component(s) need review`);
  process.exit(1);
}
