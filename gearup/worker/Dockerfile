# Single stage, COPY only (CCoE convention). The Temporal worker runs Rust core
# through a glibc native module, and bundles the workflows with swc at start:
# the image is Debian-slim, not Alpine; node_modules comes from build-worker.
FROM docker.io/oven/bun:1.3-slim
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src
USER bun
EXPOSE 8081
CMD ["bun", "src/worker.ts"]
