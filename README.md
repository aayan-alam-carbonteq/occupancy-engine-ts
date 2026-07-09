# occupancy-engine-ts

TypeScript (Bun) port of the occupancy-engine agent pipeline. Ports `agents`, `heuristics`,
`observability`, and `judge`; talks to the existing Python GraphQL server over HTTP.

See `docs/MIGRATION.md` for scope, library mapping, and port order.

## Setup
```bash
bun install
bun run typecheck
bun test
```

## Running the stack (compose)

    git submodule update --init --recursive          # fetch services/graph
    export GRAPH_DB=/abs/path/to/graph.sqlite         # host-built DB (bind-mounted RO)
    docker compose up -d graphql                      # backend on :8000
    docker compose run --rm agent --address "…" --zip …   # on-demand agent job
    docker compose down

The GraphQL boundary is `services/graph/schema.graphql`. The agent reads
`GRAPHQL_URL` (compose sets it to the service name). The agent job also needs
`ANTHROPIC_API_KEY` in the environment.
