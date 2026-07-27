# AI Job Result Cache — Engine Half (X-015) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the backend the two engine-owned dimensions of its AI-report cache key — a source-tree
hash of this engine and a per-address hash of the graph data this engine actually reads — behind one
new endpoint, `POST /fingerprint`, without touching `POST /investigate`, the agent pipeline's
behaviour, or `services/graph`.

**Architecture:** Three new pure-ish modules under `src/fingerprint/` (one shared canonicalizer, a
startup source-tree hash, a `DataSourceProbe` port + GraphQL adapter) plus one route in the existing
`Bun.serve` router. The probe resolves the subject address through **the same code
`AgentOrchestrator.preflight` uses** (extracted, not copied) and reads rows through **the same
`src/agents/retrieval.ts` helpers the agents use**, then hashes the engine's *own normalized
projection* — never the source's wire format — so the future partner-endpoint adapter is a drop-in
and volatile transport fields (cursors, request ids, response timestamps) can never poison the key.

**Tech Stack:** Bun 1.3.10 · TypeScript (strict, `noUncheckedIndexedAccess`) · `Bun.serve` ·
`node:crypto` sha256 · zod 3 · `bun test` · Biome.

**Spec:** `../../../../docs/superpowers/specs/2026-07-27-ai-job-result-cache-design.md` (§1 three fingerprints +
`DataSourceProbe`; §7 "Engine"). **Umbrella / pinned contract:**
`../../../../docs/superpowers/plans/2026-07-27-ai-job-result-cache.md` — the contract there is authoritative and
this plan implements it exactly.

**Branch:** `feat/fingerprint-endpoint`, cut from **`main`** (this repo is trunk;
`scripts/repo-branch.sh engine` → `main`, promotion chain `main`). Every `git checkout -b`, PR base
and merge target is `main`. Never rewrite `main`.

---

## The pinned contract (implement exactly; nothing more)

```jsonc
// POST /fingerprint    Authorization: Bearer <ENGINE_AUTH_TOKEN>   (same token as /investigate)
// request
{ "items": [ { "address": "1104 Spring Run Rd", "zip": "40514" }, { "address": "22 Elm St" } ] }
// response 200 — one entry per input, SAME ORDER, callers zip by index
{ "engine": "9f3c1a…", "items": [ { "data": "7ab1e4…" }, { "data": null } ] }
```

| Case | Engine behaviour |
|---|---|
| bad/missing bearer | `401` |
| malformed body (bad JSON, unknown key, missing `address`, empty/oversized `items`) | `400` + zod paths |
| one address unresolvable, or its probe fails/throws | **`200`**, that item's `data: null` — never a whole-request failure |

**`model` is NOT in this response and must never be added.** The backend keys on its own
`config.investigation.model` — the exact value it already sends in the `/investigate` body — because
it owns the model the run actually uses. An engine-reported model id could drift from it and key a
report on a model the run did not use (under-invalidation: the one failure direction that serves a
*wrong* report), and the only mitigation would be an ops rule keeping `ENGINE_MODEL` equal to
`investigation.model` — exactly the hand-maintained coupling spec Decision 2 forbids. **Do not add a
`configured_model_id` helper, an `ENGINE_MODEL` reporting path, or any ops rule about model-id sync.**

---

## Two things to carry, because both are load-bearing and both are true

### (a) The engine's graph URL must name the same graph the backend's `/investigate` requests name

`POST /investigate` carries its own `graphql_url` in the body. **`POST /fingerprint` deliberately does
not** — the contract's item shape is `{address, zip}` and the schema is `.strict()`. So the probe
reads whichever graph **this engine process** is configured with
(`create_engine_server({graphql_url})` ← `GRAPHQL_URL`, default `http://graphql:8000/graphql`).

If the engine's `GRAPHQL_URL` and the backend's configured `graphql_url` differ, **the fingerprint
describes a different dataset than the investigation reads**, and the cache can serve a report
computed over data the run never saw. This is a silent, wrong-answer failure — the only direction
this feature must not fail in. Task 9 makes it observable (`bun run serve` prints the graph URL and
the engine hash at startup) and Task 10 writes it into `AGENTS.md` as an ops rule.

### (b) The gitignored `.env` makes a bare test run show pre-existing failures — this is the true baseline

`.env` (gitignored, present in this working copy) sets `OE_PROSE_REGISTER=on` and
`OE_PROSE_REDACT=on`. **Bun auto-loads `.env`, and `env -u` does not clear it**, so a bare
`bun run verify` shows 2 failures out of the box that predate this work and fail *by construction*
(`proseRedactEnabled > is off by default` and `_prose_register_lines (gated) > is empty by default` —
they assert the flags are off). The true baseline command, used for **every** gate in this plan:

```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
```

Last recorded green baseline on `main` (X-014, `5e8e15f`): typecheck clean, lint **0 errors** (3
pre-existing warnings), **169 pass / 0 fail / 706 expect()**. Record the *actual* numbers you observe
in Step 1 of Task 1 — that number, not this one, is the baseline you compare against at the end.

---

### Task 1: Branch, baseline, and the `feature_list.json` entry

**Files:**
- Modify: `feature_list.json`

- [ ] **Step 1: Cut the branch from `main` and record the true baseline**

```bash
cd /home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts
test "$(../scripts/repo-branch.sh engine)" = "main"   # asserts the base; never hardcode it
git checkout main && git pull --ff-only && git checkout -b feat/fingerprint-endpoint
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
```

Expected: `repo-branch.sh` prints `main`; on branch `feat/fingerprint-endpoint`; verify green —
typecheck clean, lint 0 errors, ~169 pass / 0 fail. **Write the exact pass/fail/expect() counts down;
they are the baseline for the final gate and for `feature_list.json` evidence.**

- [ ] **Step 2: Add the feature entry (`in_progress` — exactly one, per AGENTS.md working rule 2)**

Append to `feature_list.json` (array of objects; all nine keys are required by
`test/feature_list.test.ts`; ids must be unique; **at most one** `in_progress`):

```json
  {
    "id": "fingerprint-endpoint",
    "priority": 13,
    "area": "server",
    "title": "POST /fingerprint — engine source-tree hash + per-address graph data hash (AI job result cache, X-015)",
    "user_visible_behavior": "POST /fingerprint (bearer auth, same token as /investigate) takes {items:[{address,zip}]} and returns {engine, items:[{data}]} — one entry per input in the SAME order. `engine` is a sha256 over src/**, cli/**, package.json and bun.lock, computed once at startup. Each `data` is a sha256 over the engine's own normalized record projection for that address (resolved exactly as preflight resolves it, read through the retrieval.ts helpers, no LLM), or null when the address is unresolvable or the read fails. 401 without the bearer, 400 on a malformed body; a per-item probe failure NEVER fails the whole request. No model id is reported, by design. POST /investigate is unchanged.",
    "status": "in_progress",
    "verification": "OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify; OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e; test/canonical_json.test.ts; test/source_hash.test.ts; test/address_resolution.test.ts; test/fingerprint_records.test.ts; test/fingerprint_probe.test.ts; test/fingerprint_wire.test.ts; test/fingerprint_endpoint.test.ts",
    "evidence": "",
    "notes": "Engine half of X-015. Contract pinned in docs/superpowers/plans/2026-07-27-ai-job-result-cache.md (workspace). services/graph gets ZERO changes — the probe is a read. OPS: the engine's GRAPHQL_URL must name the same graph the backend sends as graphql_url in /investigate, or the fingerprint describes a different dataset than the run reads."
  }
```

- [ ] **Step 3: Verify the feature-list guard still passes**

Run: `bun test test/feature_list.test.ts`
Expected: PASS (4 tests) — unique ids, required fields, at most one `in_progress`.

- [ ] **Step 4: Commit**

```bash
git add feature_list.json
git commit -m "chore(feature-list): open fingerprint-endpoint (X-015 engine half)"
```

---

### Task 2: One canonicalizer for the whole repo (`src/fingerprint/canonical.ts`)

`src/agents/query_cache.ts` already has a `canonicalJson` with recursive key sorting. A second copy
would be a silent-drift hazard of exactly the kind this feature exists to prevent, so we **extract**
it and re-point the query cache at it.

**Files:**
- Create: `src/fingerprint/canonical.ts`
- Modify: `src/agents/query_cache.ts:6-29` (delete the local `canonicalJson` + `sortValue`, import instead)
- Test: `test/canonical_json.test.ts`

- [ ] **Step 1: Write the failing test**

`test/canonical_json.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../src/fingerprint/canonical.ts";
import { QueryCache } from "../src/agents/query_cache.ts";

describe("canonicalJson", () => {
  test("object key order does not matter, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("array ORDER is preserved — it is data, not noise", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("keys inside array members are sorted too", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("null and empty containers survive verbatim", () => {
    expect(canonicalJson({ a: null, b: [], c: {} })).toBe('{"a":null,"b":[],"c":{}}');
  });
});

describe("sha256Hex", () => {
  test("matches the published sha256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("is 64 lowercase hex characters", () => {
    expect(/^[0-9a-f]{64}$/.test(sha256Hex(""))).toBe(true);
  });
});

describe("QueryCache still uses the shared canonicalizer", () => {
  test("identical queries whose variables differ only in KEY ORDER are one execution", async () => {
    const cache = new QueryCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { ok: true };
    };
    await cache.get_or_execute("query Q { a }", { b: 1, a: 2 }, factory);
    await cache.get_or_execute("query Q { a }", { a: 2, b: 1 }, factory);
    expect(calls).toBe(1);
    expect(cache.hits).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/canonical_json.test.ts`
Expected: FAIL — `Cannot find module '../src/fingerprint/canonical.ts'`

- [ ] **Step 3: Implementation**

Create `src/fingerprint/canonical.ts`:

```ts
// The ONE canonicalizer in this repo. The query cache's identity and the fingerprint's hash must
// agree byte-for-byte, and a second copy is precisely the silent-drift hazard this feature exists
// to remove: a divergent canonicalizer shows up as a cache that simply never hits, or as two
// engines that fingerprint the same data differently. Extracted from src/agents/query_cache.ts.
import { createHash } from "node:crypto";

/**
 * JSON with every object's keys recursively sorted. Array ORDER is preserved on purpose — an array's
 * order is data. Callers that need order-insensitivity (the fingerprint's record list) impose a
 * total order on the array BEFORE calling this.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortValue(obj[key]);
  }
  return out;
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
```

Then in `src/agents/query_cache.ts`, delete lines 10-29 (the `canonicalJson` comment block,
`canonicalJson`, and `sortValue`) and add the import at the top of the file, above `cacheKey`:

```ts
// Single-flight query cache: concurrent identical queries are coalesced by storing the in-flight
// Promise in a Map before yielding control. Because everything between the cache checks and the
// `_inflight.set(...)` is synchronous (no `await`), concurrent callers that arrive while a query is
// running observe the in-flight Promise and await it instead of re-executing. Errors are not cached.
import { canonicalJson } from "../fingerprint/canonical.ts";

function cacheKey(query: string, variables: Record<string, unknown> | null | undefined): string {
  return query.trim() + "\x00" + canonicalJson(variables ?? {});
}
```

Everything from `export class QueryCache {` down is unchanged.

- [ ] **Step 4: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/canonical_json.test.ts && OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck`
Expected: PASS (8 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprint/canonical.ts src/agents/query_cache.ts test/canonical_json.test.ts
git commit -m "refactor(fingerprint): extract the shared canonicalJson + sha256Hex out of query_cache"
```

---

### Task 3: The startup source-tree hash (`src/fingerprint/source_hash.ts`)

This is the `engine` dimension: **derived, never declared** (spec Decision 2). `.dockerignore`
excludes `.git`, so no build SHA is readable at runtime; a whole-tree walk over the shipped code is
what is actually available, and unlike a curated file list it cannot drift out of date.

**Files:**
- Create: `src/fingerprint/source_hash.ts`
- Test: `test/source_hash.test.ts`

- [ ] **Step 1: Write the failing test**

`test/source_hash.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HASHED_ROOTS, compute_source_hash, engine_source_hash } from "../src/fingerprint/source_hash.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const temps: string[] = [];

/** A miniature engine tree: two hashed roots, two hashed files, two files OUTSIDE the hashed set. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "engine-src-hash-"));
  temps.push(root);
  mkdirSync(join(root, "src", "agents"), { recursive: true });
  mkdirSync(join(root, "cli"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "agents", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "cli", "serve.ts"), "console.log('serve');\n");
  writeFileSync(join(root, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(root, "bun.lock"), "lock\n");
  writeFileSync(join(root, "docs", "notes.md"), "notes\n");
  writeFileSync(join(root, "test", "a.test.ts"), "test\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

describe("compute_source_hash", () => {
  test("an unchanged tree hashes identically every time (stable across restarts)", () => {
    const root = makeTree();
    const first = compute_source_hash(root);
    expect(compute_source_hash(root)).toBe(first);
    expect(/^[0-9a-f]{64}$/.test(first)).toBe(true);
  });

  test("changing any hashed file changes the hash", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    writeFileSync(join(root, "src", "agents", "a.ts"), "export const a = 2;\n");
    expect(compute_source_hash(root)).not.toBe(before);
  });

  test("adding a nested file under a hashed root changes the hash (whole-tree walk, no curated list)", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    mkdirSync(join(root, "src", "fingerprint"), { recursive: true });
    writeFileSync(join(root, "src", "fingerprint", "b.ts"), "export const b = 1;\n");
    expect(compute_source_hash(root)).not.toBe(before);
  });

  test("files OUTSIDE the hashed set do not affect the hash (docs/, test/, progress churn)", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    writeFileSync(join(root, "docs", "notes.md"), "different notes\n");
    writeFileSync(join(root, "test", "a.test.ts"), "different test\n");
    writeFileSync(join(root, "PROGRESS.md"), "session record\n");
    expect(compute_source_hash(root)).toBe(before);
  });

  test("a missing hashed entry does not throw, and its removal changes the hash", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    rmSync(join(root, "bun.lock"));
    const after = compute_source_hash(root);
    expect(after).not.toBe(before);
    expect(/^[0-9a-f]{64}$/.test(after)).toBe(true);
  });
});

describe("engine_source_hash", () => {
  test("is this repo tree's hash, cached for the process", () => {
    const hash = engine_source_hash();
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    expect(engine_source_hash()).toBe(hash);
    expect(hash).toBe(compute_source_hash(REPO_ROOT));
  });

  test("every hashed root actually ships in the image — .dockerignore must not exclude one", () => {
    const ignored = readFileSync(resolve(REPO_ROOT, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const entry of HASHED_ROOTS) {
      expect(existsSync(resolve(REPO_ROOT, entry))).toBe(true);
      expect(ignored).not.toContain(entry);
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/source_hash.test.ts`
Expected: FAIL — `Cannot find module '../src/fingerprint/source_hash.ts'`

- [ ] **Step 3: Implementation**

Create `src/fingerprint/source_hash.ts`:

```ts
// The `engine` dimension of the backend's AI-report cache key: a content hash of this engine's own
// source tree. DERIVED, never declared — a version string somebody has to remember to bump is the
// exact failure mode this feature must not have.
//
// Why a tree walk and not a git SHA: .dockerignore excludes .git, so no build SHA is readable at
// runtime inside the image. Why a whole-tree walk and not a curated file list: a curated list is one
// more thing to keep in sync, and forgetting an entry means serving a report computed by code the
// list does not cover.
//
// An engine deploy changes this hash and drains the cache. That is INTENDED: over-invalidation costs
// a rerun, under-invalidation serves a wrong report.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Everything the running engine's behaviour is made of, relative to the repo root. `test/**` and
 * `docs/**` are deliberately absent — they cannot change what an investigation produces, and
 * including them would drain the cache on every progress-note commit. All four ship in the image
 * (asserted by test/source_hash.test.ts against .dockerignore).
 */
export const HASHED_ROOTS = ["src", "cli", "package.json", "bun.lock"] as const;

// This file lives at <root>/src/fingerprint/source_hash.ts. Bun runs TS from source in both dev and
// the image (no bundling), so import.meta.dir is the real on-disk location in both.
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

let cached: string | null = null;

/** The process-wide engine source hash. Computed once (at server startup), free thereafter. */
export function engine_source_hash(): string {
  if (cached === null) {
    cached = compute_source_hash(REPO_ROOT);
  }
  return cached;
}

/**
 * sha256 over the sorted `relpath\0sha256(content)` lines of every file under `entries`.
 * Sorting the lines is what makes the result independent of directory-read order.
 * Exported so tests can drive it over a temp tree.
 */
export function compute_source_hash(root: string, entries: readonly string[] = HASHED_ROOTS): string {
  const files: string[] = [];
  for (const entry of entries) {
    collect(resolve(root, entry), files);
  }
  const lines = files
    .map((absolute) => `${relative(root, absolute).split(sep).join("/")}\u0000${sha256File(absolute)}`)
    .sort();
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** Depth-first collect of every regular file under `path`. An absent path contributes nothing. */
function collect(path: string, out: string[]): void {
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return; // e.g. a checkout with no bun.lock — hash the tree that IS there rather than crash at boot
  }
  if (stats.isFile()) {
    out.push(path);
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }
  for (const item of readdirSync(path, { withFileTypes: true })) {
    collect(join(path, item.name), out);
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/source_hash.test.ts && OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprint/source_hash.ts test/source_hash.test.ts
git commit -m "feat(fingerprint): startup source-tree hash over src/cli/package.json/bun.lock"
```

---

### Task 4: One address-resolution path, shared by `preflight` and the probe

The probe **must** resolve the address exactly the way an investigation does. If it does not, the
fingerprint describes a different address than the run reads. Rather than copy `preflight`'s
resolution (a drift hazard) or drag an `AgentOrchestrator` + a dummy subagent into the cache path,
we extract the resolution step out of `preflight` **behaviour-preservingly** — same two queries, same
order, same `result_summary` strings, so `context.preflight_queries` stays byte-identical — and both
callers use it. The equivalence is then structural *and* pinned by a test.

**Files:**
- Modify: `src/agents/orchestrator.ts:407-427` (preflight's resolution step) + new exports near the
  "Preflight builders" section (`src/agents/orchestrator.ts:1240`)
- Test: `test/address_resolution.test.ts`

- [ ] **Step 1: Write the failing test**

`test/address_resolution.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CountingGraphQLTool, GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import {
  AgentOrchestrator,
  resolve_subject_address,
  resolved_address_id,
} from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104, sparsePreflightPayload } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

/** Drives BOTH the real preflight and the extracted resolver over the same graph state. */
async function bothPaths(payload: Record<string, unknown>) {
  const server = new FixtureGraphQLServer(payload);
  try {
    const tool = new GraphQLHttpTool(server.url);
    const request = AgentInvestigationRequestSchema.parse({
      address: "1104 SPRING RUN RD",
      zip: "40514",
      graphql_url: server.url,
    });
    const context = await new AgentOrchestrator({ graphql: tool, subagent: new FakeSubagent() }).preflight(request);
    const resolution = await resolve_subject_address(
      new CountingGraphQLTool(tool, { max_calls: 3, agent_id: "fingerprint_probe" }),
      request.address,
      request.zip,
    );
    return { context, resolution };
  } finally {
    server.close();
  }
}

describe("resolve_subject_address is the SAME resolution AgentOrchestrator.preflight performs", () => {
  test("real 1104 fixture: same candidates, same selection, same address id", async () => {
    const { context, resolution } = await bothPaths(loadPreflight1104());
    expect(resolution.candidates).toEqual(context.candidates);
    expect(resolution.selected).toEqual(context.selected);
    expect(resolved_address_id(resolution)).toBe(_resolve_bundle_address_id(context));
    expect(resolved_address_id(resolution)).toBe(3342);
  });

  test("sparse fixture: same candidates, same selection, same address id", async () => {
    const { context, resolution } = await bothPaths(sparsePreflightPayload());
    expect(resolution.candidates).toEqual(context.candidates);
    expect(resolution.selected).toEqual(context.selected);
    expect(resolved_address_id(resolution)).toBe(_resolve_bundle_address_id(context));
  });

  test("unresolvable address: both paths yield no selection and a null address id", async () => {
    const { context, resolution } = await bothPaths({
      searchAddresses: { totalCount: 0, nodes: [] },
      addressByText: null,
    });
    expect(resolution.selected).toBeNull();
    expect(context.selected).toBeNull();
    expect(resolved_address_id(resolution)).toBeNull();
    expect(_resolve_bundle_address_id(context)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/address_resolution.test.ts`
Expected: FAIL — `resolve_subject_address is not a function` / TS2305 export not found.

- [ ] **Step 3: Implementation**

**3a.** In `src/agents/orchestrator.ts`, immediately below the `// ── Preflight builders ──` banner
(currently line 1240, above `function _candidate`), add:

```ts
/** What preflight's address-resolution step produced, before any evidence-map building. */
export interface SubjectAddressResolution {
  address_data: Record<string, any> | null;
  candidates: AddressCandidate[];
  selected: AddressCandidate | null;
}

/**
 * The ONE address-resolution path in the engine. `AgentOrchestrator.preflight` calls it, and so does
 * the fingerprint probe (src/fingerprint/graphql_probe.ts) — so a fingerprint can never describe a
 * different address than the investigation reads. Two queries at most: the preflight search, plus the
 * by-id fallback only when `addressByText` came back null and there is a candidate to fall back to.
 */
export async function resolve_subject_address(
  graphql: CountingGraphQLTool,
  address: string,
  zip: string,
): Promise<SubjectAddressResolution> {
  const data = await graphql.query(
    PREFLIGHT_QUERY,
    { query: address, zip: zip || null },
    { result_summary: "address search and source counts" },
  );
  const search = (data["searchAddresses"] ?? {}) as Record<string, any>;
  const nodes = (search["nodes"] ?? []) as any[];
  const candidates = nodes.map((node) => _candidate(node as Record<string, any>));
  let address_data: Record<string, any> | null = (data["addressByText"] ?? null) as Record<string, any> | null;
  if (address_data === null && candidates.length > 0) {
    const by_id = await graphql.query(
      ADDRESS_BY_ID_QUERY,
      { id: candidates[0]!.id },
      { result_summary: "fallback address by id" },
    );
    address_data = (by_id["address"] ?? null) as Record<string, any> | null;
  }
  return { address_data, candidates, selected: _selected_candidate(address_data, candidates) };
}

/**
 * The address id preflight puts on `evidence_map.address_id` — i.e. the id `_resolve_bundle_address_id`
 * hands the agents, and therefore the subject the probe must read. Mirrors `_evidence_map`'s own rule.
 */
export function resolved_address_id(resolution: SubjectAddressResolution): number | null {
  if (resolution.selected !== null) {
    return resolution.selected.id;
  }
  const raw = resolution.address_data?.["id"];
  if (raw === null || raw === undefined) {
    return null;
  }
  return Math.trunc(Number(raw)) || 0;
}
```

**3b.** Replace `src/agents/orchestrator.ts:407-427` — the head of `preflight`, from
`const data = await graphql.query(` through the `address_data = (by_id["address"] ...)` block — so
the method reads:

```ts
  async preflight(request: AgentInvestigationRequest): Promise<ResolvedAddressContext> {
    const graphql = new CountingGraphQLTool(this.graphql, { max_calls: 3, agent_id: "orchestrator" });
    const schema_guide = "";
    // Shared with the fingerprint probe — see resolve_subject_address. Same queries, same order,
    // same result_summary strings, so `preflight_queries` below is byte-identical to before.
    const { address_data, candidates, selected } = await resolve_subject_address(
      graphql,
      request.address,
      request.zip,
    );
    const source_counts = _source_counts((address_data ?? {}) as Record<string, any>);
```

Everything from `// Absent payload => empty, exactly as today:` (line 429) onward is **unchanged** —
note the pre-existing `const selected = ...` and `const source_counts = ...` lines are the ones being
replaced, and the later `_evidence_map(...)`, `_is_ambiguous(candidates)` and
`ResolvedAddressContextSchema.parse({...})` calls keep referring to the same `address_data`,
`candidates`, `selected`, `source_counts` bindings.

- [ ] **Step 4: Run the tests, verify they pass — including the parity guardrails**

Run:
```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/address_resolution.test.ts test/preflight_external.test.ts
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck
```
Expected: address_resolution 3 pass; preflight_external unchanged and green; **`bun run e2e` 6 pass /
0 fail** (this is the byte-identity guardrail for the investigation path — AGENTS.md "Parity first");
typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/agents/orchestrator.ts test/address_resolution.test.ts
git commit -m "refactor(orchestrator): extract resolve_subject_address so preflight and the probe share one path"
```

---

### Task 5: The `DataSourceProbe` port, `NormalizedRecord`, and the record fingerprint

The port and the pure hashing live apart from the adapter so the future partner-endpoint adapter is a
drop-in and this file needs no change when it arrives.

**Files:**
- Create: `src/fingerprint/data_source_probe.ts`
- Test: `test/fingerprint_records.test.ts`

- [ ] **Step 1: Write the failing test**

`test/fingerprint_records.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "../src/fingerprint/canonical.ts";
import {
  records_fingerprint,
  sort_records,
  type NormalizedRecord,
} from "../src/fingerprint/data_source_probe.ts";

function record(overrides: Partial<NormalizedRecord> = {}): NormalizedRecord {
  return {
    scope: "address",
    subject_id: "3342",
    source: "tax",
    table: "tax",
    rowid: 1,
    data: { ownername: "WHISMAN JESSICA", zip: "40514" },
    ...overrides,
  };
}

describe("records_fingerprint", () => {
  test("is independent of the order the source returned rows in", () => {
    const a = record();
    const b = record({ source: "base", table: "base", rowid: 2, data: { firstname: "JESSICA" } });
    const c = record({ scope: "person", subject_id: "cd146804", source: "voter", table: "voter", rowid: 9 });
    expect(records_fingerprint([a, b, c])).toBe(records_fingerprint([c, a, b]));
    expect(records_fingerprint([a, b, c])).toBe(records_fingerprint([b, c, a]));
  });

  test("is independent of key order inside data", () => {
    const a = record({ data: { ownername: "X", zip: "40514" } });
    const b = record({ data: { zip: "40514", ownername: "X" } });
    expect(records_fingerprint([a])).toBe(records_fingerprint([b]));
  });

  test("changes when ANY field of ANY record changes", () => {
    const base = records_fingerprint([record()]);
    expect(records_fingerprint([record({ scope: "person" })])).not.toBe(base);
    expect(records_fingerprint([record({ subject_id: "9999" })])).not.toBe(base);
    expect(records_fingerprint([record({ source: "base" })])).not.toBe(base);
    expect(records_fingerprint([record({ table: "tax_v2" })])).not.toBe(base);
    expect(records_fingerprint([record({ rowid: 2 })])).not.toBe(base);
    expect(records_fingerprint([record({ rowid: null })])).not.toBe(base);
    expect(records_fingerprint([record({ data: { ownername: "SOMEONE ELSE", zip: "40514" } })])).not.toBe(base);
  });

  test("changes when a record is added or removed", () => {
    const one = records_fingerprint([record()]);
    const two = records_fingerprint([record(), record({ rowid: 2 })]);
    expect(two).not.toBe(one);
  });

  test("an empty record set is a REAL state with a stable hash, not an error", () => {
    expect(records_fingerprint([])).toBe(sha256Hex("[]"));
    expect(records_fingerprint([])).toBe(records_fingerprint([]));
  });

  test("is exactly sha256(canonicalJson(sorted records)) — no hidden salt", () => {
    const records = [record({ rowid: 2 }), record()];
    expect(records_fingerprint(records)).toBe(sha256Hex(canonicalJson(sort_records(records))));
  });
});

describe("sort_records", () => {
  test("does not mutate its input", () => {
    const input = [record({ rowid: 2 }), record({ rowid: 1 })];
    const snapshot = canonicalJson(input);
    sort_records(input);
    expect(canonicalJson(input)).toBe(snapshot);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_records.test.ts`
Expected: FAIL — `Cannot find module '../src/fingerprint/data_source_probe.ts'`

- [ ] **Step 3: Implementation**

Create `src/fingerprint/data_source_probe.ts`:

```ts
// The port the cache key's `data` dimension is taken over.
//
// The hash sits inside the ENGINE'S OWN normalized projection, never a source's wire format (spec
// Decision 3): the partner endpoint's schema is not ours, will not match today's GraphQL schema, and
// we cannot ask its owners to add anything — but this projection must exist for ANY source, because
// the prompts depend on a stable record shape. Hashing the projection also immunizes the key against
// volatile transport fields (cursors, request ids, response timestamps): they cannot poison the hash
// for the same reason the model never sees them — they do not survive normalization.
import { canonicalJson, sha256Hex } from "./canonical.ts";

/** One normalized row the engine would reason over, independent of where it was read from. */
export interface NormalizedRecord {
  /** "address" for rows hanging off the resolved subject address; "person" for a linked person. */
  scope: "address" | "person";
  /** The resolved address id (stringified) or the person id the row hangs off. */
  subject_id: string;
  /**
   * Source key — one of ADDRESS_SOURCE_FIELDS / PERSON_SOURCE_FIELDS in src/agents/retrieval.ts, or
   * "identity" for a person node itself.
   */
  source: string;
  /** Physical table the row came from; "" when the projection has none (identity rows). */
  table: string;
  /** Row identity within the table; null when the source does not expose one. */
  rowid: number | string | null;
  /** The compact field projection: SOURCE_DATA_FIELDS output, or a compacted person node. */
  data: Record<string, unknown>;
}

export interface DataSourceProbe {
  /**
   * Deterministic per-address read → the engine's normalized record model.
   * `null` means "unavailable" (unresolvable address, or the read failed).
   * A probe NEVER throws: a throw would turn one bad address in a 500-scan batch into a whole-request
   * failure, when the contract says it costs that one scan its cache lookup and nothing more.
   */
  probe(address: string, zip?: string): Promise<NormalizedRecord[] | null>;
}

/**
 * A total order over records, so the hash does not depend on the order the source returned rows in.
 * This is the same trap the backend's array re-sort closes, and it fails the same silent way: without
 * it, two identical reads can hash differently and the cache simply never hits. Returns a new array —
 * the caller's list is not mutated.
 */
export function sort_records(records: NormalizedRecord[]): NormalizedRecord[] {
  return records
    .map((record) => ({ key: record_key(record), record }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((item) => item.record);
}

function record_key(record: NormalizedRecord): string {
  return [
    record.scope,
    record.subject_id,
    record.source,
    record.table,
    record.rowid === null ? "" : String(record.rowid),
    canonicalJson(record.data),
  ].join("\u0000");
}

/** The `data` dimension of the cache key: sha256 over the sorted, canonicalized projection. */
export function records_fingerprint(records: NormalizedRecord[]): string {
  return sha256Hex(canonicalJson(sort_records(records)));
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_records.test.ts && OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprint/data_source_probe.ts test/fingerprint_records.test.ts
git commit -m "feat(fingerprint): DataSourceProbe port + NormalizedRecord + order-independent record hash"
```

---

### Task 6: The GraphQL `DataSourceProbe` adapter

Resolve the address exactly as preflight does (Task 4), then read the subject's source rows and one
hop of linked-person rows **through the existing `src/agents/retrieval.ts` helpers** — no
reimplementation, no new GraphQL documents, and `_compact_person_node` stays module-private because
`fetch_people_at_address` already applies it.

**Design decisions worth knowing before you read the code:**

- **Any `ok !== true` from a retrieval helper aborts the probe with `null`.** Those helpers swallow
  `GraphQLToolError` and return `{ok:false, error:"<message>"}`. Hashing an error string would be
  non-deterministic — a transient graph blip would mint a fake cache key. Abort instead.
- **`summary` is dropped.** `_record_summary` is a deterministic rendering of the same `data`, so
  hashing both double-weights a change and adds no information.
- **The person hop is bounded (`MAX_PROBED_PERSONS`, 5) and the window is chosen by *sorted id*,
  never by the order the source returned people in** — otherwise the window itself would be
  non-deterministic. This probe runs on **every** cache lookup, so its cost is the tax the cache
  pays: ≤8 queries and zero LLM calls, against an investigation's tens of queries plus a planner,
  N subagents and an adjudicator.
- **Known coverage gap, accepted** (spec §1): the probe covers the subject address plus one hop of
  persons, with per-source row limits. A subagent that reaches further, or a source with more rows
  than the limit, reads data the probe does not fingerprint. `maxAgeDays` (backend) is the valve;
  read-set replay is the complete fix if it ever bites.
- **`records === []` is a real state, not a failure.** An address that resolves but has no rows
  fingerprints normally, so two runs over it hit each other.

**Files:**
- Create: `src/fingerprint/graphql_probe.ts`
- Modify: `test/support/fixtures.ts` (add `probeGraphPayload`)
- Test: `test/fingerprint_probe.test.ts`

- [ ] **Step 1: Add the probe fixture payload**

Append to `test/support/fixtures.ts` (after `sparsePreflightPayload`):

```ts
/**
 * The graph payload the fingerprint probe reads. FixtureGraphQLServer answers EVERY query with the
 * same `data` object, so this carries the UNION of the keys the probe's query shapes select: the real
 * 1104 preflight (`searchAddresses` / `addressByText`) plus `address` (per-source shortcut rows),
 * `peopleAtAddress`, and `person` (one person's rows, returned for whichever person is asked for).
 * Sources not listed under `address` come back empty, exactly as a sparse address would.
 */
export function probeGraphPayload(): Record<string, unknown> {
  const sourceRows = (table: string, rows: Record<string, unknown>[]) => ({
    totalCount: rows.length,
    hasMore: false,
    nodes: rows.map((data, index) => ({ table, rowid: index + 1, data })),
  });
  return {
    ...loadPreflight1104(),
    address: {
      baseRecords: sourceRows("base", [
        {
          id: "cd146804",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          primaryaddress: "1104 SPRING RUN RD",
          zip: "40514",
          lengthofresidence: 6,
        },
      ]),
      taxProperties: sourceRows("tax", [
        {
          id: "tx-1",
          tax_id: "TX1",
          address: "1104 SPRING RUN RD",
          zip: "40514",
          ownername: "WHISMAN JESSICA",
          owneraddressline1: "1104 SPRING RUN RD",
          residential: "Y",
          ownerrescount: 1,
        },
      ]),
      utilityRecords: sourceRows("utility", [
        {
          first_name: "JOSIAH",
          last_name: "CORRELL",
          address: "1104 SPRING RUN RD",
          city: "LEXINGTON",
          state: "KY",
          zip: "40514",
        },
      ]),
    },
    // Deliberately NOT in id order — the probe must sort, so the hash cannot depend on arrival order.
    peopleAtAddress: {
      totalCount: 2,
      hasMore: false,
      nodes: [
        {
          id: "cd146889",
          firstname: "JOSIAH",
          lastname: "CORRELL",
          fullName: "JOSIAH  CORRELL",
          normNameKey: "correll|josiah",
          primaryAddressId: 3342,
        },
        {
          id: "cd146804",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          fullName: "JESSICA  WHISMAN",
          normNameKey: "whisman|jessica",
          primaryAddressId: 3342,
        },
      ],
    },
    person: {
      id: "cd146804",
      firstname: "JESSICA",
      middlename: null,
      lastname: "WHISMAN",
      fullName: "JESSICA  WHISMAN",
      baseRecords: sourceRows("base", [
        { id: "cd146804", firstname: "JESSICA", lastname: "WHISMAN", zip: "40514" },
      ]),
      voterRecords: sourceRows("voter", [
        {
          id: "v-1",
          voter_id: "V1",
          firstname: "JESSICA",
          lastname: "WHISMAN",
          address: "1104 SPRING RUN RD",
          zip: "40514",
        },
      ]),
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

`test/fingerprint_probe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { GraphQLHttpTool } from "../src/agents/graphql_tool.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { AgentOrchestrator } from "../src/agents/orchestrator.ts";
import { _resolve_bundle_address_id } from "../src/agents/retrieval.ts";
import { records_fingerprint } from "../src/fingerprint/data_source_probe.ts";
import { GraphQLDataSourceProbe } from "../src/fingerprint/graphql_probe.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { loadPreflight1104, probeGraphPayload } from "./support/fixtures.ts";
import { FakeSubagent } from "./support/subagents.ts";

const ADDRESS = "1104 SPRING RUN RD";
const ZIP = "40514";

async function probeOver(payload: Record<string, unknown>, max_probed_persons?: number) {
  const server = new FixtureGraphQLServer(payload);
  try {
    const probe = new GraphQLDataSourceProbe(
      new GraphQLHttpTool(server.url),
      max_probed_persons === undefined ? {} : { max_probed_persons },
    );
    return await probe.probe(ADDRESS, ZIP);
  } finally {
    server.close();
  }
}

describe("GraphQLDataSourceProbe — determinism", () => {
  test("the same graph state probed twice yields the same hash", async () => {
    const first = await probeOver(probeGraphPayload());
    const second = await probeOver(probeGraphPayload());
    expect(first).not.toBeNull();
    expect(records_fingerprint(first!)).toBe(records_fingerprint(second!));
  });

  test("changing one source row changes the hash", async () => {
    const before = await probeOver(probeGraphPayload());
    const mutated = probeGraphPayload();
    (mutated["address"] as any).taxProperties.nodes[0].data.ownername = "SOMEONE ELSE";
    const after = await probeOver(mutated);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(records_fingerprint(after!)).not.toBe(records_fingerprint(before!));
  });

  test("the ORDER the source returns rows in does not change the hash", async () => {
    const before = await probeOver(probeGraphPayload());
    const reordered = probeGraphPayload();
    (reordered["peopleAtAddress"] as any).nodes.reverse();
    const after = await probeOver(reordered);
    expect(records_fingerprint(after!)).toBe(records_fingerprint(before!));
  });

  test("an address that resolves with no rows anywhere still fingerprints — empty is a real state", async () => {
    const records = await probeOver(loadPreflight1104());
    expect(records).toEqual([]);
    expect(typeof records_fingerprint(records!)).toBe("string");
  });

  test("the person hop is bounded and the bound is honoured", async () => {
    const capped = await probeOver(probeGraphPayload(), 1);
    expect(capped).not.toBeNull();
    const probedPersons = new Set(
      capped!.filter((r) => r.scope === "person" && r.source !== "identity").map((r) => r.subject_id),
    );
    expect(probedPersons.size).toBe(1);
    // The identity rows for BOTH people are still fingerprinted — only the record hop is capped.
    expect(capped!.filter((r) => r.source === "identity").length).toBe(2);
  });
});

describe("GraphQLDataSourceProbe — never throws, degrades to null", () => {
  test("an unresolvable address yields null", async () => {
    const records = await probeOver({ searchAddresses: { totalCount: 0, nodes: [] }, addressByText: null });
    expect(records).toBeNull();
  });

  test("a graph that returns GraphQL errors yields null", async () => {
    const server = new FixtureGraphQLServer({}, [{ message: "boom" }]);
    try {
      const probe = new GraphQLDataSourceProbe(new GraphQLHttpTool(server.url));
      expect(await probe.probe(ADDRESS, ZIP)).toBeNull();
    } finally {
      server.close();
    }
  });

  test("an unreachable graph yields null", async () => {
    const probe = new GraphQLDataSourceProbe(
      new GraphQLHttpTool("http://127.0.0.1:1/graphql", { timeout_seconds: 2 }),
    );
    expect(await probe.probe(ADDRESS, ZIP)).toBeNull();
  });
});

describe("GraphQLDataSourceProbe — reads what the investigation reads", () => {
  test("address rows are scoped to the id the REAL preflight resolved, and carry no summary", async () => {
    const server = new FixtureGraphQLServer(probeGraphPayload());
    try {
      const tool = new GraphQLHttpTool(server.url);
      const context = await new AgentOrchestrator({ graphql: tool, subagent: new FakeSubagent() }).preflight(
        AgentInvestigationRequestSchema.parse({ address: ADDRESS, zip: ZIP, graphql_url: server.url }),
      );
      const records = await new GraphQLDataSourceProbe(tool).probe(ADDRESS, ZIP);
      expect(records).not.toBeNull();

      const addressRows = records!.filter((r) => r.scope === "address");
      expect(addressRows.length).toBeGreaterThan(0);
      expect([...new Set(addressRows.map((r) => r.subject_id))]).toEqual([
        String(_resolve_bundle_address_id(context)),
      ]);

      // `summary` is a rendering of `data`; hashing both would double-weight a change.
      for (const record of records!) {
        expect(Object.hasOwn(record, "summary")).toBe(false);
      }
      // The compact projection reached the record, not the raw GraphQL node.
      const tax = addressRows.find((r) => r.source === "tax");
      expect(tax === undefined).toBe(false);
      expect(tax!.data["ownername"]).toBe("WHISMAN JESSICA");
    } finally {
      server.close();
    }
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_probe.test.ts`
Expected: FAIL — `Cannot find module '../src/fingerprint/graphql_probe.ts'`

- [ ] **Step 4: Implementation**

Create `src/fingerprint/graphql_probe.ts`:

```ts
// Today's DataSourceProbe. Resolves the subject address exactly as an investigation's preflight does
// (the SAME resolve_subject_address), then reads the subject's source rows and ONE HOP of linked-person
// rows through the SAME src/agents/retrieval.ts helpers the agents use. Deterministic, no LLM.
//
// The partner adapter that replaces this one calls their read API as an agent would and maps the
// response into the same NormalizedRecord model — nothing outside this file moves when it arrives.
import { CountingGraphQLTool, type GraphQLHttpTool } from "../agents/graphql_tool.ts";
import { resolve_subject_address, resolved_address_id } from "../agents/orchestrator.ts";
import {
  fetch_address_records_multi,
  fetch_people_at_address,
  fetch_person_records,
} from "../agents/retrieval.ts";
import type { DataSourceProbe, NormalizedRecord } from "./data_source_probe.ts";

/** Address rows per source. Matches the shortcut helper's own default. */
const ADDRESS_RECORD_LIMIT = 25;
/** People read at the subject address, before the person cap is applied. */
const PEOPLE_LIMIT = 25;
/** Rows per source for each probed person. */
const PERSON_RECORD_LIMIT = 20;
/**
 * How many linked persons get their records read. Bounded on purpose: this probe runs on EVERY cache
 * lookup, so its cost is the tax the cache pays. The window is taken from persons sorted by id — never
 * from the order the source happened to return them in — so the window itself is deterministic.
 */
export const MAX_PROBED_PERSONS = 5;

export interface GraphQLDataSourceProbeOptions {
  max_probed_persons?: number;
}

export class GraphQLDataSourceProbe implements DataSourceProbe {
  private readonly tool: GraphQLHttpTool;
  private readonly max_probed_persons: number;

  constructor(tool: GraphQLHttpTool, opts: GraphQLDataSourceProbeOptions = {}) {
    this.tool = tool;
    this.max_probed_persons = Math.max(0, opts.max_probed_persons ?? MAX_PROBED_PERSONS);
  }

  async probe(address: string, zip = ""): Promise<NormalizedRecord[] | null> {
    try {
      return await this._probe(address, zip);
    } catch {
      // Contract: a probe NEVER throws. One bad address must cost that item its lookup, nothing more.
      return null;
    }
  }

  private async _probe(address: string, zip: string): Promise<NormalizedRecord[] | null> {
    // Budget: 1 preflight + 1 possible by-id fallback + 1 address-multi + 1 people + one per person.
    const graphql = new CountingGraphQLTool(this.tool, {
      max_calls: 4 + this.max_probed_persons,
      agent_id: "fingerprint_probe",
    });

    const resolution = await resolve_subject_address(graphql, address, zip);
    const address_id = resolved_address_id(resolution);
    if (address_id === null) {
      return null; // unresolvable address → this item's `data` is null
    }
    const subject = String(address_id);
    const records: NormalizedRecord[] = [];

    const address_records = await fetch_address_records_multi(graphql, address_id, {
      limit: ADDRESS_RECORD_LIMIT,
      offset: 0,
    });
    // The retrieval helpers swallow GraphQLToolError into {ok:false, error:"<message>"}. Hashing an
    // error string would mint a fake key from a transient blip — abort to null instead.
    if (address_records["ok"] !== true) {
      return null;
    }
    for (const [source, bundle] of Object.entries(asRecord(address_records["records_by_source"]))) {
      for (const node of asArray(asRecord(bundle)["records"])) {
        records.push(compact_node_record("address", subject, source, node));
      }
    }

    const people = await fetch_people_at_address(graphql, address_id, { limit: PEOPLE_LIMIT });
    if (people["ok"] !== true) {
      return null;
    }
    const person_nodes = asArray(people["people"])
      .filter((node) => typeof asRecord(node)["id"] === "string" && asRecord(node)["id"] !== "")
      .sort((a, b) => {
        const left = String(asRecord(a)["id"]);
        const right = String(asRecord(b)["id"]);
        return left < right ? -1 : left > right ? 1 : 0;
      });

    for (const node of person_nodes) {
      const person = asRecord(node);
      records.push({
        scope: "person",
        subject_id: String(person["id"]),
        source: "identity",
        table: "",
        rowid: null,
        data: { ...person },
      });
    }

    for (const node of person_nodes.slice(0, this.max_probed_persons)) {
      const person_id = String(asRecord(node)["id"]);
      const person_records = await fetch_person_records(graphql, person_id, { limit: PERSON_RECORD_LIMIT });
      if (person_records["ok"] !== true) {
        return null;
      }
      for (const [source, bundle] of Object.entries(asRecord(person_records["records_by_source"]))) {
        for (const row of asArray(asRecord(bundle)["records"])) {
          records.push(compact_node_record("person", person_id, source, row));
        }
      }
    }

    return records;
  }
}

/**
 * `_compact_source_node` output → NormalizedRecord. `summary` is DROPPED: it is a deterministic
 * rendering of the same `data`, so hashing both would double-weight a change and add no information.
 */
function compact_node_record(
  scope: "address" | "person",
  subject_id: string,
  source: string,
  node: unknown,
): NormalizedRecord {
  const record = asRecord(node);
  const rowid = record["rowid"];
  return {
    scope,
    subject_id,
    source,
    table: typeof record["table"] === "string" ? record["table"] : "",
    rowid: typeof rowid === "number" || typeof rowid === "string" ? rowid : null,
    data: isRecord(record["data"]) ? record["data"] : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value if it is a plain object, else an empty object. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The value if it is an array, else an empty array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_probe.test.ts && OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck`
Expected: PASS (9 tests), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/fingerprint/graphql_probe.ts test/support/fixtures.ts test/fingerprint_probe.test.ts
git commit -m "feat(fingerprint): GraphQL DataSourceProbe over the existing retrieval helpers"
```

---

### Task 7: The `POST /fingerprint` wire contract (`src/fingerprint/wire.ts`)

Same shape as `src/agents/investigation_wire.ts`: a `.strict()` zod schema and a parse that returns
zod paths for the 400.

**Files:**
- Create: `src/fingerprint/wire.ts`
- Test: `test/fingerprint_wire.test.ts`

- [ ] **Step 1: Write the failing test**

`test/fingerprint_wire.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { MAX_FINGERPRINT_ITEMS, parse_fingerprint_request } from "../src/fingerprint/wire.ts";

describe("parse_fingerprint_request", () => {
  test("accepts the pinned batch shape and preserves order", () => {
    const result = parse_fingerprint_request({
      items: [
        { address: "1104 Spring Run Rd", zip: "40514" },
        { address: "22 Elm St" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items.length).toBe(2);
    expect(result.request.items[0]!.address).toBe("1104 Spring Run Rd");
    expect(result.request.items[0]!.zip).toBe("40514");
    expect(result.request.items[1]!.address).toBe("22 Elm St");
    expect(result.request.items[1]!.zip).toBeNull(); // omitted zip is null, not undefined
  });

  test("accepts an explicit null zip (the backend may send one)", () => {
    const result = parse_fingerprint_request({ items: [{ address: "22 Elm St", zip: null }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.items[0]!.zip).toBeNull();
  });

  test("rejects a missing address, with the zod path", () => {
    const result = parse_fingerprint_request({ items: [{ zip: "40514" }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.startsWith("items.0.address:"))).toBe(true);
  });

  test("rejects an empty address", () => {
    expect(parse_fingerprint_request({ items: [{ address: "" }] }).ok).toBe(false);
  });

  test("rejects unknown keys (strict) at both levels", () => {
    const item = parse_fingerprint_request({ items: [{ address: "a", model: "claude-haiku-4-5" }] });
    expect(item.ok).toBe(false);
    const root = parse_fingerprint_request({ items: [{ address: "a" }], model: "claude-haiku-4-5" });
    expect(root.ok).toBe(false);
  });

  test("rejects an empty batch and one over the cap", () => {
    expect(parse_fingerprint_request({ items: [] }).ok).toBe(false);
    const tooMany = { items: Array.from({ length: MAX_FINGERPRINT_ITEMS + 1 }, () => ({ address: "a" })) };
    expect(parse_fingerprint_request(tooMany).ok).toBe(false);
    const atCap = { items: Array.from({ length: MAX_FINGERPRINT_ITEMS }, () => ({ address: "a" })) };
    expect(parse_fingerprint_request(atCap).ok).toBe(true);
  });

  test("rejects a non-object body with a (root) path", () => {
    const result = parse_fingerprint_request("nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.startsWith("(root):"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_wire.test.ts`
Expected: FAIL — `Cannot find module '../src/fingerprint/wire.ts'`

- [ ] **Step 3: Implementation**

Create `src/fingerprint/wire.ts`:

```ts
// The pinned POST /fingerprint contract. Batch-capable so a 500-scan batch is a handful of round trips
// rather than 500. One response entry per input item, SAME ORDER, so callers zip by index.
//
// `model` is deliberately ABSENT from both directions. The backend keys on its own
// config.investigation.model — the value it already sends in the /investigate body — because it owns
// the model the run actually uses. Reporting one here would let the two drift and key a report on a
// model the run did not use. Do not add one.
import { z } from "zod";

/** Per-request item cap. A larger batch is a 400; callers chunk. */
export const MAX_FINGERPRINT_ITEMS = 100;

export const FingerprintItemSchema = z
  .object({
    address: z.string().min(1),
    zip: z.string().nullish().default(null),
  })
  .strict();
export type FingerprintItem = z.infer<typeof FingerprintItemSchema>;

export const FingerprintRequestSchema = z
  .object({
    items: z.array(FingerprintItemSchema).min(1).max(MAX_FINGERPRINT_ITEMS),
  })
  .strict();
export type FingerprintRequest = z.infer<typeof FingerprintRequestSchema>;

/** One entry per input item, same index. `data: null` is a per-item degradation, never an error. */
export interface FingerprintResponseItem {
  data: string | null;
}

export interface FingerprintResponse {
  engine: string;
  items: FingerprintResponseItem[];
}

export type FingerprintParseResult =
  | { ok: true; request: FingerprintRequest }
  | { ok: false; issues: string[] };

/** Same shape as parse_investigation_request: strict schema, zod paths on the 400. */
export function parse_fingerprint_request(raw: unknown): FingerprintParseResult {
  const result = FingerprintRequestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, request: result.data };
  }
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_wire.test.ts && OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck`
Expected: PASS (7 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fingerprint/wire.ts test/fingerprint_wire.test.ts
git commit -m "feat(fingerprint): strict zod wire contract for POST /fingerprint"
```

---

### Task 8: `POST /fingerprint` in the engine server

`POST /investigate` and `GET /healthz` are untouched — the new route is inserted **between** them and
the `/investigate` 404 guard, so the existing branch is byte-identical.

**Files:**
- Modify: `src/server/investigate_server.ts` (imports; `EngineServerOptions`; `EngineServer`;
  `create_engine_server` body; the router, inserted after the healthz block at line 107)
- Test: `test/fingerprint_endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

`test/fingerprint_endpoint.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import {
  records_fingerprint,
  type DataSourceProbe,
  type NormalizedRecord,
} from "../src/fingerprint/data_source_probe.ts";
import { engine_source_hash } from "../src/fingerprint/source_hash.ts";
import { create_engine_server, type EngineServer } from "../src/server/investigate_server.ts";
import { FixtureGraphQLServer } from "./support/fixture_graphql.ts";
import { probeGraphPayload } from "./support/fixtures.ts";

const TOKEN = "test-engine-token";

/** One record whose content is derived from the address, so every address hashes differently. */
function rowsFor(address: string): NormalizedRecord[] {
  return [{ scope: "address", subject_id: address, source: "base", table: "base", rowid: 1, data: { address } }];
}

/** A probe whose outcome is chosen per address: rows, null, or a throw. */
class ScriptedProbe implements DataSourceProbe {
  constructor(private readonly outcome: (address: string) => "throw" | null | NormalizedRecord[]) {}
  async probe(address: string): Promise<NormalizedRecord[] | null> {
    const result = this.outcome(address);
    if (result === "throw") {
      throw new Error("probe exploded");
    }
    return result;
  }
}

let engine: EngineServer | undefined;
afterEach(async () => {
  if (engine) {
    await engine.stop();
    engine = undefined;
  }
});

async function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return await fetch(`${engine!.url}/fingerprint`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /fingerprint — auth and body", () => {
  test("401 when the bearer token is missing or wrong", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    expect((await post({ items: [{ address: "a" }] }, null)).status).toBe(401);
    expect((await post({ items: [{ address: "a" }] }, "nope")).status).toBe(401);
  });

  test("400 when the body is not valid JSON", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post("{not json");
    expect(res.status).toBe(400);
  });

  test("400 with the zod path when the body fails the strict schema", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post({ items: [{ zip: "40514" }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.some((i: string) => i.startsWith("items.0.address:"))).toBe(true);
  });

  test("404 on the wrong method (the route is POST only)", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await fetch(`${engine.url}/fingerprint`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /fingerprint — the pinned response shape", () => {
  test("one entry per input, SAME ORDER, even when items complete out of order", async () => {
    const probe = new ScriptedProbe((address) => rowsFor(address));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe, fingerprint_batch_concurrency: 4 });
    const addresses = ["a0", "a1", "a2", "a3", "a4", "a5", "a6"];
    const res = await post({ items: addresses.map((address) => ({ address })) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items.length).toBe(addresses.length);
    addresses.forEach((address, index) => {
      expect(body.items[index].data).toBe(records_fingerprint(rowsFor(address)));
    });
  });

  test("`engine` is the process source-tree hash, stable across requests, and carries NO model field", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const first = (await (await post({ items: [{ address: "a" }] })).json()) as any;
    const second = (await (await post({ items: [{ address: "b" }] })).json()) as any;
    expect(first.engine).toBe(engine_source_hash());
    expect(second.engine).toBe(first.engine);
    expect(first.engine).toBe(engine.engine_hash);
    expect(Object.hasOwn(first, "model")).toBe(false);
    expect(Object.keys(first).sort()).toEqual(["engine", "items"]);
    expect(Object.keys(first.items[0])).toEqual(["data"]);
  });

  test("zip is optional per item and both forms are accepted", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe: new ScriptedProbe(rowsFor) });
    const res = await post({ items: [{ address: "a", zip: "40514" }, { address: "b" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.items[0].data).toBe("string");
    expect(typeof body.items[1].data).toBe("string");
  });
});

describe("POST /fingerprint — per-item degradation, never a request failure", () => {
  test("a probe returning null degrades ONLY that item", async () => {
    const probe = new ScriptedProbe((address) => (address === "bad" ? null : rowsFor(address)));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe });
    const res = await post({ items: [{ address: "ok1" }, { address: "bad" }, { address: "ok2" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBe(records_fingerprint(rowsFor("ok1")));
    expect(body.items[1].data).toBeNull();
    expect(body.items[2].data).toBe(records_fingerprint(rowsFor("ok2")));
  });

  test("a probe that THROWS degrades ONLY that item — still 200", async () => {
    const probe = new ScriptedProbe((address) => (address === "boom" ? "throw" : rowsFor(address)));
    engine = create_engine_server({ port: 0, auth_token: TOKEN, probe });
    const res = await post({ items: [{ address: "boom" }, { address: "ok" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBeNull();
    expect(body.items[1].data).toBe(records_fingerprint(rowsFor("ok")));
  });
});

describe("POST /fingerprint — default wiring", () => {
  test("with no injected probe the server reads its OWN configured graph URL", async () => {
    const graph = new FixtureGraphQLServer(probeGraphPayload());
    try {
      engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: graph.url });
      const res = await post({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(typeof body.items[0].data).toBe("string");
      expect(/^[0-9a-f]{64}$/.test(body.items[0].data)).toBe(true);
    } finally {
      graph.close();
    }
  });

  test("with no injected probe and an unreachable graph, every item degrades to null — still 200", async () => {
    engine = create_engine_server({ port: 0, auth_token: TOKEN, graphql_url: "http://127.0.0.1:1/graphql" });
    const res = await post({ items: [{ address: "1104 SPRING RUN RD", zip: "40514" }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.items[0].data).toBeNull();
  });
});
```

> **Landmine (carried from X-014):** Bun 1.3.10's `toMatchObject` with asymmetric matchers mutates the
> received object. Every assertion above uses `toBe` / `toEqual` / `typeof` / `Object.hasOwn` only.
> Keep it that way.

- [ ] **Step 2: Run the test, verify it fails**

Run: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_endpoint.test.ts`
Expected: FAIL — 404 on `/fingerprint`, and TS errors on `probe` / `fingerprint_batch_concurrency` /
`engine.engine_hash` not existing on the options/server types.

- [ ] **Step 3: Implementation**

**3a.** Extend the header comment and imports of `src/server/investigate_server.ts` (lines 1-14):

```ts
// Long-running, stateless HTTP service wrapping investigate_address. Endpoints:
//   POST /investigate  → NDJSON: zero-or-more {"progress"} frames (formatProgressLine, verbatim),
//                        then exactly one terminal {"report"} or {"error"} frame.
//   POST /fingerprint  → {engine, items:[{data}]} — the two engine-owned dimensions of the backend's
//                        AI-report cache key. Deterministic, no LLM. NO model id, by design.
//   GET  /healthz      → 200 once the LLM + graph clients construct, else 503.
// Bun.serve is native — no new dependency. No job store, no persistence.
import { createChatModel } from "../agents/llm.ts";
import { GraphQLHttpTool } from "../agents/graphql_tool.ts";
import { investigate_address, type InvestigationHooks } from "../agents/orchestrator.ts";
import {
  assessment_report_payload,
  formatProgressLine,
  parse_investigation_request,
} from "../agents/investigation_wire.ts";
import type { AgentInvestigationRequest, OccupancyAgentAssessment } from "../agents/models.ts";
import { records_fingerprint, type DataSourceProbe } from "../fingerprint/data_source_probe.ts";
import { GraphQLDataSourceProbe } from "../fingerprint/graphql_probe.ts";
import { engine_source_hash } from "../fingerprint/source_hash.ts";
import {
  parse_fingerprint_request,
  type FingerprintItem,
  type FingerprintResponse,
  type FingerprintResponseItem,
} from "../fingerprint/wire.ts";
```

**3b.** Add three options to `EngineServerOptions` (after `graphql_url`, before `investigate`):

```ts
  probe?: DataSourceProbe; // injection seam for deterministic tests; defaults to the GraphQL adapter
  engine_hash?: string; // injection seam; defaults to the real source-tree hash
  fingerprint_batch_concurrency?: number; // default 4 — graph reads in flight per batch
  investigate?: InvestigationRunner; // injection seam for deterministic tests
```

**3c.** Add `engine_hash` to `EngineServer`:

```ts
export interface EngineServer {
  port: number;
  url: string;
  engine_hash: string; // the source-tree hash this process reports on POST /fingerprint
  stop(): Promise<void>; // graceful: stop accepting, drain in-flight, then close
}
```

**3d.** Add the default constant beside the others (after `DEFAULT_RETRY_AFTER_SECONDS`):

```ts
const DEFAULT_FINGERPRINT_CONCURRENCY = 4;
```

**3e.** In `create_engine_server`, after the `run_investigation` binding and before `const pool = ...`:

```ts
  // Computed ONCE here, at startup, then free for the life of the process (spec §1).
  const engine_hash = opts.engine_hash ?? engine_source_hash();
  // The probe reads THIS engine's configured graph. POST /fingerprint carries no graphql_url, so
  // GRAPHQL_URL must name the same graph the backend sends in its /investigate body — otherwise the
  // fingerprint describes a different dataset than the run reads. See AGENTS.md.
  const probe: DataSourceProbe = opts.probe ?? new GraphQLDataSourceProbe(new GraphQLHttpTool(graphql_url_default));
  const fingerprint_concurrency = Math.max(1, opts.fingerprint_batch_concurrency ?? DEFAULT_FINGERPRINT_CONCURRENCY);

  /** One entry per input, SAME ORDER. Chunked so a batch does not open N graph reads at once. */
  const fingerprint_items = async (items: FingerprintItem[]): Promise<FingerprintResponseItem[]> => {
    const out: FingerprintResponseItem[] = [];
    for (let start = 0; start < items.length; start += fingerprint_concurrency) {
      const chunk = items.slice(start, start + fingerprint_concurrency);
      // Promise.all preserves index order within the chunk, and chunks append in order.
      const settled = await Promise.all(
        chunk.map(async (item): Promise<FingerprintResponseItem> => {
          try {
            const records = await probe.probe(item.address, item.zip ?? "");
            return { data: records === null ? null : records_fingerprint(records) };
          } catch {
            // The port says a probe never throws; a custom adapter that does still costs only its item.
            return { data: null };
          }
        }),
      );
      out.push(...settled);
    }
    return out;
  };
```

**3f.** Insert the route in `fetch`, **between** the healthz block (ends line 107) and the
`/investigate` 404 guard (line 109) — the `/investigate` branch below is untouched:

```ts
      // POST /fingerprint — the backend's cache-key surface. Deterministic, no LLM, outside the
      // investigation concurrency pool (a fingerprint must never starve an investigation of a permit).
      if (req.method === "POST" && url.pathname === "/fingerprint") {
        // Draining first, mirroring /investigate. A 503 here is just a cache miss: the backend fails
        // closed on any non-200 and the investigation runs exactly as it does today.
        if (!accepting) {
          return json_response({ error: { message: "server shutting down" } }, 503, { "retry-after": retry_after });
        }
        if ((req.headers.get("authorization") ?? "") !== `Bearer ${auth_token}`) {
          return json_response({ error: { message: "unauthorized" } }, 401);
        }
        let raw_fingerprint: unknown;
        try {
          raw_fingerprint = await req.json();
        } catch {
          return json_response({ error: { message: "request body is not valid JSON" } }, 400);
        }
        const parsed_fingerprint = parse_fingerprint_request(raw_fingerprint);
        if (!parsed_fingerprint.ok) {
          return json_response(
            { error: { message: "request body failed validation", issues: parsed_fingerprint.issues } },
            400,
          );
        }
        // From here the response is ALWAYS 200: a per-item probe failure degrades that item to
        // {data: null}. One bad address in a 500-scan batch costs that scan its lookup, nothing more.
        const body: FingerprintResponse = {
          engine: engine_hash,
          items: await fingerprint_items(parsed_fingerprint.request.items),
        };
        return json_response(body, 200);
      }
```

**3g.** Return `engine_hash` from `create_engine_server` (last statement):

```ts
  return { port: bound_port, url: `http://127.0.0.1:${bound_port}`, engine_hash, stop };
```

- [ ] **Step 4: Run the tests, verify they pass — and that `/investigate` is unchanged**

Run:
```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun test test/fingerprint_endpoint.test.ts test/http_service.test.ts test/fake_engine_server.test.ts
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run typecheck
```
Expected: fingerprint_endpoint 11 pass; **http_service 8 pass / 0 fail unchanged**; e2e 6 pass / 0 fail;
typecheck clean.

- [ ] **Step 5: Confirm the `/investigate` branch is untouched by inspection**

Run: `git diff main -- src/server/investigate_server.ts | grep -E '^[-+]' | grep -iE 'investigate\b' | head -20`
Expected: only added lines (the new header comment lines and the `investigate_address` /
`parse_investigation_request` imports being re-listed unchanged). **No `-` line inside the
`/investigate` handler body.** If any appears, revert it — that path is byte-frozen.

- [ ] **Step 6: Commit**

```bash
git add src/server/investigate_server.ts test/fingerprint_endpoint.test.ts
git commit -m "feat(server): POST /fingerprint — batch-capable, bearer-auth, per-item degradation"
```

---

### Task 9: Make the graph-URL coupling observable at startup

`cli/serve.ts` currently prints only the port. Print the engine hash and the graph URL too, so an
operator can check, after any deploy, that the engine is fingerprinting the same graph the backend
names — carry-point (a). The existing prefix is preserved verbatim (PROGRESS.md records a smoke test
that greps for it).

**Files:**
- Modify: `cli/serve.ts:16-29`

- [ ] **Step 1: Edit `cli/serve.ts`'s `main()`**

```ts
function main(): void {
  loadDotenv();
  // Resolved here (rather than defaulted inside the server) so the startup line can print exactly the
  // graph the fingerprint probe will read.
  const graphql_url = process.env.GRAPHQL_URL ?? "http://graphql:8000/graphql";
  const server = create_engine_server({
    port: intEnv("ENGINE_PORT", intEnv("PORT", 8787)),
    auth_token: process.env.ENGINE_AUTH_TOKEN ?? "",
    max_concurrency: intEnv("ENGINE_MAX_CONCURRENCY", 4),
    request_timeout_ms: intEnv("ENGINE_REQUEST_TIMEOUT_MS", 300_000),
    shutdown_drain_ms: intEnv("ENGINE_SHUTDOWN_DRAIN_MS", 300_000),
    graphql_url,
  });
  const shutdown = () => {
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // engine=<hash> is what POST /fingerprint reports; graph=<url> is what its probe reads. The graph
  // MUST match the graphql_url the backend sends in /investigate — see AGENTS.md.
  process.stdout.write(
    `engine service listening on :${server.port} (engine=${server.engine_hash.slice(0, 12)} graph=${graphql_url})\n`,
  );
}
```

- [ ] **Step 2: Smoke it**

Run:
```bash
ENGINE_AUTH_TOKEN=t GRAPHQL_URL=http://127.0.0.1:8000/graphql ENGINE_PORT=8791 timeout 5 bun run serve
```
Expected: prints `engine service listening on :8791 (engine=<12 hex chars> graph=http://127.0.0.1:8000/graphql)`
then exits on the timeout. (No graph or API key needed — nothing is read until a request arrives.)

- [ ] **Step 3: Commit**

```bash
git add cli/serve.ts
git commit -m "feat(serve): print the engine hash and the graph URL the probe reads at startup"
```

---

### Task 10: Document the endpoint and the ops rule in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md` (verification section + a new section after "Observability")

- [ ] **Step 1: Add the true-baseline note to "Verification commands"**

Replace the closing line of that block so it reads:

```
    bun run typecheck   # tsc --noEmit
    bun run lint        # biome check .
    bun test            # unit + deterministic E2E (no API, no live server)
    bun run e2e         # focused: just the E2E suite
    bun run verify      # typecheck + lint + bun test  (bun test already includes E2E)

**True baseline.** The gitignored `.env` sets `OE_PROSE_REGISTER=on` and `OE_PROSE_REDACT=on`, and
Bun AUTO-LOADS `.env` (`env -u` does not clear it). A bare `bun run verify` therefore shows 2
pre-existing failures that assert those flags are off, i.e. fail by construction. Always gate with:

    OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
```

- [ ] **Step 2: Add the fingerprint section (after "Observability", before "Refreshing the E2E fixture")**

```md
## The fingerprint endpoint (the backend's cache-key surface)

`POST /fingerprint` — bearer auth, same `ENGINE_AUTH_TOKEN` as `/investigate`:

    { "items": [{ "address": "1104 Spring Run Rd", "zip": "40514" }, { "address": "22 Elm St" }] }
      -> 200 { "engine": "<sha256 of src/**, cli/**, package.json, bun.lock>",
               "items": [{ "data": "<sha256 of the normalized record projection>" }, { "data": null }] }

- **One entry per input, SAME ORDER** — callers zip by index. `data: null` is a per-item degradation
  (unresolvable address, or the probe's read failed) and is **never** a whole-request failure.
  401 on a bad/missing bearer; 400 on a malformed body.
- **No model id is reported, by design.** The backend keys on its own `config.investigation.model` —
  the value it already sends in the `/investigate` body — because it owns the model the run actually
  uses. An engine-reported model could drift from it and key a report on a model the run did not use.
  Do not add `ENGINE_MODEL`, a `configured_model_id` helper, or a model field to this response.
- **OPS RULE, load-bearing: `GRAPHQL_URL` on this engine must name the same graph the backend sends
  as `graphql_url` in its `/investigate` body.** `/fingerprint` carries no `graphql_url` — the probe
  reads this process's own configured graph. If the two differ, the fingerprint describes a different
  dataset than the investigation reads, and the cache can serve a report computed over data the run
  never saw. `bun run serve` prints both the engine hash and the graph URL at startup; check them
  against the backend's engine config after any deploy on either side.
- An engine deploy changes `engine` and drains the cache. Intended: over-invalidation costs a rerun,
  under-invalidation serves a wrong report.
- **`services/graph` gets no change, now or ever, for this feature** — the fingerprint is a *read*.
  The hash is taken over the engine's own normalized projection (`src/fingerprint/data_source_probe.ts`),
  not the source's wire format, so swapping in the partner endpoint is one new `DataSourceProbe`.
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): POST /fingerprint contract, the graph-URL ops rule, and the true gate baseline"
```

---

### Task 11: Full gates, `feature_list.json` → `passing`, `PROGRESS.md` session record

**Files:**
- Modify: `feature_list.json`, `PROGRESS.md`

- [ ] **Step 1: Run the full gates and capture the real output**

```bash
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e
bun test    # the .env-default run, to confirm ONLY the 2 pre-existing tautological failures remain
```

Expected: verify green — typecheck clean, lint **0 errors** (3 pre-existing warnings), pass count =
Task 1's baseline **+ 54** new tests (canonical_json 8, source_hash 7, address_resolution 3,
fingerprint_records 7, fingerprint_probe 9, fingerprint_wire 7, fingerprint_endpoint 11, plus the
existing `feature_list` guard re-run) across 7 new files; `bun run e2e` **6 pass / 0 fail** (unchanged
— this feature adds no E2E); the bare `bun test` run shows exactly 2 failures, both the pre-existing
flag-default tests.

If lint reports new warnings/errors, fix them with `bun run lint:fix` and re-run; do not leave the
count above 3 warnings / 0 errors.

- [ ] **Step 2: Flip the feature entry to `passing` with real evidence**

In `feature_list.json`, set `"status": "passing"` on `fingerprint-endpoint` and fill `evidence` with
the **actual** numbers from Step 1, in the house format, e.g.:

```
OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify: typecheck clean, lint 0 errors (3 pre-existing warnings), <N> pass / 0 fail / <E> expect() across <F> files (baseline before this work at main <sha>: <B> pass / 0 fail). New tests: canonical_json (8), source_hash (7), address_resolution (3), fingerprint_records (7), fingerprint_probe (9), fingerprint_wire (7), fingerprint_endpoint (11). OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e: 6 pass / 0 fail (unchanged — the investigation path is byte-frozen). Under the gitignored .env, bun test = <N-2> pass / 2 fail, the 2 being the PRE-EXISTING tautological flag-default tests. Live smoke: ENGINE_AUTH_TOKEN=t GRAPHQL_URL=... bun run serve prints "engine service listening on :8791 (engine=<hex12> graph=...)".
```

- [ ] **Step 3: Append the `PROGRESS.md` Session Record (newest first, directly under `## Session Record`)**

```md
### 2026-07-27 — POST /fingerprint: engine half of the AI job result cache (X-015)
- **Goal:** Expose the two engine-owned dimensions of the backend's AI-report cache key — a source-tree hash of this engine and a per-address hash of the graph data this engine reads — behind one new endpoint, without touching POST /investigate, agent behaviour, or services/graph.
- **Completed (branch `feat/fingerprint-endpoint`, cut from `main` @5e8e15f):**
  - **T2** `src/fingerprint/canonical.ts` — the canonicalJson/sha256Hex extracted out of query_cache.ts so there is exactly ONE canonicalizer; query_cache re-pointed at it (coalescing pinned by a test).
  - **T3** `src/fingerprint/source_hash.ts` — sha256 over sorted `relpath\0sha256(content)` for `src/**`, `cli/**`, `package.json`, `bun.lock`, computed once and cached for the process. Whole-tree walk, no curated list; `.git` is dockerignored so no build SHA exists at runtime. A test asserts `.dockerignore` excludes none of the hashed roots.
  - **T4** `resolve_subject_address` / `resolved_address_id` extracted out of `AgentOrchestrator.preflight` — same two queries, same order, same result_summary strings, so `preflight_queries` is byte-identical. The probe and preflight now share ONE resolution path; the equivalence is pinned by `test/address_resolution.test.ts` against the real preflight over three fixtures.
  - **T5/T6** `DataSourceProbe` port + `NormalizedRecord` + order-independent `records_fingerprint`, and the GraphQL adapter over the EXISTING retrieval helpers (`fetch_address_records_multi`, `fetch_people_at_address`, `fetch_person_records`). Deterministic, no LLM, ≤8 queries. Any `ok !== true` from a helper aborts to `null` rather than hashing an error string.
  - **T7/T8** strict zod wire contract + `POST /fingerprint` on the existing Bun.serve router: 401 / 400 / 200-with-per-item-`data: null`, batch-capable (cap 100), chunked at 4 concurrent reads, outside the investigation permit pool.
  - **T9/T10** startup line now prints `engine=<hash12> graph=<url>`; AGENTS.md carries the contract, the model-absence rationale, and the graph-URL ops rule.
- **Verification run:** `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify`; `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e`; bare `bun test` (to confirm only the 2 pre-existing tautological failures); `bun run serve` smoke.
- **Evidence:** <paste the exact counts from Step 1>
- **Known consequences (decisions of record, not bugs):** (1) **No model id in the response, deliberately** — the backend keys on its own `config.investigation.model`, the value it already sends in `/investigate`; sourcing it here would let the two drift and key a report on a model the run did not use. (2) **`GRAPHQL_URL` on this engine MUST equal the `graphql_url` the backend sends** — `/fingerprint` carries none, so a mismatch means the fingerprint describes a different dataset than the run reads. Printed at startup; written into AGENTS.md. (3) **Accepted coverage gap** (spec §1): the probe covers the subject address plus one hop of ≤5 persons with per-source row limits; deeper reads and rows past the limit are not fingerprinted. `maxAgeDays` (backend) is the valve; read-set replay is the complete fix. (4) `summary` is dropped from each record — it is a rendering of the same `data`. (5) An engine deploy drains the cache; intended.
- **Risks:** none open. `services/graph` untouched (zero diff); the `/investigate` handler body is byte-identical to `main` (checked with `git diff`), and `bun run e2e` stayed 6/0 across the preflight extraction.
- **Next best action:** open the PR against `main`; after merge, bump the backend's engine submodule pointer and run the live end-to-end (second identical `POST /ai-report` served from cache with zero engine invocations; changed-listing control forces a rerun; dead-`/fingerprint` control still completes with `cache_key = NULL`).
```

- [ ] **Step 4: Commit**

```bash
git add feature_list.json PROGRESS.md
git commit -m "docs(progress): record the X-015 engine half (POST /fingerprint) session"
```

---

### Task 12: Open the PR against `main`

- [ ] **Step 1: Confirm a clean tree and no submodule drift**

```bash
git status --porcelain            # expected: empty
git diff --stat main -- services/graph   # expected: empty — the graph service gets ZERO changes
git diff --stat main
```
Expected: `services/graph` untouched; changed files are exactly
`AGENTS.md`, `PROGRESS.md`, `feature_list.json`, `cli/serve.ts`, `src/agents/orchestrator.ts`,
`src/agents/query_cache.ts`, `src/server/investigate_server.ts`, `src/fingerprint/*` (5 new),
`test/support/fixtures.ts`, and the 7 new test files.

- [ ] **Step 2: Push and open the PR — base `main`**

```bash
git push -u origin feat/fingerprint-endpoint
gh pr create --base main --head feat/fingerprint-endpoint \
  --title "feat(server): POST /fingerprint — engine half of the AI job result cache (X-015)" \
  --body "$(cat <<'EOF'
Engine half of X-015. Implements the pinned contract in the workspace umbrella plan
(`../../../../docs/superpowers/plans/2026-07-27-ai-job-result-cache.md`) exactly.

**New:** `POST /fingerprint` (bearer auth, batch-capable) → `{engine, items:[{data}]}`, one entry per
input in the same order. `engine` is a source-tree hash over `src/**`, `cli/**`, `package.json`,
`bun.lock`, computed once at startup. Each `data` is a sha256 over the engine's own normalized record
projection for that address — resolved by the SAME code `AgentOrchestrator.preflight` uses, read
through the SAME `retrieval.ts` helpers the agents use. No LLM.

**Failure semantics:** 401 bad/missing bearer · 400 malformed body · **200 with that item's
`data: null`** when an address is unresolvable or its probe fails — never a whole-request failure.

**No model id is reported, by design.** The backend keys on its own `config.investigation.model` —
the value it already sends in the `/investigate` body — because it owns the model the run uses.
Sourcing it here would let the two drift and key a report on a model the run did not use.

**Ops rule (load-bearing):** the engine's `GRAPHQL_URL` must name the same graph the backend sends as
`graphql_url` in `/investigate`; `/fingerprint` carries none. `bun run serve` now prints both the
engine hash and the graph URL at startup. Documented in `AGENTS.md`.

**Untouched:** `POST /investigate` (handler body byte-identical; `bun run e2e` 6/0 across the
behaviour-preserving preflight extraction) and `services/graph` (zero diff — the fingerprint is a read).

Gates: `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` green (the gitignored `.env` sets
both prose flags on, so a bare run shows 2 pre-existing tautological failures).
EOF
)"
```

---

## Verification / Definition of Done

- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run verify` green — typecheck clean, lint **0
      errors** (3 pre-existing warnings), pass count = Task 1 baseline + 52 new assertions' tests,
      **0 fail**. (A bare `bun run verify` shows 2 pre-existing tautological failures because Bun
      auto-loads the gitignored `.env`; that is not a regression.)
- [ ] `OE_PROSE_REDACT=off OE_PROSE_REGISTER=off bun run e2e` still **6 pass / 0 fail** — the
      investigation path is byte-frozen through the preflight extraction.
- [ ] Spec §7 "Engine" coverage, each pinned by a named test:
      - **Probe determinism** — same address twice → same hash; a changed source row → different
        hash; an unresolvable address → `null`, not a throw (`test/fingerprint_probe.test.ts`).
      - **Source-tree hash** — stable across restarts of an unchanged tree; changes when any hashed
        file changes; unaffected by files outside the hashed set (`test/source_hash.test.ts`).
      - **`POST /fingerprint`** — 401 without the bearer; the batch form returns one entry per input
        in order; a probe failure degrades that entry to `data: null` rather than failing the request
        (`test/fingerprint_endpoint.test.ts`).
- [ ] **Contract conformance:** the response body has exactly the keys `engine` and `items`, each
      item exactly `data`, and **no `model`** — asserted, not assumed.
- [ ] **Probe ≡ investigation:** the probe's subject address id equals the id the real
      `AgentOrchestrator.preflight` resolves, over the real 1104 fixture
      (`test/fingerprint_probe.test.ts` + `test/address_resolution.test.ts`).
- [ ] `git diff --stat main -- services/graph` is **empty**; the `/investigate` handler body has no
      removed lines vs `main`.
- [ ] `feature_list.json` `fingerprint-endpoint` is `passing` with real recorded evidence;
      `PROGRESS.md` has the Session Record; `git status` clean.
- [ ] PR opened with base **`main`** (`scripts/repo-branch.sh engine` → `main`); merged to `main`;
      no stray worktrees.
- [ ] **Deferred to the coordinator (needs both halves running, per the umbrella DoD):** bump the
      backend's engine submodule pointer after merge, then the live end-to-end — identical second
      `POST /ai-report` served from cache with **zero engine investigation invocations**; a
      changed-listing control forcing a rerun; and a fail-closed control (engine `/fingerprint` down)
      that still completes with `cache_key = NULL`. Also confirm the engine's `GRAPHQL_URL` matches
      the backend's `graphql_url` in the deployed environment before trusting a hit.

---

### Critical Files for Implementation

- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/server/investigate_server.ts`
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/orchestrator.ts`
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/retrieval.ts`
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/src/agents/query_cache.ts`
- `/home/aayan-alam/Work/Helcion/true-occupancy-workspace/occupancy-engine-ts/test/support/fixtures.ts`