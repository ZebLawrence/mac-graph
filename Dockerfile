FROM node:22-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
# Build tools needed by native add-ons (better-sqlite3, tree-sitter-*, kuzu)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# `npm ci` installs everything including devDeps; we need typescript for the
# build stage. NODE_ENV=production lives in the runtime stage only.
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
# Trim devDeps after the build is in dist/ — keeps the runtime image small.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
RUN npm prune --omit=dev
ENV PORT=3030
ENV DATA_DIR=/data
ENV REPO_DIR=/repo
ENV WIKI_DIR=/wiki
ENV EMBEDDING_MODEL=Xenova/bge-small-en-v1.5

EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3030/health').then(r => r.ok ? process.exit(0) : process.exit(1))"

CMD ["node", "dist/server.js"]
