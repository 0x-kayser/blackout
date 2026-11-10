# BLACKOUT — one container: the API serves the built web app from the same origin.
# SQLite lives on a mounted volume at /data (attach a persistent disk in production).
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY database ./database
RUN pnpm install --frozen-lockfile
RUN pnpm build:web

FROM node:24-slim
WORKDIR /app
RUN useradd --create-home --uid 10001 blackout \
    && mkdir -p /data \
    && chown blackout /data
COPY --from=build --chown=blackout /app /app
USER blackout
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/blackout.sqlite \
    WEB_DIST=/app/dist \
    COOKIE_SECURE=true \
    TRUST_PROXY=true
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "apps/api/src/server.ts"]
