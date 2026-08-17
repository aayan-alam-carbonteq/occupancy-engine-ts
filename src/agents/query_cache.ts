// Single-flight call cache: concurrent identical data-service calls are coalesced by storing the
// in-flight Promise in a Map before yielding control. Because everything between the cache checks
// and the `_inflight.set(...)` is synchronous (no `await`), concurrent callers that arrive while a
// call is running observe the in-flight Promise and await it instead of re-executing. Errors are
// not cached.
//
// HOW THE IMPORT WENT MISSING, and why the shape of it matters more than the fix.
//
// 392466a extracted canonicalJson to fingerprint/canonical.ts and ADDED this import correctly. It
// was lost later, in a revert pair: 494aeb3 ("Revert X-016") restored the inline copy, then 9b3e901
// ("Revert the Revert") re-applied the typed-service rename (query->operation, variables->params)
// and deleted the inline definition WITHOUT re-adding the import. Neither side of that resolution
// was wrong on its own; combining a deletion from one with a rename from the other produced a file
// referencing a symbol nothing brought in. Grepping for the extraction commit blames the wrong
// change — the failure lives in the merge resolution.
//
// WHAT IT COST. Not "the cache was slower". cacheKey runs at the top of get_or_execute, BEFORE the
// factory, so every call through a cache-bearing client threw ReferenceError before any HTTP
// request was made. Only heuristic workers get a cache (orchestrator.ts, `cache: query_cache`);
// preflight's client is built without one. So the heuristic workers retrieved NOTHING, and the two
// data calls a broken run still recorded were preflight's. Any benchmark taken between 9b3e901 and
// this commit measured heuristics reasoning over zero retrieved data.
//
// tsc reported it the whole time. The error sat among the pre-existing failures in the dead
// GraphQL-era test files, so the red gate hid it — as did the callers, which re-throw
// non-DataClientError without logging.
import { canonicalJson } from "../fingerprint/canonical.ts";

function cacheKey(operation: string, params: Record<string, unknown> | null | undefined): string {
  return operation.trim() + "\x00" + canonicalJson(params ?? {});
}

/**
 * Per-investigation single-flight + result cache for READ-ONLY data-service calls.
 *
 * Keyed by `(operation, params)` — the typed operation name plus its canonicalized arguments, which
 * is what `CountingDataClient` passes. Coalesces identical concurrent calls into one execution and
 * caches results for the investigation's lifetime (the partner corpus is read-only during a run —
 * the service holds guest credentials). Errors are NOT cached. Cached results are treated as
 * read-only by all consumers.
 */
export class QueryCache {
  private readonly _results = new Map<string, unknown>();
  private readonly _inflight = new Map<string, Promise<unknown>>();
  hits = 0; // served from completed cache
  coalesced = 0; // awaited an in-flight identical execution
  executed = 0; // actually ran the factory

  async get_or_execute(
    operation: string,
    params: Record<string, unknown> | null | undefined,
    factory: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    const key = cacheKey(operation, params);
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
