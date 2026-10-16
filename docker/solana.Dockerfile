# Local tooling image for docker-compose.yml: Node 20 + the Agave (Solana) CLI and test validator + this repo.
# Runs the local validator, the deploy entrypoint and the static site against it. Not used in production.
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates bzip2 && rm -rf /var/lib/apt/lists/*
ARG AGAVE_VERSION=v3.1.9
# the compose volume mounts here; owned by node so the non-root user can write the throwaway key and the deploy output
RUN mkdir -p /state && chown node:node /state
USER node
RUN sh -c "$(curl -sSfL https://release.anza.xyz/${AGAVE_VERSION}/install)"
ENV PATH=/home/node/.local/share/solana/install/active_release/bin:$PATH \
    SOLANA_BIN=/home/node/.local/share/solana/install/active_release/bin \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app
COPY --chown=node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
# includes target/deploy (prebuilt programs + the public dev program keypairs) and zk/ (docker/solana.Dockerfile.dockerignore)
COPY --chown=node . .
