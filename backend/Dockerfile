FROM oven/bun:1.2.15

WORKDIR /app

RUN apt-get update && apt-get install -y lsof && rm -rf /var/lib/apt/lists/*

COPY . .
RUN bun install

EXPOSE 4000
CMD ["bun", "src/index.ts"]
