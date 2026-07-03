// A small, self-contained bridge from LangChain's LLM lifecycle callbacks into the local
// MetricsRecorder. observability/index.ts re-exports LocalMetricsCallbackHandler and agents/tracing.ts
// attaches it in runnableConfig.
//
// LangChain's callbacks are camelCase `handle*` hooks (run ids arrive as strings, not UUIDs;
// metadata/tags are positional): handleChatModelStart / handleLLMStart / handleLLMEnd / handleLLMError.
// There is no retry callback, so the record_counter("langchain_retry") path has no faithful hook and
// is intentionally omitted (SDK retries stay internal).
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { performance } from "node:perf_hooks";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import { extractUsage } from "./usage.ts";
import type { TokenUsage } from "./models.ts";
import type { AnyMetricsRecorder } from "./recorder.ts";

export class LocalMetricsCallbackHandler extends BaseCallbackHandler {
  name = "LocalMetricsCallbackHandler";
  private readonly recorder: AnyMetricsRecorder;
  private readonly _starts = new Map<string, number>();
  private readonly _metadata = new Map<string, Record<string, unknown>>();

  constructor(recorder: AnyMetricsRecorder) {
    super();
    this.recorder = recorder;
  }

  override handleChatModelStart(
    _llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runName?: string,
  ): void {
    this._starts.set(runId, performance.now());
    const meta: Record<string, unknown> = { ...(metadata ?? {}) };
    meta["message_batches"] = messages.length;
    meta["message_count"] = messages.reduce((acc, batch) => acc + batch.length, 0);
    meta["tags"] = [...(tags ?? [])];
    this._metadata.set(runId, meta);
  }

  override handleLLMStart(
    _llm: Serialized,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runName?: string,
  ): void {
    this._starts.set(runId, performance.now());
    const meta: Record<string, unknown> = { ...(metadata ?? {}) };
    meta["prompt_count"] = prompts.length;
    meta["tags"] = [...(tags ?? [])];
    this._metadata.set(runId, meta);
  }

  override handleLLMEnd(
    output: LLMResult,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    _extraParams?: Record<string, unknown>,
  ): void {
    const meta = { ...(this._metadata.get(runId) ?? {}) };
    this._metadata.delete(runId);
    if (!("tags" in meta)) {
      meta["tags"] = [...(tags ?? [])];
    }
    let usage: TokenUsage | null = null;
    const generations = (output as { generations?: unknown }).generations;
    if (Array.isArray(generations) && generations.length > 0) {
      const first = generations[0];
      if (Array.isArray(first) && first.length > 0) {
        const generation = first[0] as { message?: unknown };
        const message = generation?.message;
        if (message !== null && message !== undefined) {
          usage = extractUsage(message);
        }
      }
    }
    const start = this._starts.get(runId);
    this._starts.delete(runId);
    this.recorder.record_llm_call({
      phase: (meta["phase"] as string | undefined) || phaseFromTags(tags ?? []),
      agent_id: (meta["agent_id"] as string | undefined) || agentFromTags(tags ?? []),
      heuristic_id: (meta["heuristic_id"] as string | undefined) || "",
      name: (meta["run_name"] as string | undefined) || "llm_call",
      usage,
      latency_ms: latencyMs(start),
      metadata: meta,
      langchain_run_id: runId,
      langchain_parent_run_id: parentRunId ?? "",
    });
  }

  override handleLLMError(
    err: Error,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    _extraParams?: Record<string, unknown>,
  ): void {
    const meta = { ...(this._metadata.get(runId) ?? {}) };
    this._metadata.delete(runId);
    if (!("tags" in meta)) {
      meta["tags"] = [...(tags ?? [])];
    }
    const start = this._starts.get(runId);
    this._starts.delete(runId);
    this.recorder.record_llm_call({
      phase: (meta["phase"] as string | undefined) || phaseFromTags(tags ?? []),
      agent_id: (meta["agent_id"] as string | undefined) || agentFromTags(tags ?? []),
      heuristic_id: (meta["heuristic_id"] as string | undefined) || "",
      name: (meta["run_name"] as string | undefined) || "llm_call",
      latency_ms: latencyMs(start),
      error: err,
      metadata: meta,
      langchain_run_id: runId,
      langchain_parent_run_id: parentRunId ?? "",
    });
  }
}

function latencyMs(startMs: number | undefined): number | null {
  if (startMs === undefined) {
    return null;
  }
  return Math.round((performance.now() - startMs) * 1000) / 1000;
}

function phaseFromTags(tags: string[]): string {
  for (const tag of tags) {
    if (tag === "master-planner" || tag === "master-adjudicator") {
      return tag.replace(/-/g, "_");
    }
    if (tag === "heuristic-llm") {
      return "heuristic_llm_turn";
    }
  }
  return "llm";
}

function agentFromTags(tags: string[]): string {
  for (const tag of tags) {
    if (tag === "master-planner") {
      return "master_planner";
    }
    if (tag === "master-adjudicator") {
      return "master_adjudicator";
    }
    if (tag.startsWith("heuristic:")) {
      return tag;
    }
  }
  return "llm";
}
