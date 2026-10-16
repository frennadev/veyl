# Veyl batch committee node (one member of the t-of-n committee that decrypts sealed batches' totals). Build from the
# repo root:   docker build -f committee/Dockerfile -t veyl-sol-committee .
# Each member runs its own node on its own infrastructure. Config is env only (committee/node.js): COMMITTEE_JSON (or
# COMMITTEE_CONFIG file: { index, t, n, peers: [{ index, url, node, boxKey }] }), NODE_SECRET_KEY (the member's node key;
# its DKG encryption key derives from it), DKG_SESSION (the same on every node, for the key generation), NETWORK +
# DEPLOY_JSON or a deploy.<network>.json copied in, RPC_URL, STATE_DIR (mount a persistent volume: the key share lives
# there, mode 0600), PORT (8863). GET /health for the host's checks; GET /transcript once the key generation is done.
FROM node:20-slim
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PORT=8863 STATE_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY sdk ./sdk
COPY committee ./committee
COPY scripts/committee-local.js ./scripts/committee-local.js
COPY package.json deploy.*.json ./
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 8863
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8863)+'/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1),()=>process.exit(1))"
CMD ["node", "committee/node.js"]
