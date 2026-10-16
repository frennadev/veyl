# Veyl (Solana) relayer + approved-set publisher. Build from the repo root:
#   docker build -f relayer/Dockerfile -t veyl-sol-relayer .
# Config is env only (see .env.example): NETWORK, RPC_URL, RELAYER_SECRET_KEY (its own fee-only hot wallet), optional
# POSTMAN_SECRET_KEY, DEPLOY_JSON or a deploy.<network>.json copied in at build time, PORT (8843).
FROM node:20-slim
ENV NODE_ENV=production PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PORT=8843
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY sdk ./sdk
COPY relayer ./relayer
# deploy.devnet.json / deploy.mainnet.json (public addresses only) if they exist; package.json keeps the glob non-empty
COPY package.json deploy.*.json ./
USER node
EXPOSE 8843
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8843)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "relayer/relayer.js"]
