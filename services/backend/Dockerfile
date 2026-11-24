# syntax=docker/dockerfile:1
#
# Backend image (arch §7.3). Build context: services/backend/ (its own .dockerignore).
#
#   docker build -t cbdc-backend:local services/backend                          # runtime (default)
#   docker build --target migrate -t cbdc-backend-migrate:local services/backend # prisma migrate deploy
#   docker build --target test --build-context contracts=contracts -t cbdc-backend-test:local services/backend   # typecheck + tests (run from the repo root)
#
# Node 20.20.2 matches the root .nvmrc and package.json engines (>=20.6.0 <21).
# Digest verified with `docker pull node:20.20.2-bookworm-slim` (multi-arch index).
#
# NODE_ENV is deliberately not set: config.ts refuses NODE_ENV=production
# (development-only auth, arch §8.1). Secrets are never baked in: DATABASE_URL and
# dev-tokens.json are supplied at run time (mount the token file at
# /app/dev-tokens.json, the default DEV_TOKENS_FILE).
ARG NODE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

# ---- base: Prisma's native engines need OpenSSL 3 (the slim image has no libssl) ----
FROM ${NODE_IMAGE} AS base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---- build: all dependencies, Prisma client generation (postinstall), tsc ----
FROM base AS build
# The schema must be present before `npm ci`: its postinstall runs `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- test: `docker build --target test` runs the typecheck and unit tests ----
FROM build AS test
COPY scripts ./scripts
COPY test ./test
COPY dev-tokens.example.json ./
# Some tests read ../../../../contracts/fixtures (outside this build context), so only
# this target takes the repository's contracts/ folder as a named context.
COPY --from=contracts fixtures /contracts/fixtures
RUN npm run typecheck && npm test

# ---- prod-deps: production dependencies only (prisma is one; postinstall regenerates the client) ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

# ---- migrate: `prisma migrate deploy` against DATABASE_URL, then exits ----
FROM base AS migrate
ENV CHECKPOINT_DISABLE=1
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]

# ---- runtime (default target): compiled app, production dependencies, non-root ----
FROM base AS runtime
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Owned by root, read-only to the runtime user. 0.0.0.0 inside the container only;
# Compose publishes the port on host loopback (config.ts BIND_HOST rules).
ENV BIND_HOST=0.0.0.0
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
