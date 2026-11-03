# Single stage, COPY only (CCoE convention). node_modules comes from the build-api
# job (bun install --production): the Temporal client is the one runtime dependency.
FROM docker.io/oven/bun:1.3-alpine
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src
USER bun
EXPOSE 8080
CMD ["bun", "src/server.ts"]
