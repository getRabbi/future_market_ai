# syntax=docker/dockerfile:1
# Remotion media job (M14, D-016): renders queued jobs within a time budget, then exits.
ARG NODE_IMAGE=node:24.22.0-bookworm-slim@sha256:ec857ea6bb60cb3d0fa4d97495590c5fe7d51be8572c307b55957eeb06569cf7

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node scripts/build.mjs media \
 && node jobs/media/scripts/prebundle.mjs /src/dist/media/remotion-bundle

FROM ${NODE_IMAGE}
# Shared libraries for Chrome Headless Shell (Remotion Linux dependency list) and fonts used by
# the compositions (Arial falls back to Liberation Sans; emoji in captions).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libnss3 libdbus-1-3 libatk1.0-0 libgbm1 libasound2 libxrandr2 libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    FG_REMOTION_BUNDLE_DIR=/app/remotion-bundle \
    RENDER_CONCURRENCY=1
WORKDIR /app
COPY --from=build /src/dist/media/ ./
# Download the pinned Chrome Headless Shell into the image so renders never fetch at runtime.
RUN node -e "import('@remotion/renderer').then((r) => r.ensureBrowser()).then(() => console.log('browser ready'))" \
 && chown -R node:node /app
USER node
CMD ["node", "--enable-source-maps", "main.mjs"]
