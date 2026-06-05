FROM node:18-alpine

RUN apk add --no-cache bash curl

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

WORKDIR /app/my-nextjs-app

COPY package.json tsconfig.json next.config.ts postcss.config.mjs ./
COPY src ./src

RUN bun install

EXPOSE 3000

CMD ["bun", "run", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
