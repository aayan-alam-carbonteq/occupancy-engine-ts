import { describe, expect, test } from "bun:test";
import { create_engine_server, type EngineServer } from "../../src/server/investigate_server.ts";
import { investigate_address } from "../../src/agents/orchestrator.ts";
import { assessment_report_payload } from "../../src/agents/investigation_wire.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { people1104, resolve1104 } from "../support/fixtures.ts";
import { FakeSubagent } from "../support/subagents.ts";

const TOKEN = "e2e-token";
const EXTERNAL_MARKERS = ["Short-term rental listing", "str_scan; platform=", "source_provider=realtor", "Rental Market"];

/** The Contract B/C bodies one blind investigation needs (see orchestrator.e2e.test.ts). */
function fixturePlan() {
  const payload = resolve1104() as any;
  return {
    resolve: payload,
    address_people: people1104(),
    address_records: { records_by_source: payload.records_by_source, unsupported_shapes: [] },
    schema: { tables: [], access_paths: [], caveats: [] },
  };
}

describe("E2E: blind byte-identity — the service report frame == the CLI report bytes", () => {
  test("the terminal {report} equals assessment_report_payload for the same assessment", async () => {
    const graph = new FixtureDataService(fixturePlan());
    try {
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
      });
      expect(request.external_evidence).toBeNull(); // the absent payload IS the blind switch

      // One deterministic assessment (FakeSubagent + the fixture data service, no LLM). graph.url
      // travels as the explicit override, never in the request — there is no data_url field to send.
      const assessment = await investigate_address(request, new FakeSubagent(), {}, graph.url);
      const cliReport = assessment_report_payload(assessment); // exactly what the CLI writes to stdout

      let engine: EngineServer | undefined;
      try {
        // Serve the SAME assessment so run-to-run nondeterminism (ids/timestamps) is factored out and
        // only the transport/serialization is compared.
        engine = create_engine_server({ port: 0, auth_token: TOKEN, investigate: async () => assessment });
        const res = await fetch(`${engine.url}/investigate`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514" }),
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
    const graph = new FixtureDataService(fixturePlan());
    let engine: EngineServer | undefined;
    try {
      engine = create_engine_server({
        port: 0,
        auth_token: TOKEN,
        // Real orchestrator through the real investigate_address, deterministic via FakeSubagent.
        // graph.url is the explicit override — the request body carries no data_url at all.
        investigate: (request, hooks) => investigate_address(request, new FakeSubagent(), hooks, graph.url),
      });
      const res = await fetch(`${engine.url}/investigate`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ address: "1104 SPRING RUN RD", zip: "40514" }),
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
