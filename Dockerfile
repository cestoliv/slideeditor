# node:sqlite is built into Node, and nothing here loads a native module, so
# musl is safe. Revisit this line if a dependency ever adds one.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: prepare runs `npm run build`, but at this point only the
# manifest is in the context, not the source it needs. The explicit `npm run
# build` below (after COPY . .) is what actually builds this stage.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# package.json defines prepare as `npm run build`, which a production install
# would run without the dev dependencies it needs. --ignore-scripts is what
# stops that, not an optimisation.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY assets ./assets

# Owned by node so a fresh named volume is writable by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /data
ENV SLIDE_STUDIO_DATA=/data
ENV SLIDE_STUDIO_PORT=4173
# Caddy terminates TLS and forwards over http, so the scheme arrives in a header.
ENV SLIDE_STUDIO_TRUST_PROXY=1
VOLUME ["/data"]
EXPOSE 4173

USER node

# /api/health is deliberately unguarded so this works without a credential.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# A container that binds loopback is unreachable from the host. That is the same
# bind the server refuses to start on without a password, which is the interlock.
CMD ["node", "bin/slide-studio.mjs", "--host", "0.0.0.0"]
