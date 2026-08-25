# ============================================================
# Shopify → Bitrix24 Integration Backend
# Express 4 + PostgreSQL (pg) — API-only, no frontend
# Port: 3001
# ============================================================

# ---- Stage 1: Build ----
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# ---- Stage 2: Production Runtime ----
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app

USER appuser

EXPOSE 3001

CMD ["node", "src/app.js"]

