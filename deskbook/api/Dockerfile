# Single stage, COPY only (CCoE convention): Bun runs the TypeScript, and the
# API has no runtime dependency — Bun.serve, Bun.SQL and Bun.S3Client are built in.
FROM docker.io/oven/bun:1.3-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER bun
EXPOSE 8080
CMD ["bun", "src/server.ts"]
