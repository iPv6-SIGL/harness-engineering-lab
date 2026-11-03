# Single stage, COPY only (CCoE convention). The worker resizes with sharp,
# whose prebuilt libvips is a glibc binary: the image is Debian-slim, not
# Alpine, and node_modules comes from the build-worker job (bun install --production).
FROM docker.io/oven/bun:1.3-slim
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src
USER bun
EXPOSE 8081
CMD ["bun", "src/worker.ts"]
