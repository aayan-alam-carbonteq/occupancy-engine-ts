// Port of occupancy_engine/agents/query_cache.py.
//
// PORT NOTE (single-flight): Python coalesces concurrent identical queries using an asyncio.Future
// registered in `_inflight` before any `await`. The JS equivalent stores the in-flight Promise in a
// Map, again before yielding control. Because everything between the cache checks and the
// `_inflight.set(...)` is synchronous (no `await`), concurrent callers that arrive while a query is
// running observe the in-flight Promise and await it instead of re-executing. Errors are not cached.

function cacheKey(query: string, variables: Record<string, unknown> | null | undefined): string {
  return query.trim() + "\x00" + canonicalJson(variables ?? {});
}

// Deterministic, sorted-key JSON used only as an internal cache identity (mirrors Python's
// json.dumps(..., sort_keys=True); exact byte-parity with Python is not required because the key
// never leaves the TS process).
function canonicalJson(value: unknown): string {
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

/**
 * Per-investigation single-flight + result cache for READ-ONLY GraphQL queries.
 *
 * Coalesces identical concurrent queries into one execution and caches results for the
 * investigation's lifetime (the graph DB is read-only during a run). Errors are NOT cached.
 * Cached results are treated as read-only by all consumers.
 */
export class QueryCache {
  private readonly _results = new Map<string, unknown>();
  private readonly _inflight = new Map<string, Promise<unknown>>();
  hits = 0; // served from completed cache
  coalesced = 0; // awaited an in-flight identical execution
  executed = 0; // actually ran the factory

  async get_or_execute(
    query: string,
    variables: Record<string, unknown> | null | undefined,
    factory: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    const key = cacheKey(query, variables);
    if (this._results.has(key)) {
      this.hits += 1;
      return this._results.get(key);
    }
    const inflight = this._inflight.get(key);
    if (inflight !== undefined) {
      this.coalesced += 1;
      return await inflight; // await the single in-flight execution (result or exception)
    }
    // No `await` between the checks above and this line -> atomic on the JS event loop.
    this.executed += 1;
    const promise = (async () => factory())();
    this._inflight.set(key, promise);
    try {
      const result = await promise;
      this._results.set(key, result);
      this._inflight.delete(key);
      return result;
    } catch (exc) {
      this._inflight.delete(key);
      throw exc; // errors are not cached; a retry will re-execute
    }
  }
}
