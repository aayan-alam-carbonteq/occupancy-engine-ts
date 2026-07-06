FROM oven/bun:1.3.10
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The agent is a job: args are passed at `docker compose run agent <args>`.
ENTRYPOINT ["bun", "run", "cli/run_address.ts"]
