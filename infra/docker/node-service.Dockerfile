# syntax=docker/dockerfile:1
# API, worker and migration images (D-014). Build with --build-arg SERVICE=api|worker.
# Base images are pinned by tag and linux/amd64 digest (Northflank builds amd64).
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7

FROM ${NODE_IMAGE} AS build
ARG SERVICE=api
WORKDIR /src
COPY . .
# Lockfile-exact install; no third-party install scripts run (esbuild ships its binary as an
# optional platform package).
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node scripts/build.mjs "${SERVICE}"

FROM ${NODE_IMAGE}
ARG SERVICE=api
ENV NODE_ENV=production \
    FG_SERVICE=${SERVICE} \
    FG_MIGRATIONS_FOLDER=/app/drizzle \
    HOST=0.0.0.0 \
    PORT=8080
WORKDIR /app
COPY --from=build --chown=root:root /src/dist/${SERVICE}/ ./
USER node
EXPOSE 8080
# API: liveness on /healthz. The worker has no HTTP port; Northflank uses process health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD test "$FG_SERVICE" != "api" || node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "main.mjs"]
