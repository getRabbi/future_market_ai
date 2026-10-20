# FUTUREGROW AI

Evidence-governed, bounded-autonomy growth platform: 24 modules covering evidence, customer data, knowledge, market and competitor intelligence, forecasting and causal measurement, experiments, offers, creative and media, organic social, paid media, SEO/ASO, app growth, lifecycle messaging, conversational support, creators/affiliates, and the execution gateway and governance control plane that bind them.

**Models propose; deterministic code decides and proves.** Every consequential write is an action request that passes evidence and policy checks, human approval where required, budget reservation and kill-switch checks, and is counted only after independent read-back verification (`VERIFIED` — there is no "success" state).

| Read next | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it fits together |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Northflank Sandbox + Cloudflare controlled beta |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating it: kill switches, incidents, backups, rotation |
| [TEST_REPORT.md](TEST_REPORT.md) | What is verified and how |
| [DECISIONS.md](DECISIONS.md) · [BLOCKERS.md](BLOCKERS.md) · [PROGRESS.md](PROGRESS.md) | Decision log, external blockers, milestone log |
| [docs/MODULES.md](docs/MODULES.md) · [POLICY_MATRIX](docs/POLICY_MATRIX.md) · [EVENT_TAXONOMY](docs/EVENT_TAXONOMY.md) · [CONNECTOR_CAPABILITIES](docs/CONNECTOR_CAPABILITIES.md) | Generated references (`npm run docs`) |

## Local development

Requirements: Node 24.22+, npm, Python 3.13 (for the analytics job). PostgreSQL is embedded — no local install needed.

```sh
npm ci
npm run dev:db                     # persistent PostgreSQL 17 on :54320, migrated; prints DATABASE_URL
python -m venv jobs/analytics/.venv
jobs/analytics/.venv/bin/pip install -r jobs/analytics/requirements-dev.txt   # Windows: .venv\Scripts\pip

export DATABASE_URL=postgres://postgres:futuregrow-dev@localhost:54320/futuregrow FG_ALLOW_SIGNUP=true
npm run dev:api                    # http://localhost:8080  (OpenAPI: /v1/openapi.json)
npm run dev:worker
PUBLIC_API_BASE=http://localhost:8080 npm run dev:web    # http://localhost:4321
```

Development uses fallback secrets and filesystem object storage; production refuses both (see `.env.example`). Without `ANTHROPIC_API_KEY` and an approved model, agent stages abstain rather than invent output.

## Checks

```sh
npm run typecheck && npm run lint && npm run docs -- --check
npm test                           # real PostgreSQL (embedded), fixture servers for provider APIs, real Remotion render
npm run test:py                    # Python numerical engines and backup module
node scripts/build.mjs all         # production bundles (dist/<service>)
npm run build -w @futuregrow/web   # static control plane + hashed CSP headers
npm run sbom                       # CycloneDX SBOM + licence policy (dist/sbom)
```

## Layout

`packages/*` shared libraries and the 24 modules (`packages/core/src/modules`), `apps/api` (Fastify), `apps/worker` (Graphile Worker), `apps/web` (Astro + React), `jobs/analytics` (Python), `jobs/media` (Remotion), `infra/` (Dockerfiles, Northflank, Cloudflare), `test/` (harness, red-team suite).
