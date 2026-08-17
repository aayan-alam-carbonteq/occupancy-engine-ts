import { describe, expect, test } from "bun:test";
import { cliRequestPayload, resolveDataUrl } from "../cli/run_address.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";

describe("resolveDataUrl", () => {
  test("prefers the flag, falls back to DATA_URL, else undefined", () => {
    expect(resolveDataUrl("http://flag", "http://env")).toBe("http://flag");
    expect(resolveDataUrl(undefined, "http://env")).toBe("http://env");
    expect(resolveDataUrl(undefined, undefined)).toBeUndefined();
  });
});

// The CLI's flag->request mapping is the one place the Contract A / D1 / D2 renames can rot
// invisibly: AgentInvestigationRequestSchema is .strict(), so a single stale key (graphql_url,
// max_graphql_calls_per_agent, graphql_timeout_seconds, include_shortcuts) makes EVERY CLI run
// throw a ZodError at startup. Nothing else in the suite drives this mapping — the two spawn tests
// in run_address_evidence.test.ts both exit 2 before reaching it — so it is asserted directly.
const FLAGS = {
  address: "1104 SPRING RUN RD",
  zip: "40514",
  provider: "auto",
  model: undefined,
  "base-url": undefined,
  "allow-heuristic": undefined,
  "block-heuristic": [] as string[],
  "max-concurrency": "8",
  "max-data-calls-per-agent": "6",
  "data-timeout-seconds": "45",
  "agent-timeout-seconds": "120",
  "max-output-retries": "2",
  "max-query-repair-attempts": "3",
  "schema-tool-budget": "8",
  "disable-master-planning": true,
  "enable-master-planning": false,
  "prompt-profile": "compact",
  "retrieval-mode": "tools",
  "metrics-debug-payloads": false,
  "batch-id": undefined,
  "trace-id": undefined,
} as any;

describe("cliRequestPayload", () => {
  test("builds a payload the strict request schema accepts", () => {
    const parsed = AgentInvestigationRequestSchema.safeParse(
      cliRequestPayload(FLAGS, "http://graph:8000", null),
    );
    if (!parsed.success) {
      throw new Error(`CLI payload rejected: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect(parsed.data.data_url).toBe("http://graph:8000");
    expect(parsed.data.max_data_calls_per_agent).toBe(6);
    expect(parsed.data.data_timeout_seconds).toBe(45);
  });

  test("carries none of the retired keys", () => {
    const payload = cliRequestPayload(FLAGS, "http://graph:8000", null) as Record<string, unknown>;
    for (const dead of [
      "graphql_url",
      "max_graphql_calls_per_agent",
      "graphql_timeout_seconds",
      "include_shortcuts",
    ]) {
      expect(Object.keys(payload)).not.toContain(dead);
    }
  });
});
