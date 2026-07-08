FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV UPLOAD_STORAGE_ROOT=/data/uploads
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data/uploads
VOLUME ["/data/uploads"]
EXPOSE 3000
CMD ["node", "src/server.js"]
