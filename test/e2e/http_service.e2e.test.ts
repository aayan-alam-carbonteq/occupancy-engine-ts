import { describe, expect, test } from "bun:test";
import { create_engine_server, type EngineServer } from "../../src/server/investigate_server.ts";
import { investigate_address } from "../../src/agents/orchestrator.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { FixtureGraphQLServer } from "../support/fixture_graphql.ts";
import { loadPreflight1104 } from "../support/fixtures.ts";
import { FakeSubagent } from "../support/subagents.ts";

const TOKEN = "e2e-token";
const EXTERNAL_MARKERS = ["Short-term rental listing", "str_scan; platform=", "source_provider=realtor", "Rental Market"];

describe("E2E: blind byte-identity — the service report frame == the CLI report bytes", () => {
  test("the terminal {report} equals assessment_report_payload for the same assessment", async () => {
    const graph = new FixtureGraphQLServer(loadPreflight1104());
    try {
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        graphql_url: graph.url,
      });
      expect(request.external_evidence).toBeNull(); // the absent payload IS the blind switch

      // One deterministic assessment (FakeSubagent + fixture graph, no LLM).
      const assessment = await investigate_address(request, new FakeSubagent(), {});
      const cliReport = assessment_report_payload(assessment); // exactly what the CLI writes to stdout

      let engine: EngineServer | undefined;
      try {
        // Serve the SAME assessment so run-to-run nondeterminism (ids/timestamps) is factored out and
        // only the transport/serialization is compared.
        engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => assessment });
        const res = await fetch(`${engine.url}/investigate`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514", graphql_url: graph.url }),
        });
        const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
        expect(lines.length).toBe(1);
        const frame = JSON.parse(lines[0]!);
        expect("report" in frame).toBe(true);
        expect("error" in frame).toBe(false);
        // Byte-identical report payload — the wrapper drops exactly metrics_events, adds nothing.
        expect(JSON.stringify(frame.report)).toBe(JSON.stringify(cliReport));
        // Blind guarantee survives the transport: no external-evidence CONTENT in the report.
        const bytes = JSON.stringify(frame.report);
        for (const marker of EXTERNAL_MARKERS) {
          expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
        }
      } finally {
        if (engine) await engine.stop();
      }
    } finally {
      graph.close();
    }
  });

  test("a full-pipeline blind run through the service streams progress then one clean report frame", async () => {
    const graph = new FixtureGraphQLServer(loadPreflight1104());
    let engine: EngineServer | undefined;
    try {
      engine = create_engine_server({
        port: 0,
        auth_token: TOKEN,
        // Real orchestrator through the real investigate_address, deterministic via FakeSubagent.
        investigate: (request, hooks) => investigate_address(request, new FakeSubagent(), hooks),
      });
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514", graphql_url: graph.url }),
      });
      expect(res.status).toBe(200);
      const lines = (await res.text()).split("\n").filter((l) => l.length > 0);

      const progress = lines.slice(0, -1).map((l) => JSON.parse(l));
      const terminal = JSON.parse(lines[lines.length - 1]!);
      expect(progress.length).toBeGreaterThan(0); // real spans emitted progress frames
      expect(progress.every((p) => "progress" in p)).toBe(true);
      expect("report" in terminal).toBe(true); // exactly one terminal frame, last, and it is a report
      expect(lines.filter((l) => "report" in JSON.parse(l) || "error" in JSON.parse(l)).length).toBe(1);

      const bytes = JSON.stringify(terminal.report);
      for (const marker of EXTERNAL_MARKERS) {
        expect([marker, bytes.includes(marker)]).toEqual([marker, false]);
      }
    } finally {
      if (engine) await engine.stop();
      graph.close();
    }
  });
});
