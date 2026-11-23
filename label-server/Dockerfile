FROM node:22-bookworm-slim

# DejaVu fonts are what the built-in templates are designed with.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY templates ./templates

ENV NODE_ENV=production \
    PORT=3000 \
    TEMPLATES_DIR=/data/templates \
    FONTS_DIR=/data/fonts
RUN mkdir -p /data/templates /data/fonts && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
