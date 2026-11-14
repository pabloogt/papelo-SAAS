# Imagen de producción: Node 24 + SQLite integrado (node:sqlite), sin compilación nativa.
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# Datos persistentes (SQLite + archivos) en un volumen montado en /data.
ENV DATABASE_PATH=/data/papelo.db \
    UPLOAD_DIR=/data/uploads \
    PORT=8080
RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
