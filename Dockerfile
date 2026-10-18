# ── build stage ──────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# tsc doesn't copy YAML — the boards list ships next to dist/config/boards.js
COPY --from=build /app/src/config/boards.yaml ./dist/config/boards.yaml
COPY web ./web
# migrations ship with the image and are applied at boot by src/main.ts
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
