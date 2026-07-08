// Run the agent network for one address.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadDotenv } from "../src/env.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";
import { investigate_address } from "../src/agents/orchestrator.ts";
import type { MetricEvent, RunMetricsSummary } from "../src/observability/models.ts";
import { writeRunMetrics } from "../src/observability/writers.ts";

export function resolveGraphqlUrl(flag: string | undefined, env: string | undefined): string | undefined {
  return flag ?? env ?? undefined;
}

/** One `--progress` NDJSON line for a metric event (see EngineProgressLine consumers). */
export function formatProgressLine(event: MetricEvent): string {
  const launched = event.metadata["launched_subagents"];
  return JSON.stringify({
    progress: {
      event_type: event.event_type,
      phase: event.phase,
      agent_id: event.agent_id,
      heuristic_id: event.heuristic_id,
      name: event.name,
      status: event.status,
      ...(typeof launched === "number" ? { count: launched } : {}),
    },
  });
}

async function main(argv: string[]): Promise<number> {
  loadDotenv();
  const { values } = parseArgs({
    args: argv,
    options: {
      address: { type: "string" },
      zip: { type: "string", default: "" },
      "graphql-url": { type: "string" },
      provider: { type: "string", default: "auto" },
      model: { type: "string" },
      "base-url": { type: "string" },
      "allow-heuristic": { type: "string", multiple: true },
      "block-heuristic": { type: "string", multiple: true, default: [] },
      "max-concurrency": { type: "string", default: "8" },
      "max-graphql-calls-per-agent": { type: "string", default: "8" },
      "graphql-timeout-seconds": { type: "string", default: "30" },
      "agent-timeout-seconds": { type: "string", default: "120" },
      "max-output-retries": { type: "string", default: "2" },
      "max-query-repair-attempts": { type: "string", default: "3" },
      "schema-tool-budget": { type: "string", default: "8" },
      "disable-master-planning": { type: "boolean", default: true },
      "enable-master-planning": { type: "boolean", default: false },
      "prompt-profile": { type: "string", default: "compact" },
      "retrieval-mode": { type: "string", default: "tools" },
      "include-shortcuts": { type: "boolean", default: false },
      "metrics-debug-payloads": { type: "boolean", default: false },
      "batch-id": { type: "string" },
      "trace-id": { type: "string" },
      progress: { type: "boolean", default: false },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const graphqlUrl = resolveGraphqlUrl(values["graphql-url"], process.env.GRAPHQL_URL);

  if (!values.address) {
    process.stderr.write("--address is required\n");
    return 2;
  }
  if (!graphqlUrl) {
    process.stderr.write("--graphql-url is required (or set GRAPHQL_URL)\n");
    return 2;
  }

  const request = AgentInvestigationRequestSchema.parse({
    address: values.address,
    zip: values.zip,
    graphql_url: graphqlUrl,
    provider: values.provider,
    model: values.model ?? null,
    base_url: values["base-url"] ?? null,
    heuristic_allowlist: values["allow-heuristic"] ?? null,
    heuristic_blocklist: values["block-heuristic"] ?? [],
    max_concurrency: Number.parseInt(values["max-concurrency"]!, 10),
    max_graphql_calls_per_agent: Number.parseInt(values["max-graphql-calls-per-agent"]!, 10),
    graphql_timeout_seconds: Number.parseFloat(values["graphql-timeout-seconds"]!),
    agent_timeout_seconds: Number.parseFloat(values["agent-timeout-seconds"]!),
    max_output_retries: Number.parseInt(values["max-output-retries"]!, 10),
    max_query_repair_attempts: Number.parseInt(values["max-query-repair-attempts"]!, 10),
    schema_tool_budget: Number.parseInt(values["schema-tool-budget"]!, 10),
    disable_master_planning: values["enable-master-planning"] ? false : values["disable-master-planning"],
    prompt_profile: values["prompt-profile"],
    retrieval_mode: values["retrieval-mode"],
    include_shortcuts: values["include-shortcuts"],
    metrics_debug_payloads: values["metrics-debug-payloads"],
    batch_id: values["batch-id"] ?? null,
    trace_id: values["trace-id"] ?? null,
  });

  // --progress: stream one NDJSON line per metric event to stdout so a parent
  // process can render live per-agent progress. The report still goes to --out.
  const hooks = values.progress
    ? {
        on_metric_event: (event: MetricEvent) => {
          process.stdout.write(formatProgressLine(event) + "\n");
        },
      }
    : {};

  let assessment: any;
  try {
    assessment = await investigate_address(request, null, hooks);
  } catch (exc) {
    process.stderr.write(`agent investigation failed: ${(exc as Error).message ?? exc}\n`);
    return 1;
  }

  // metrics_events is excluded from serialization — omit it from the output JSON.
  const { metrics_events, ...assessmentOut } = assessment;
  const output = JSON.stringify(assessmentOut, null, 2);
  const out = values.out;
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, output + "\n", { encoding: "utf-8" });
    const events = (metrics_events ?? []) as MetricEvent[];
    if (events.length > 0) {
      writeRunMetrics(out, events, assessment.metrics as RunMetricsSummary);
    }
  } else {
    process.stdout.write(output + "\n");
  }
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
