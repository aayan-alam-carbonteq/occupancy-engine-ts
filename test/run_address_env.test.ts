import { afterEach, describe, expect, test } from "bun:test";
import { cliRequestPayload } from "../cli/run_address.ts";
import { resolve_data_url } from "../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../src/agents/models.ts";

// cli/run_address.ts resolves --data-url through the SAME resolve_data_url the HTTP service uses
// for /fingerprint's probe and /healthz — there is no CLI-local variant of this precedence anymore.
describe("resolve_data_url (as the CLI calls it: flag > DATA_URL env > default)", () => {
  const original = process.env.DATA_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.DATA_URL;
    else process.env.DATA_URL = original;
  });

  test("the flag wins even when DATA_URL is set", () => {
    process.env.DATA_URL = "http://env";
    expect(resolve_data_url("http://flag")).toBe("http://flag");
  });

  test("falls back to DATA_URL when no flag is given", () => {
    process.env.DATA_URL = "http://env";
    expect(resolve_data_url(undefined)).toBe("http://env");
  });

  test("falls back to the compose-network default when neither is set", () => {
    delete process.env.DATA_URL;
    expect(resolve_data_url(undefined)).toBe("http://graph:8000");
  });
});

// The CLI's flag->request mapping is the one place the Contract A / D1 / D2 renames can rot
// invisibly: AgentInvestigationRequestSchema is .strict(), so a single stale key (graphql_url,
// max_graphql_calls_per_agent, graphql_timeout_seconds, include_shortcuts, data_url) makes EVERY CLI
// run throw a ZodError at startup. Nothing else in the suite drives this mapping — the two spawn
// tests in run_address_evidence.test.ts both exit 2 before reaching it — so it is asserted directly.
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
  test("builds a payload the strict request schema accepts, with no data_url field", () => {
    const parsed = AgentInvestigationRequestSchema.safeParse(cliRequestPayload(FLAGS, null));
    if (!parsed.success) {
      throw new Error(`CLI payload rejected: ${JSON.stringify(parsed.error.issues)}`);
    }
    expect("data_url" in parsed.data).toBe(false);
    expect(parsed.data.max_data_calls_per_agent).toBe(6);
    expect(parsed.data.data_timeout_seconds).toBe(45);
  });

  test("carries none of the retired keys", () => {
    const payload = cliRequestPayload(FLAGS, null) as Record<string, unknown>;
    for (const dead of [
      "graphql_url",
      "max_graphql_calls_per_agent",
      "graphql_timeout_seconds",
      "include_shortcuts",
      "data_url",
    ]) {
      expect(Object.keys(payload)).not.toContain(dead);
    }
  });
});
