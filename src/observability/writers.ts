// Port of occupancy_engine/observability/writers.py (single-run functions).
// PORT NOTE: write_batch_rollups + the observability/summaries aggregations are batch-CLI only and are
// deferred to the batch-CLI porting wave. The single-address run path (write_run_metrics /
// write_events_jsonl) is complete here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MetricEvent, RunMetricsSummary } from "./models.ts";

/** Base output path is the run JSON path; sidecars replace its extension (Python .with_suffix). */
function withSuffix(basePath: string, suffix: string): string {
  // Python Path.with_suffix replaces the final ".ext" with the given suffix.
  const idx = basePath.lastIndexOf(".");
  const stem = idx > basePath.lastIndexOf("/") ? basePath.slice(0, idx) : basePath;
  return stem + suffix;
}

export function writeRunMetrics(baseOutputPath: string, events: MetricEvent[], summary: RunMetricsSummary): void {
  writeEventsJsonl(withSuffix(baseOutputPath, ".metrics.events.jsonl"), events);
  const summaryPath = withSuffix(baseOutputPath, ".metrics.summary.json");
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", { encoding: "utf-8" });
}

export function writeEventsJsonl(path: string, events: MetricEvent[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  writeFileSync(path, events.length > 0 ? lines + "\n" : "", { encoding: "utf-8" });
}

export function readEventsJsonl(path: string): MetricEvent[] {
  if (!existsSync(path)) {
    return [];
  }
  const events: MetricEvent[] = [];
  for (const line of readFileSync(path, { encoding: "utf-8" }).split(/\r?\n/)) {
    const text = line.trim();
    if (text) {
      events.push(JSON.parse(text) as MetricEvent);
    }
  }
  return events;
}
