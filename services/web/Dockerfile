# syntax=docker/dockerfile:1
#
# Web image (arch §7.3): the production bundle served by nginx, which also proxies /api/
# to the backend, so the browser stays same-origin (arch §2, D9). Build context:
# services/web/ (its own .dockerignore).
#
#   docker build -t cbdc-web:local services/web                   # runtime (default)
#   docker build --target test --build-context contracts=contracts --build-context docs=docs -t cbdc-web-test:local services/web   # lint + tests (from the repo root)
#
# Run-time settings (no rebuild): BACKEND_HOST (default backend) and BACKEND_PORT (default 4000).
# Nothing secret is built in: VITE_* values are public. The data mode is the app default (live).
ARG NODE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG NGINX_IMAGE=nginx:1.28.0-bookworm@sha256:552e7481ca93ffccd046aa658dbbed22caefbc09c66fa7cd247cbb90b8a5c609

# ---- build: npm ci, then `tsc --noEmit && vite build` (tsconfig also checks test/) ----
FROM ${NODE_IMAGE} AS build
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- test: `docker build --target test` ----
FROM build AS test
# The tests read ../../../../contracts/fixtures and ../../docs/PHASE2_ARCHITECTURE.md, outside this
# build context, so only this target takes those two folders as named contexts.
COPY --from=contracts fixtures /contracts/fixtures
COPY --from=docs PHASE2_ARCHITECTURE.md /docs/PHASE2_ARCHITECTURE.md
# Two workers, not one per CPU: with 4 workers a CPU-heavy jsdom test passed alone in about 3 s
# but exceeded the 5 s default timeout in the full parallel run.
RUN npm run lint && npm test -- --maxWorkers=2

# ---- runtime (default target) ----
FROM ${NGINX_IMAGE} AS runtime
# The official image fills /etc/nginx/templates/*.template from the environment at start.
# The filter keeps envsubst from touching nginx's own $variables. The ENTRYPOINT flag makes the
# image set NGINX_LOCAL_RESOLVERS from /etc/resolv.conf (Docker's DNS), used by the template.
ENV BACKEND_HOST=backend \
    BACKEND_PORT=4000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    NGINX_ENVSUBST_FILTER="^(BACKEND_|NGINX_LOCAL_RESOLVERS)"
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "-fsS", "http://127.0.0.1/healthz"]
