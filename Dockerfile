FROM oven/bun:1.3.10
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The engine runs as a long-running HTTP service exposing POST /investigate.
EXPOSE 8787
ENTRYPOINT ["bun", "run", "cli/serve.ts"]
