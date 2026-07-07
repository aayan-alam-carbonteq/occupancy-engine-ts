# Graph Data Service Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `graphdb` + `graphql` from `occupancy-engine` into a standalone `occupancy-graph-service` repo, reference it as a git submodule from both parents, and add a docker-compose that runs the service + the TS agent job.

**Architecture:** The two modules are clean leaves (nothing in occupancy-engine imports them; they're consumed via CLI + HTTP). Move them under a new `occupancy_graph` package (prefix rename `occupancy_engine.` → `occupancy_graph.`), vendor the one shared stdlib normalizer, and wire the result as `services/graph/` submodule in both repos.

**Tech Stack:** Python ≥3.14, strawberry-graphql[asgi], uvicorn, setuptools; Bun + TS (agent); Docker + docker compose; git submodules.

**Spec:** `docs/superpowers/specs/2026-07-06-graph-service-extraction-design.md` (approved).

**Repos & paths (absolute):**
- Python source: `/home/aayan-alam/Work/Helcion/occupancy-engine`
- TS: `/home/aayan-alam/Work/Helcion/occupancy-engine-ts`
- New service (to create): `/home/aayan-alam/Work/Helcion/occupancy-graph-service`

**Coordinator/operational notes:** Two steps need the human/coordinator: (Task 6) creating + pushing the new remote repo, and (Task 11) Docker + a host-provided `graph.sqlite`. Each is flagged inline.

---

## Move manifest (verified)

`graphdb/` (3): `__init__.py`, `build_index.py`, `core.py`.
`graphql/` (10): `__init__.py`, `db.py`, `filters.py`, `guardrails.py`, `loaders.py`, `registry.py`, `schema.py`, `serve.py`, `server.py`, `types.py`.
Adjacent (occupancy-engine): `cli/graphdb/build_index.py`, `cli/graphql/serve.py` (thin wrappers), `tests/test_graphdb.py`, `tests/test_graphql.py`, `scripts/bench_graphql_search.py`, `scripts/bench_server_concurrency.py`, `docs/GRAPHQL.md`.
Copy-not-move: `tests/graph_fixtures.py` (also imported by `tests/test_engine.py`, which stays).
The **22** `occupancy_engine.*` imports inside graphdb/graphql all get the `occupancy_engine.` → `occupancy_graph.` prefix, **except** `graphdb/core.py:11` (the `data_tools.normalize_filtered_addresses` import), which is repointed to the vendored module.

---

# PHASE 1 — Extract & stand alone (new repo)

Work in `/home/aayan-alam/Work/Helcion/occupancy-graph-service` unless noted.

### Task 1: Scaffold the new repo

**Files:** Create the repo skeleton.

- [ ] **Step 1: Init the repo + package dirs.**
```bash
mkdir -p /home/aayan-alam/Work/Helcion/occupancy-graph-service
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
git init -q
mkdir -p src/occupancy_graph tests
```

- [ ] **Step 2: Create `pyproject.toml`** (only the two real deps):
```toml
[project]
name = "occupancy-graph-service"
version = "0.1.0"
description = "Graph data service: build the address graph SQLite DB and serve it over GraphQL."
requires-python = ">=3.14"
dependencies = [
    "strawberry-graphql[asgi]>=0.316.0",
    "uvicorn>=0.49.0",
]

[project.scripts]
occupancy-graph-build-index = "occupancy_graph.graphdb.build_index:main"
occupancy-graph-serve = "occupancy_graph.graphql.serve:main"
occupancy-graph-export-schema = "occupancy_graph.graphql.export_schema:main"

[build-system]
requires = ["setuptools>=80"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
pythonpath = ["src", "tests"]
```

- [ ] **Step 3: Create `.gitignore`:**
```
__pycache__/
*.pyc
.venv/
data/
*.sqlite
schema.graphql.tmp
```

- [ ] **Step 4: Create `.dockerignore`:**
```
.git
.venv
__pycache__
data
*.sqlite
tests
```

- [ ] **Step 5: Create `README.md`** (short):
```markdown
# occupancy-graph-service

Builds the address-graph SQLite DB from cleaned CSVs and serves it over GraphQL.
Extracted from occupancy-engine; consumed as a git submodule by both
occupancy-engine (Python) and occupancy-engine-ts (TS).

## Use
    pip install -e .
    occupancy-graph-build-index --cleaned-dir <csvs> --db data/indexes/graph.sqlite
    occupancy-graph-serve --db data/indexes/graph.sqlite --port 8000

The GraphQL contract is `schema.graphql` (regenerate: `occupancy-graph-export-schema`).
```

- [ ] **Step 6: Commit.**
```bash
git add -A && git commit -q -m "chore: scaffold occupancy-graph-service (pyproject, ignores, readme)"
```

### Task 2: Move code + rename package + vendor normalizer

**Files:** copy the 13 module files; add `_normalize.py`; rename imports/env/import-string.

- [ ] **Step 1: Copy the module files** from occupancy-engine into the new package:
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
SRC=/home/aayan-alam/Work/Helcion/occupancy-engine/src/occupancy_engine
cp -r "$SRC/graphdb" src/occupancy_graph/graphdb
cp -r "$SRC/graphql" src/occupancy_graph/graphql
# thin CLI wrappers -> keep as scripts/ (optional convenience)
mkdir -p scripts
cp /home/aayan-alam/Work/Helcion/occupancy-engine/scripts/bench_graphql_search.py scripts/
cp /home/aayan-alam/Work/Helcion/occupancy-engine/scripts/bench_server_concurrency.py scripts/
cp /home/aayan-alam/Work/Helcion/occupancy-engine/docs/GRAPHQL.md ./GRAPHQL.md
```

- [ ] **Step 2: Vendor the normalizer.** Create `src/occupancy_graph/graphdb/_normalize.py` with EXACTLY (copied verbatim from `data_tools/normalize_filtered_addresses.py`, stdlib-only):
```python
"""Vendored address normalizer (copied from occupancy-engine data_tools).

Kept local so the graph service depends on nothing from occupancy-engine.
This is a stable primitive; a golden-value parity test guards drift.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class NormalizeResult:
    value: str
    changed: bool


def normalize_address_value(value: str) -> NormalizeResult:
    original = str(value or "").strip()
    if not original:
        return NormalizeResult(value="", changed=value != "")

    normalized = original.upper()
    normalized = re.sub(r"[^A-Z0-9\s#]", " ", normalized)
    replacements = {
        "AVENUE": "AVE",
        "STREET": "ST",
        "DRIVE": "DR",
        "ROAD": "RD",
        "COURT": "CT",
        "LANE": "LN",
        "BOULEVARD": "BLVD",
        "PARKWAY": "PKWY",
        "PLACE": "PL",
        "CIRCLE": "CIR",
        "TERRACE": "TER",
        "HIGHWAY": "HWY",
        "APARTMENT": "APT",
        "SUITE": "STE",
    }
    for source, target in replacements.items():
        normalized = re.sub(rf"\b{source}\b", target, normalized)
    normalized = re.sub(r"\bTRACE\b(?=(?:\s+#|\s+APT|\s+STE|$))", "TRCE", normalized)
    normalized = re.sub(r"\b(?:PK|PRK)\b(?=(?:\s+#|\s+APT|\s+STE|$))", "PARK", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return NormalizeResult(value=normalized, changed=normalized != original)
```

- [ ] **Step 3: Repoint the one external import.** Edit `src/occupancy_graph/graphdb/core.py`: replace the line
  `from occupancy_engine.data_tools.normalize_filtered_addresses import normalize_address_value`
  with
  `from occupancy_graph.graphdb._normalize import normalize_address_value`

- [ ] **Step 4: Prefix-rename the remaining 21 intra-package imports.** Run (rewrites only the graphdb/graphql prefixes, not the already-fixed data_tools line):
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
grep -rl "occupancy_engine\.graph" src/occupancy_graph scripts | while read -r f; do
  sed -i 's/occupancy_engine\.graphdb/occupancy_graph.graphdb/g; s/occupancy_engine\.graphql/occupancy_graph.graphql/g' "$f"
done
# verify none remain
grep -rn "occupancy_engine" src/occupancy_graph scripts || echo "clean: no occupancy_engine references"
```
Expected: `clean: no occupancy_engine references`.

- [ ] **Step 5: Rename the DB env var + uvicorn import string** in `src/occupancy_graph/graphql/serve.py`:
  - `_DB_ENV = "OE_GRAPHQL_DB"` → `_DB_ENV = "GRAPH_SERVICE_DB"`
  - the uvicorn import string `"occupancy_engine.graphql.serve:app"` → `"occupancy_graph.graphql.serve:app"` (the Step-4 sed already handled `occupancy_engine.graphql` inside strings — verify it did; if the string literal wasn't caught because it lacks the `.serve` pattern match, fix it explicitly).
  - Update the doc comments in serve.py that mention `OE_GRAPHQL_DB` to `GRAPH_SERVICE_DB`.

- [ ] **Step 6: Typecheck the package imports resolve.**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
python -m venv .venv && .venv/bin/pip install -q -e .
.venv/bin/python -c "import occupancy_graph.graphdb.core, occupancy_graph.graphql.server, occupancy_graph.graphql.serve; print('imports ok')"
```
Expected: `imports ok`. If an import fails, it's a missed rename — grep for `occupancy_engine` and fix.

- [ ] **Step 7: Commit.**
```bash
git add -A && git commit -q -m "feat: move graphdb+graphql into occupancy_graph; vendor normalizer; rename imports/env"
```

### Task 3: Move + adapt tests, prove build+serve works

**Files:** `tests/test_graphdb.py`, `tests/test_graphql.py`, `tests/graph_fixtures.py` (copy).

- [ ] **Step 1: Copy the tests + fixtures** into the new repo:
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
OE=/home/aayan-alam/Work/Helcion/occupancy-engine
cp "$OE/tests/test_graphdb.py" "$OE/tests/test_graphql.py" "$OE/tests/graph_fixtures.py" tests/
# rename imports in the copied tests
sed -i 's/occupancy_engine\.graphdb/occupancy_graph.graphdb/g; s/occupancy_engine\.graphql/occupancy_graph.graphql/g' tests/test_graphdb.py tests/test_graphql.py
grep -rn "occupancy_engine" tests || echo "tests clean"
```
Expected: `tests clean` (graph_fixtures.py has no occupancy_engine imports).

- [ ] **Step 2: Run the moved tests.**
```bash
.venv/bin/pip install -q pytest
.venv/bin/python -m pytest tests/ -q
```
Expected: all tests pass (the graphdb + graphql suites, ~exact count from the originals). If a test fails on an import, fix the rename; if it fails on behavior, the move changed something — investigate (should not happen — pure move).

- [ ] **Step 3: Commit.**
```bash
git add -A && git commit -q -m "test: move graphdb/graphql tests + fixtures into the service repo"
```

### Task 4: Schema export command + committed SDL + sync test

The Strawberry schema is built dynamically from a DB (`create_schema(db_path)`), so export needs a small fixture DB.

- [ ] **Step 1: Create `src/occupancy_graph/graphql/export_schema.py`:**
```python
"""Export the GraphQL SDL to schema.graphql (the boundary contract).

The schema is built dynamically from the DB registry, so we build a tiny
fixture DB, derive the schema from it, and write its SDL.
"""
from __future__ import annotations

import argparse
import tempfile
from pathlib import Path

from occupancy_graph.graphql.schema import create_schema


def render_sdl() -> str:
    # graph_fixtures.write_graph_fixture builds a minimal valid graph DB.
    from graph_fixtures import write_graph_fixture

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "fixture.sqlite"
        write_graph_fixture(db)
        return create_schema(db).as_str().rstrip() + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Write the GraphQL SDL to a file.")
    parser.add_argument("--out", type=Path, default=Path("schema.graphql"))
    args = parser.parse_args()
    args.out.write_text(render_sdl(), encoding="utf-8")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
```
Note: `render_sdl` imports `graph_fixtures` (on the pytest/`src`+`tests` path). For the console-script to find it outside pytest, the `pyproject` `pythonpath` doesn't apply — so the export command is intended to be run from the repo root where `tests/` is importable, OR move `write_graph_fixture` into `occupancy_graph.graphdb` as a small `sample_db()` helper. **Decision:** add a `sample_db(db_path)` helper to `occupancy_graph/graphdb/__init__.py` that wraps the fixture builder, and have both `export_schema` and the tests use it — so there's no `tests/`-path dependency. Implement that helper by copying `write_graph_fixture`'s body from `tests/graph_fixtures.py` into `occupancy_graph/graphdb/sample.py` as `def sample_db(db_path): ...`, and import it in `export_schema.py` (`from occupancy_graph.graphdb.sample import sample_db`).

- [ ] **Step 2: Generate the committed schema:**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
.venv/bin/python -m occupancy_graph.graphql.export_schema --out schema.graphql
head -5 schema.graphql   # sanity: valid SDL (type Query { ... })
```

- [ ] **Step 3: Write a sync test** `tests/test_schema_contract.py`:
```python
from pathlib import Path
from occupancy_graph.graphql.export_schema import render_sdl


def test_committed_schema_matches_live():
    committed = Path("schema.graphql").read_text(encoding="utf-8")
    assert committed == render_sdl(), (
        "schema.graphql is stale; run `occupancy-graph-export-schema` and commit."
    )
```

- [ ] **Step 4: Run it + full suite:**
```bash
.venv/bin/python -m pytest tests/ -q
```
Expected: pass (including the new sync test).

- [ ] **Step 5: Commit.**
```bash
git add -A && git commit -q -m "feat: schema export command + committed schema.graphql + sync test"
```

### Task 5: Dockerfile + standalone container run

- [ ] **Step 1: Create `Dockerfile`:**
```dockerfile
FROM python:3.14-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .
ENV GRAPH_SERVICE_DB=/data/graph.sqlite
EXPOSE 8000
# host + port fixed for the container; DB comes from the mounted volume via env
CMD ["sh", "-c", "occupancy-graph-serve --db \"$GRAPH_SERVICE_DB\" --host 0.0.0.0 --port 8000"]
```

- [ ] **Step 2: Build the image.**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
docker build -t occupancy-graph-service:dev .
```
Expected: builds clean.

- [ ] **Step 3: Smoke-test the container against a fixture DB.**
```bash
mkdir -p /tmp/ogs && .venv/bin/python -c "from occupancy_graph.graphdb.sample import sample_db; from pathlib import Path; sample_db(Path('/tmp/ogs/graph.sqlite'))"
docker run --rm -d --name ogs -p 8001:8000 -v /tmp/ogs/graph.sqlite:/data/graph.sqlite:ro occupancy-graph-service:dev
sleep 3
curl -s -X POST http://127.0.0.1:8001/graphql -H 'content-type: application/json' -d '{"query":"{ __typename }"}'
docker stop ogs
```
Expected: JSON `{"data":{"__typename":"Query"}}` (or the root type name). If the server needs `--host 0.0.0.0` (it does, for container networking) confirm the CMD used it.

- [ ] **Step 4: Commit.**
```bash
git add -A && git commit -q -m "feat: Dockerfile for the graph service (serves the mounted DB)"
```

**End of Phase 1: the service repo builds a DB, serves GraphQL, exports its schema, and containerizes — all standalone.**

---

# PHASE 2 — Rewire parents as submodules

### Task 6: Publish the service repo  *(coordinator/operational)*

- [ ] **Step 1: Create the remote + push.** (Uses the user's `github-work` account; confirm the org/name.)
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-graph-service
gh repo create aayan-alam-carbonteq/occupancy-graph-service --private --source=. --remote=origin --push
```
Expected: repo created, `main` pushed. **Fallback (no remote yet):** skip this and use the absolute local path as the submodule URL in Tasks 7-8 (`git submodule add /home/aayan-alam/Work/Helcion/occupancy-graph-service services/graph`); switch to the remote URL later. Record which URL you used — call it `<SERVICE_URL>` in the next tasks.

### Task 7: Wire into occupancy-engine + remove the moved code

Work in `/home/aayan-alam/Work/Helcion/occupancy-engine` on a new branch.

- [ ] **Step 1: Branch.**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-engine
git checkout -b feat/graph-service-submodule
```

- [ ] **Step 2: Add the submodule.**
```bash
git submodule add <SERVICE_URL> services/graph
```
Expected: `services/graph/` populated; `.gitmodules` created.

- [ ] **Step 3: Delete the moved code + adjacents (NOT graph_fixtures.py).**
```bash
git rm -r src/occupancy_engine/graphdb src/occupancy_engine/graphql \
         cli/graphdb cli/graphql \
         tests/test_graphdb.py tests/test_graphql.py \
         scripts/bench_graphql_search.py scripts/bench_server_concurrency.py \
         docs/GRAPHQL.md
```
Keep `tests/graph_fixtures.py` (still imported by `tests/test_engine.py`).

- [ ] **Step 4: Remove the two console-script lines** from `pyproject.toml` `[project.scripts]`:
  delete `oe-graphdb-build-index = "occupancy_engine.graphdb.build_index:main"` and `oe-graphql-serve = "occupancy_engine.graphql.serve:main"`.
  Also remove `strawberry-graphql[asgi]>=0.316.0` and `uvicorn>=0.49.0` from `dependencies` **only if** nothing else in occupancy-engine imports them — verify first:
```bash
grep -rnE "import strawberry|import uvicorn|from strawberry|from uvicorn" src/occupancy_engine || echo "no strawberry/uvicorn users remain -> safe to drop deps"
```
  If the grep prints users, keep the deps; otherwise drop them.

- [ ] **Step 5: Install the submodule so the build-index CLI is available** in occupancy-engine's env:
```bash
.venv/bin/pip install -e services/graph
.venv/bin/occupancy-graph-build-index --help | head -3   # confirm the CLI resolves
```

- [ ] **Step 6: Repoint doc references.** In any doc that said `oe-graphdb-build-index` / `oe-graphql-serve` (e.g. `docs/API.md:38`), change to `occupancy-graph-build-index` / `occupancy-graph-serve` (from the submodule). Grep to find them:
```bash
grep -rln "oe-graphdb-build-index\|oe-graphql-serve" docs README.md 2>/dev/null
```
  Update each hit.

- [ ] **Step 7: Verify occupancy-engine is still green.**
```bash
.venv/bin/python -m pytest tests/ -q
```
Expected: pass — nothing in occupancy-engine imported the removed modules; the removed tests are gone; `test_engine.py` still finds `graph_fixtures.py`. If an import error mentions `occupancy_engine.graphdb`/`graphql`, something outside the manifest referenced them — locate and repoint/remove.

- [ ] **Step 8: Commit.**
```bash
git add -A && git commit -m "refactor: extract graphdb+graphql to services/graph submodule"
```

### Task 8: Wire into occupancy-engine-ts

Work in `/home/aayan-alam/Work/Helcion/occupancy-engine-ts` on branch `feat/graph-service-extraction` (current).

- [ ] **Step 1: Add the submodule.**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-engine-ts
git submodule add <SERVICE_URL> services/graph
ls services/graph/schema.graphql   # the committed contract is present
```

- [ ] **Step 2: Verify the TS repo is still green** (submodule adds files but touches no TS):
```bash
bun run verify 2>&1 | tail -4
```
Expected: typecheck clean, lint 0, tests pass (unchanged from before).

- [ ] **Step 3: Commit.**
```bash
git add .gitmodules services/graph
git commit -m "chore: add occupancy-graph-service as services/graph submodule"
```

**End of Phase 2: both parents pin the service as a submodule; occupancy-engine no longer contains the service code; the DB-build path works via the submodule CLI.**

---

# PHASE 3 — Orchestrate (compose)

Work in `/home/aayan-alam/Work/Helcion/occupancy-engine-ts`.

### Task 9: GRAPHQL_URL env support (config contract)

**Files:** `cli/run_address.ts` + a test.

- [ ] **Step 1: Write the failing test** `test/run_address_env.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { resolveGraphqlUrl } from "../cli/run_address.ts";

describe("resolveGraphqlUrl", () => {
  test("prefers the flag, falls back to env, else undefined", () => {
    expect(resolveGraphqlUrl("http://flag", "http://env")).toBe("http://flag");
    expect(resolveGraphqlUrl(undefined, "http://env")).toBe("http://env");
    expect(resolveGraphqlUrl(undefined, undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it — fails** (`resolveGraphqlUrl` not exported).
`bun test test/run_address_env.test.ts` → FAIL.

- [ ] **Step 3: Add the helper + wire it** in `cli/run_address.ts`. Add an exported pure function and use it where `--graphql-url` is read (currently `values["graphql-url"]`):
```ts
export function resolveGraphqlUrl(flag: string | undefined, env: string | undefined): string | undefined {
  return flag ?? env ?? undefined;
}
```
Then replace the required-arg logic: compute `const graphqlUrl = resolveGraphqlUrl(values["graphql-url"], process.env.GRAPHQL_URL);` and use `graphqlUrl` in place of `values["graphql-url"]` (including the "required" check → error only if `graphqlUrl` is falsy; update the message to "provide --graphql-url or set GRAPHQL_URL").

- [ ] **Step 4: Run the test + full verify.**
```bash
bun test test/run_address_env.test.ts && bun run verify 2>&1 | tail -4
```
Expected: new test passes; verify green.

- [ ] **Step 5: Commit.**
```bash
git add cli/run_address.ts test/run_address_env.test.ts
git commit -m "feat(cli): GRAPHQL_URL env as default for --graphql-url (config contract)"
```

### Task 10: TS agent Dockerfile

- [ ] **Step 1: Create `Dockerfile`** at the TS repo root:
```dockerfile
FROM oven/bun:1.3.10
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# The agent is a job: args are passed at `docker compose run agent <args>`.
ENTRYPOINT ["bun", "run", "cli/run_address.ts"]
```

- [ ] **Step 2: Create `.dockerignore`:**
```
node_modules
.git
experiments
docs
test
services/graph
```
(`services/graph` is the Python submodule — the agent image doesn't need it.)

- [ ] **Step 3: Build the image.**
```bash
docker build -t occupancy-agent:dev .
```
Expected: builds clean.

- [ ] **Step 4: Commit.**
```bash
git add Dockerfile .dockerignore
git commit -m "feat: Dockerfile for the TS agent job"
```

### Task 11: compose.yaml — bring both up  *(coordinator: Docker + host DB)*

- [ ] **Step 1: Create `compose.yaml`** at the TS repo root:
```yaml
services:
  graphql:
    build: ./services/graph
    environment:
      GRAPH_SERVICE_DB: /data/graph.sqlite
    volumes:
      - "${GRAPH_DB:-../occupancy-engine/data/indexes/graph.sqlite}:/data/graph.sqlite:ro"
    ports:
      - "8000:8000"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,json; urllib.request.urlopen(urllib.request.Request('http://localhost:8000/graphql', data=json.dumps({'query':'{ __typename }'}).encode(), headers={'content-type':'application/json'}))"]
      interval: 5s
      timeout: 3s
      retries: 20

  agent:
    build: .
    depends_on:
      graphql:
        condition: service_healthy
    environment:
      GRAPHQL_URL: http://graphql:8000/graphql
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    profiles: ["tools"]   # run on demand, not on `up`
```

- [ ] **Step 2: Bring up the backend against the host DB.**
```bash
cd /home/aayan-alam/Work/Helcion/occupancy-engine-ts
export GRAPH_DB=/home/aayan-alam/Work/Helcion/occupancy-engine/data/indexes/graph.sqlite
docker compose up -d graphql
# wait for healthy
for i in $(seq 1 30); do s=$(docker compose ps --format '{{.Health}}' graphql); [ "$s" = "healthy" ] && break; sleep 2; done
echo "graphql health: $(docker compose ps --format '{{.Health}}' graphql)"
```
Expected: `healthy`.

- [ ] **Step 3: Run the agent job against it.** (Needs `ANTHROPIC_API_KEY` in env — this is a live LLM run; confirm before spending.)
```bash
export ANTHROPIC_API_KEY=$(grep -E '^ANTHROPIC_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"')
docker compose run --rm agent --address "1104 SPRING RUN RD" --zip 40514
```
Expected: prints an assessment JSON (the agent reached the composed GraphQL service by name). **Cost note:** this is a live agent run (~$0.13). If avoiding spend, instead assert only that the agent container resolves `graphql:8000` (e.g. run a `__typename` curl from inside the agent image) and defer the full run.

- [ ] **Step 4: Tear down.**
```bash
docker compose down
```

- [ ] **Step 5: Commit.**
```bash
git add compose.yaml
git commit -m "feat: compose — graphql service (DB volume + health) + on-demand agent job"
```

### Task 12: Docs + final verification

- [ ] **Step 1: Add a "Running the stack" section** to the TS repo `README.md` (and note submodule init):
```markdown
## Running the stack (compose)

    git submodule update --init --recursive          # fetch services/graph
    export GRAPH_DB=/abs/path/to/graph.sqlite         # host-built DB (bind-mounted RO)
    docker compose up -d graphql                      # backend on :8000
    docker compose run --rm agent --address "…" --zip …   # on-demand agent job
    docker compose down

The GraphQL boundary is `services/graph/schema.graphql`. The agent reads
`GRAPHQL_URL` (compose sets it to the service name).
```

- [ ] **Step 2: Final verify (offline suite still independent of compose).**
```bash
bun run verify 2>&1 | tail -4
```
Expected: green (the deterministic E2E harness is unaffected by any of this).

- [ ] **Step 3: Commit.**
```bash
git add README.md
git commit -m "docs: how to run the composed stack + submodule init"
```

**End of Phase 3: `docker compose up graphql` + `docker compose run agent …` runs the whole pipeline across the clean submodule boundary.**

---

## Self-review (completed by plan author)

**Spec coverage:** New repo + package rename + vendored normalizer (Tasks 1-2) · moved tests (Task 3) · schema SDL contract + sync test (Task 4) · service Dockerfile (Task 5) · publish (Task 6) · occupancy-engine rewire + code removal + deps/scripts cleanup + doc repoint (Task 7) · TS submodule (Task 8) · GRAPHQL_URL config contract (Task 9) · agent Dockerfile (Task 10) · compose + DB volume + health + agent job (Task 11) · docs + final verify (Task 12). All three phases and the three boundary contracts (SDL / build-index CLI / GRAPHQL_URL) are covered.

**Placeholder scan:** `<SERVICE_URL>` is a deliberate late-bound value (the submodule URL depends on Task 6's remote vs local-path choice) — defined in Task 6 and referenced consistently. No implementation-step placeholders; the vendored normalizer, pyproject, Dockerfiles, compose, and the GRAPHQL_URL helper are shown in full.

**Consistency:** `occupancy_graph` package, `services/graph` submodule path, `GRAPH_SERVICE_DB` env, `GRAPHQL_URL` config, and console-script names (`occupancy-graph-build-index`/`-serve`/`-export-schema`) are used identically across all tasks. The `graph_fixtures.py` copy-not-move gotcha and the `sample_db` helper (to avoid a `tests/`-path dependency in the export command) are handled in Tasks 3-4. Bench scripts + `docs/GRAPHQL.md` are moved (Task 2) and removed from occupancy-engine (Task 7) consistently.

**Known follow-ups (out of this plan):** switching a local-path submodule to the remote URL if Task 6 used the fallback; optional normalizer parity test beyond the move (the moved graphdb tests already exercise it).
