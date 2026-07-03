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
