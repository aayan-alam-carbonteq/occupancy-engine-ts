# occupancy-engine-ts

TypeScript (Bun) port of the occupancy-engine agent pipeline. Ports `agents`, `heuristics`,
`observability`, and `judge`; talks to the occupancy data service over six typed HTTP operations
plus a guarded SQL hatch.

`docs/MIGRATION.md` records the original Python → TypeScript port (scope, library mapping, port
order). It predates the move off GraphQL and describes the data layer as it was then.

## Setup
```bash
bun install
OE_PROSE_REGISTER=off bun run verify
```

## Running the stack (compose)

    git submodule update --init --recursive          # fetch services/graph
    export PARTNER_DSN=postgres://…                  # partner corpus (read-only credentials)
    export ANTHROPIC_API_KEY=sk-…                    # the agent's /healthz constructs a chat model
    docker compose up -d graph                       # data service on :8000
    docker compose up -d agent                       # engine service on :8787
    docker compose down

The data boundary is the six typed operations of `POST /v1/resolve`,
`GET /v1/address/{id}/records|people`, `GET /v1/person/{id}/records`, `GET /v1/people/search`,
`GET /v1/source-record/{shape}/{rowid}`, and the hatch at `POST /v1/sql` / `GET /v1/schema`.
The agent reads `DATA_URL` (compose sets it to `http://graph:8000`, which is also the engine's
compiled-in default).

The engine runs as a long-running service, not a per-run job: the image's entrypoint is
`cli/serve.ts`, which exposes `POST /investigate` (NDJSON progress frames then one terminal
`report`/`error` frame, bearer-authenticated with `ENGINE_AUTH_TOKEN`) and an unauthenticated
`GET /healthz`. Other env it reads: `ENGINE_PORT` (default 8787), `ENGINE_MAX_CONCURRENCY` (4),
`ENGINE_REQUEST_TIMEOUT_MS` (300000), `ENGINE_SHUTDOWN_DRAIN_MS`.

For a single address without compose, point the CLI at a locally running data service:

    bun run run-address --address '1104 SPRING RUN RD' --zip 40514 --data-url http://127.0.0.1:8000

Note `docker compose config` interpolates `${ANTHROPIC_API_KEY}` from your shell or `.env` and
prints it. Redirect it (`docker compose config >/dev/null`) or use `--no-interpolate`.
