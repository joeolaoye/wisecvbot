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
# migrations ship with the image; run `npm run db:migrate` before start
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
