// Port of occupancy_engine/agents/tracing.py.
import { randomUUID } from "node:crypto";
import type { RunnableConfig } from "@langchain/core/runnables";
import { LocalMetricsCallbackHandler, currentRecorder } from "../observability/index.ts";

export interface TraceConfig {
  enabled: boolean;
  project: string | null;
  metadata: Record<string, string>;
}

export class InvestigationTrace {
  constructor(
    public readonly investigation_id: string,
    public readonly thread_id: string,
    public readonly address_key: string,
    public readonly address: string,
    public readonly zip: string,
  ) {}

  get metadata(): Record<string, string> {
    return {
      investigation_id: this.investigation_id,
      trace_group_id: this.investigation_id,
      thread_id: this.thread_id,
      session_id: this.thread_id,
      address_key: this.address_key,
      address: this.address,
      zip: this.zip,
    };
  }
}

export function traceConfig(metadata: Record<string, string> | null = null): TraceConfig {
  const raw = (process.env.LANGSMITH_TRACING ?? "").toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "yes";
  return {
    enabled,
    project: process.env.LANGSMITH_PROJECT ?? null,
    metadata: metadata ?? {},
  };
}

export function makeInvestigationTrace(
  address: string,
  zipCode = "",
  traceId: string | null = null,
): InvestigationTrace {
  const addressKey = addressKeyOf(address, zipCode);
  let investigationId: string;
  if (traceId) {
    investigationId = slug(traceId);
  } else {
    const stamp = utcStamp(new Date());
    investigationId = `${addressKey}-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }
  return new InvestigationTrace(
    investigationId,
    `investigation:${investigationId}`,
    addressKey,
    address,
    zipCode,
  );
}

/**
 * Build a LangChain RunnableConfig carrying the trace tags/metadata (which flow to LangSmith) and,
 * when the current recorder is enabled, the local metrics callback.
 *
 * PORT NOTE: Python emits the key `run_name`; LangChain.js reads `runName` — mapped accordingly so
 * the run name actually reaches the tracer. Everything else (merged metadata, ls_provider /
 * ls_model_name aliases, tag set) is preserved verbatim.
 */
export function runnableConfig(
  name: string,
  metadata: Record<string, unknown> | null = null,
  tags: string[] | null = null,
  trace: InvestigationTrace | Record<string, string> | null = null,
): RunnableConfig {
  const mergedMetadata: Record<string, string> = {};
  if (trace !== null) {
    if (trace instanceof InvestigationTrace) {
      Object.assign(mergedMetadata, trace.metadata);
    } else {
      for (const [key, value] of Object.entries(trace)) {
        if (value !== null && value !== undefined) {
          mergedMetadata[String(key)] = String(value);
        }
      }
    }
  }
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== null && value !== undefined) {
        mergedMetadata[String(key)] = String(value);
      }
    }
  }
  const provider = mergedMetadata["provider"];
  if (provider && !("ls_provider" in mergedMetadata)) {
    mergedMetadata["ls_provider"] = provider;
  }
  const model = mergedMetadata["model"];
  if (model && !("ls_model_name" in mergedMetadata)) {
    mergedMetadata["ls_model_name"] = model;
  }
  const runTags = ["occupancy-engine", "agent-network"];
  if (tags) {
    runTags.push(...tags);
  }
  const investigationId = mergedMetadata["investigation_id"];
  if (investigationId) {
    runTags.push(`investigation:${investigationId}`);
  }
  const addressKey = mergedMetadata["address_key"];
  if (addressKey) {
    runTags.push(`address:${addressKey}`);
  }
  const config: RunnableConfig = {
    runName: name,
    metadata: mergedMetadata,
    tags: [...new Set(runTags)].sort(),
  };
  const recorder = currentRecorder();
  if (recorder.enabled) {
    config.callbacks = [new LocalMetricsCallbackHandler(recorder)];
  }
  return config;
}

function addressKeyOf(address: string, zipCode: string): string {
  const parts = [slug(address)];
  if (zipCode) {
    parts.push(slug(zipCode));
  }
  return parts.filter((part) => part).join("-") || "unknown-address";
}

function slug(value: string): string {
  const s = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 80) || "unknown";
}

function utcStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}
