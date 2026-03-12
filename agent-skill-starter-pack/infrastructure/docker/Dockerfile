# ─── Build Stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDeps for build)
RUN npm ci

# Copy source and build
COPY src/ ./src/
RUN npm run build

# ─── Production Stage ─────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S agentgroup && \
    adduser -u 1001 -S agentuser -G agentgroup

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Playwright browsers (for dynamic web scraping)
RUN npx playwright install chromium --with-deps || true

# Security: switch to non-root
USER agentuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('./dist/index').createAgent({ includeDefaultSkills: false }).healthCheck().then(h => process.exit(h.healthy ? 0 : 1))"

EXPOSE 3000

ENV NODE_ENV=production
ENV LOG_LEVEL=info

CMD ["node", "dist/index.js"]
