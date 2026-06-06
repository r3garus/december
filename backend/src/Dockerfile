FROM node:18-alpine

RUN apk add --no-cache bash curl

RUN mkdir -p /app/my-nextjs-app /app/workspace-template /home/node/.bun \
  && chown -R node:node /app /home/node

USER node

ENV BUN_INSTALL="/home/node/.bun"
ENV PATH="/home/node/.bun/bin:$PATH"

RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /app/my-nextjs-app

COPY --chown=node:node package.json tsconfig.json next.config.ts postcss.config.mjs tailwind.config.ts ./
COPY --chown=node:node src ./src

RUN bun install

RUN mkdir -p \
  /app/my-nextjs-app/.next \
  /app/my-nextjs-app/node_modules/.cache \
  /home/node/.cache \
  /home/node/.bun/install/cache

RUN cp -a /app/my-nextjs-app/. /app/workspace-template/

RUN printf '%s\n' \
  '#!/bin/sh' \
  'set -e' \
  'if [ ! -f /app/my-nextjs-app/package.json ]; then' \
  '  cp -a /app/workspace-template/. /app/my-nextjs-app/' \
  'fi' \
  'exec "$@"' \
  > /home/node/entrypoint.sh \
  && chmod +x /home/node/entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/home/node/entrypoint.sh"]
CMD ["bun", "run", "dev", "--hostname", "0.0.0.0", "--port", "3000"]
