FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV APP_TIME_ZONE=America/Sao_Paulo
ENV UPLOAD_STORAGE_ROOT=/data/uploads
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .
RUN apk add --no-cache poppler-utils \
  && mkdir -p /data/uploads \
  && chown node:node /data/uploads
VOLUME ["/data/uploads"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "src/server.js"]
