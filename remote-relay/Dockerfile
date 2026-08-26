FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY relay.mjs server.mjs ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "server.mjs"]
