FROM oven/bun:1.2.15

WORKDIR /app

RUN apt-get update && apt-get install -y lsof curl wget docker.io && rm -rf /var/lib/apt/lists/*

# Install deps from backend package
COPY backend/package.json backend/bun.lock* /app/backend/
WORKDIR /app/backend
RUN bun install

# Copy backend source
COPY backend/ /app/backend/

EXPOSE 4000
CMD ["bun", "src/index.ts"]
