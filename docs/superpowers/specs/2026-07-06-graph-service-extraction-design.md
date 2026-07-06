# Graph Data Service Extraction — Design

**Date:** 2026-07-06
**Status:** approved (design shape), pending spec review → implementation plan
**Decisions locked (brainstorming):** extract the *whole* graph data service (`graphdb` + `graphql`); mechanism = **git submodule** of both parents; spec covers **all three phases**; TS agent is an **on-demand job**; **both containerized**; DB stays a host-provided bind-mounted volume.

## 1. Goal

Turn the implicit Python↔TS coupling ("the TS agent needs a Python GraphQL server pointed at the right DB, started by hand") into a **clean, independently-versioned service boundary**: extract the graph data service into its own repository, reference it as a git submodule from both `occupancy-engine` (Python) and `occupancy-engine-ts` (TS), and add a docker-compose that brings the whole thing up.

## 2. Background — the current coupling (why this is clean)

Verified by import analysis of `occupancy-engine`:

- **`graphql/`** (2613 LOC, 10 files) is a **leaf**: nothing else in the package imports it. Its *only* internal dependency is `graphdb.core` (`normalize_address`, `normalize_text`, `SOURCE_FILES`, `ID_LINKED_SOURCES`). Third-party: `strawberry`, `uvicorn`, `sqlite3`.
- **`graphdb/`** (build_index + DB kernel) is also a leaf: nothing outside `graphdb/`/`graphql/` imports it. Its only internal dependency is one function — `normalize_address_value` from `data_tools/normalize_filtered_addresses.py`.
- **`normalize_address_value`** (163-LOC, **stdlib-only** module) is a *widely shared* primitive (used by `heuristics`, `engine`, `accessors`, `pipelines`, `graphdb`, and already re-ported to TS as `src/heuristics/normalize.ts`). It **cannot move** — but the ~30 relevant lines have no third-party deps, so the service **vendors its own copy** (consistent with normalization already being duplicated across Python and TS).
- The **Python agents talk to GraphQL over HTTP** (`graphql_url`), not by importing `graphql/` — already decoupled, exactly like the TS side.

**Consequence:** moving `graphdb/` + `graphql/` out of occupancy-engine breaks **zero imports** in occupancy-engine (they were consumed only via CLI + HTTP). occupancy-engine only loses two leaf modules and two console-scripts.

## 3. The new repository

**Repo:** `occupancy-graph-service` (sibling of the two existing repos).
**Python package:** `occupancy_graph`, with subpackages `occupancy_graph.graphdb` (build_index + kernel) and `occupancy_graph.graphql` (server/schema/resolvers). The move is a **prefix rename** `occupancy_engine.` → `occupancy_graph.` across the ~20 internal cross-imports.
**Vendored normalizer:** `occupancy_graph/graphdb/_normalize.py` holds a copied `normalize_address_value` + `NormalizeResult` (stdlib-only), so the service depends on **nothing** from occupancy-engine.
**Console scripts:** `occupancy-graph-serve` (was `oe-graphql-serve`) and `occupancy-graph-build-index` (was `oe-graphdb-build-index`). The uvicorn multi-worker import string becomes `occupancy_graph.graphql.serve:app`; its DB env var is renamed `GRAPH_SERVICE_DB` (was `OE_GRAPHQL_DB`).
**Owns:** its `pyproject.toml` (Python ≥3.14, strawberry-graphql[asgi], uvicorn), a `Dockerfile`, a committed `schema.graphql` (SDL) + an export script, and its own tests (the graphdb/graphql tests move here).

## 4. Topology — submodule of both

```
                 occupancy-graph-service   (owns build + serve + schema + Dockerfile)
                     ▲                         ▲
   git submodule ────┘                         └──── git submodule
   at services/graph/                               at services/graph/
        │                                                │
   occupancy-engine (Python)                     occupancy-engine-ts (TS)
   - builds the DB via the submodule CLI         - compose builds the service image
   - agents query the service over HTTP            from the submodule path
                                                  - consumes schema.graphql (contract)
                                                  - owns the compose + agent Dockerfile
```

The submodule lives at a **known local path** (`services/graph/`) in each parent, which is what makes the compose build contexts local (`./services/graph` for the service, `.` for the agent) — **no fragile `../sibling` paths**.

## 5. The three boundary contracts

1. **Query contract** — `schema.graphql` (Strawberry SDL) committed in the service repo. A `bun`/`ts` and/or Python check can assert the running server matches it; both consumers pin the submodule commit.
2. **Build contract** — `occupancy-graph-build-index --cleaned-dir <dir> --db <path>` consumes cleaned CSVs (`SOURCE_FILES`: base/tax/loan/…), produces `graph.sqlite`. occupancy-engine's cleaning feeds these in.
3. **Config contract** — consumers reach the service via a **`GRAPHQL_URL`** env var. The TS side gains env support (`GRAPHQL_URL` becomes the default for `--graphql-url`; flag still overrides), so compose wires `GRAPHQL_URL=http://graphql:8000/graphql`.

## 6. Phase 1 — Extract & stand alone

Create `occupancy-graph-service` as an independent, working repo.

- Move `graphdb/` + `graphql/` into `occupancy_graph/`; rewrite the `occupancy_engine.` → `occupancy_graph.` import prefix; add the vendored `_normalize.py` and repoint `graphdb.core` to it.
- Add `pyproject.toml` (deps: strawberry-graphql[asgi], uvicorn; console scripts), a `Dockerfile` (`python:3.14-slim`, install package, `CMD occupancy-graph-serve …`), a `.dockerignore`, and move the relevant tests.
- Add `schema.graphql` + an export command (`occupancy-graph-export-schema` or a script using `schema.as_str()`), plus a test that the committed SDL is in sync.
- **Verification:** in a clean checkout, `pip install -e .`; `occupancy-graph-build-index` builds a `graph.sqlite` from a small cleaned-CSV fixture; `occupancy-graph-serve --db …` answers a `{ __typename }` + one real query; `pytest` (moved tests) green; the committed schema matches the live schema.

## 7. Phase 2 — Rewire parents as submodules

- **New repo:** push `occupancy-graph-service`; tag an initial commit.
- **occupancy-engine:** `git submodule add <url> services/graph`; **delete** `src/occupancy_engine/graphdb/` and `src/occupancy_engine/graphql/`, their two console-script entries in `pyproject.toml`, **and the corresponding `tests/` files for those modules** (they moved to the service repo in P1); repoint the DB-build workflow (whatever invoked `oe-graphdb-build-index`) to the submodule's `occupancy-graph-build-index` (via `pip install -e services/graph` in occupancy-engine's env, or `python -m occupancy_graph.graphdb.build_index`). **Verification:** occupancy-engine's remaining test suite is green (no source imported the removed modules; the module tests are gone); the DB-build path works via the submodule; the Python agents still query a running service over HTTP.
- **occupancy-engine-ts:** `git submodule add <url> services/graph`. No TS source depends on Python, so this is purely to host the build context + the schema contract. **Verification:** `bun run verify` still green; the submodule checks out at `services/graph/` with `schema.graphql` present.

## 8. Phase 3 — Orchestrate (compose)

In `occupancy-engine-ts`:

- **Agent Dockerfile** (`Dockerfile` at repo root): `oven/bun`, `bun install --frozen-lockfile`, entrypoint = the `run_address` CLI; reads `GRAPHQL_URL` + `ANTHROPIC_API_KEY` from env.
- **`GRAPHQL_URL` env support** (small `cli/run_address.ts` change): default `--graphql-url` from `process.env.GRAPHQL_URL`.
- **`compose.yaml`** (sketch):
  ```yaml
  services:
    graphql:
      build: ./services/graph          # the submodule
      environment: { GRAPH_SERVICE_DB: /data/graph.sqlite }
      volumes: [ "${GRAPH_DB:-./services/graph/data/indexes/graph.sqlite}:/data/graph.sqlite:ro" ]
      ports: [ "8000:8000" ]
      healthcheck:
        test: ["CMD","python","-c","import urllib.request,json; urllib.request.urlopen(urllib.request.Request('http://localhost:8000/graphql',data=json.dumps({'query':'{ __typename }'}).encode(),headers={'content-type':'application/json'}))"]
        interval: 5s
        timeout: 3s
        retries: 20
    agent:
      build: .
      depends_on: { graphql: { condition: service_healthy } }
      environment:
        GRAPHQL_URL: http://graphql:8000/graphql
        ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      profiles: [ tools ]              # run on demand, not on `up`
  ```
- **Usage:** `docker compose up graphql` (backend), then `docker compose run --rm agent --address "1104 SPRING RUN RD" --zip 40514`. The DB is provided on the host and bind-mounted (path via `GRAPH_DB`); never baked into an image.
- **Verification:** `docker compose up graphql` reaches healthy against a host DB; `docker compose run --rm agent …` produces an assessment; the deterministic TS E2E suite (from the harness) still passes independent of compose.

## 9. File/dir layout after the change

```
occupancy-graph-service/            (NEW repo)
  occupancy_graph/{graphdb,graphql}/ + graphdb/_normalize.py
  schema.graphql · pyproject.toml · Dockerfile · .dockerignore · tests/
occupancy-engine/                   (Python; loses graphdb+graphql)
  services/graph/  ← submodule
  .gitmodules
occupancy-engine-ts/                (TS; gains compose + submodule)
  services/graph/  ← submodule
  Dockerfile · compose.yaml · .gitmodules
  cli/run_address.ts  (GRAPHQL_URL env default)
```

## 10. Risks & mitigations

- **Vendored-normalizer drift** — the service's `_normalize.py` copy could diverge from `data_tools.normalize_filtered_addresses`. Mitigation: it's a stable stdlib primitive; add a small golden-value parity test in the service (same inputs → same normalized outputs as the documented cases). Already tolerated: Python and TS each have their own copy today.
- **Submodule ergonomics** — contributors must `git submodule update --init --recursive`. Mitigation: document in both READMEs / `init.sh`; CI checks out recursively.
- **Python importability of the submodule** — occupancy-engine must be able to run the build-index CLI from `services/graph`. Mitigation: `pip install -e services/graph` in occupancy-engine's environment (adds the two console scripts); no source import coupling remains.
- **uvicorn multi-worker module string** — the import-string `occupancy_graph.graphql.serve:app` + `GRAPH_SERVICE_DB` env must be consistent between CLI and container CMD. Mitigation: covered by Phase-1 standalone serve test with `--workers 2`.
- **DB provisioning** — the 1.76 GB DB is a host artifact (built by `occupancy-graph-build-index` from cleaned CSVs, or copied). Compose mounts it read-only; it is never committed or baked.

## 11. Out of scope

- Wrapping the TS agent as a long-running HTTP service (rejected — it's a job).
- Publishing the service image to a registry / prod deployment (submodule + local build is the target; image-publish is a later option).
- Rebuilding the DB inside a container (build stays a host/CLI step).
- Porting `graphdb`/`graphql` to TS (they stay Python — that's the whole point of the boundary).
- Merging the parked `feat/agent-harness` work (independent).
