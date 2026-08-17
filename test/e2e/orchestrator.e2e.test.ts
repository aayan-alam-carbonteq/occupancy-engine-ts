import { describe, expect, test } from "bun:test";
import { AgentOrchestrator } from "../../src/agents/orchestrator.ts";
import { DataHttpClient } from "../../src/agents/data_client.ts";
import { AgentInvestigationRequestSchema } from "../../src/agents/models.ts";
import { RetrievalHeuristicSubagent } from "../../src/agents/subagents.ts";
import { TypedToolset } from "../../src/agents/toolsets/typed_toolset.ts";
import { FixtureDataService } from "../support/fixture_data_service.ts";
import { externalEvidenceFixture, people1104, resolve1104 } from "../support/fixtures.ts";
import { ScriptedChatModel } from "../support/scripted_llm.ts";
import { FakeSubagent, PromptRecordingSubagent } from "../support/subagents.ts";

/**
 * The Contract B/C bodies one investigation needs: op 1 (resolve), op 3 (the clustered people
 * list, D4), op 2 (address records, for a toolset that drills down) and GET /v1/schema, which
 * preflight fetches once in "tools" mode (D5). Anything not listed 404s — that is the point.
 */
function fixturePlan() {
  const payload = resolve1104() as any;
  return {
    resolve: payload,
    address_people: people1104(),
    address_records: { records_by_source: payload.records_by_source, unsupported_shapes: [] },
    schema: { tables: [], access_paths: [], caveats: [] },
  };
}

describe("E2E-1: orchestrator assembly (fixture data service + fake subagent, no LLM)", () => {
  test("investigate() assembles a full assessment from the real preflight fixture", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = new AgentOrchestrator({
        data: new DataHttpClient(server.url),
        subagent: new FakeSubagent(),
      });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        data_url: server.url,
      });

      const a = await orch.investigate(request);

      expect(a.resolved_address.selected).not.toBeNull();
      expect(typeof a.resolved_address.source_counts).toBe("object");
      expect(a.heuristics.length).toBeGreaterThan(0);
      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
      expect(typeof a.report).toBe("string");
      expect(a.report.length).toBeGreaterThan(0);
      expect(server.requests.map((r) => r.path)).toContain("/v1/resolve");

      // WIRING REGRESSION GUARD: the real preflight fixture populates owner_summaries with a raw
      // "owner=...; residential=True; ..." bit-string internally; resolved_address must serve the
      // HUMANIZED display copy (orchestrator's `displayContext`), not that raw string. This would
      // catch a revert of `resolved_address: displayContext` back to the ungrounded `context`.
      const ownerSummary = a.resolved_address.evidence_map.owner_summaries[0]?.summaries[0];
      expect(ownerSummary).toMatch(/^Owner /);
      expect(ownerSummary).not.toContain("=");
      // CO-OWNER FIDELITY GUARD: the fixture's ownername is "CORRELL, REBECCA CHRISTINE; CORRELL,
      // JOSIAH STEEL" — a real multi-owner value. The humanizer must not truncate it to the first
      // co-owner (parseBits splits on ";"); it must survive end-to-end via the structured owner_name.
      expect(ownerSummary).toContain("Josiah");
    } finally {
      server.close();
    }
  });
});

describe("E2E-2: real subagent driven by scripted LLM (no API)", () => {
  test("investigate() runs the real subagent to a scored submit for one allowlisted packet", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const llm = new ScriptedChatModel([
        [
          {
            name: "submit_heuristic_result",
            args: {
              heuristic_id: "property_tax_context",
              status: "not_triggered",
              direction: "risk",
              score: 0,
              confidence: "low",
              finding: "property_tax_context finding.",
              missing_evidence: ["No supporting rows in fixture."],
            },
          },
        ],
      ]);
      const subagent = new RetrievalHeuristicSubagent(llm as any, new TypedToolset());
      const orch = new AgentOrchestrator({ data: new DataHttpClient(server.url), subagent });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        data_url: server.url,
        retrieval_mode: "typed_tools",
        heuristic_allowlist: ["property_tax_context"],
      });

      const a = await orch.investigate(request);

      expect(a.heuristics.length).toBe(1);
      expect(a.heuristics[0]!.heuristic_id).toBe("property_tax_context");
      expect(a.heuristics[0]!.status).not.toBe("error");
    } finally {
      server.close();
    }
  });
});

describe("E2E-3: the parity guard — no payload, behavior unchanged", () => {
  test("investigate() with no payload exposes no external evidence anywhere", async () => {
    const server = new FixtureDataService(fixturePlan());
    const subagent = new PromptRecordingSubagent();
    try {
      const orch = new AgentOrchestrator({ data: new DataHttpClient(server.url), subagent });
      const request = AgentInvestigationRequestSchema.parse({
        address: "1104 SPRING RUN RD",
        zip: "40514",
        data_url: server.url,
      });
      expect(request.external_evidence).toBeNull(); // the absent payload IS the blind switch

      const a = await orch.investigate(request);

      // 1. everything stays exactly as empty as it is today
      expect(a.resolved_address.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.rental_market_summary).toEqual([]);

      // 2. no external source reaches any evidence surface
      const sources = [
        ...a.resolved_address.evidence_map.evidence_refs.map((r) => r.source),
        ...a.evidence_pack.map((r) => r.source),
      ];
      expect(sources.some((s) => s === "str_scan" || s === "property_facts")).toBe(false);
      expect(Object.keys(a.resolved_address.evidence_map.source_counts)).not.toContain("str_scan");

      // 3. no external CONTENT reaches any rendered packet prompt.
      //    Note: the bare token "str_scan" DOES appear in the exposed packets' "Context scope:" /
      //    "Expected sources:" lines even blind — input_sources is static, and that is pinned by
      //    the exposure map. What must never appear with no payload is the evidence itself.
      expect(subagent.all()).not.toContain("Rental Market");
      expect(subagent.all()).not.toContain("Short-term rental listing");
      expect(subagent.all()).not.toContain("str_scan; platform=");
      expect(subagent.all()).not.toContain("property_facts; source_provider=");
      expect(subagent.all()).not.toContain("not a probability that the property is a rental");
      expect(subagent.all()).not.toContain("Property listed for rent");
      expect(subagent.all()).not.toContain("last_sold_date=");

      // 4. and the assessment still assembles exactly as E2E-1 asserts
      expect(a.resolved_address.selected).not.toBeNull();
      expect(a.heuristics.length).toBeGreaterThan(0);
      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
      expect(a.report.length).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});

describe("E2E-4: enriched — a payload reaches exactly the exposed packets", () => {
  test("investigate() folds the payload in and exposes it selectively", async () => {
    const server = new FixtureDataService(fixturePlan());
    const subagent = new PromptRecordingSubagent();
    try {
      const orch = new AgentOrchestrator({ data: new DataHttpClient(server.url), subagent });
      const a = await orch.investigate(
        AgentInvestigationRequestSchema.parse({
          address: "1104 SPRING RUN RD",
          zip: "40514",
          data_url: server.url,
          external_evidence: externalEvidenceFixture(),
        }),
      );

      // the payload landed, external refs leading; the gate-facing field stayed empty
      expect(a.resolved_address.property_types).toEqual(["single_family"]);
      expect(a.resolved_address.evidence_map.property_types).toEqual([]);
      expect(a.resolved_address.evidence_map.rental_market_summary.length).toBeGreaterThan(0);
      expect(a.resolved_address.evidence_map.evidence_refs.map((r) => r.source).slice(0, 2)).toEqual([
        "str_scan",
        "property_facts",
      ]);
      // the full structured detail survives for audit
      expect(a.resolved_address.evidence_map.evidence_refs[0]!.data["listing_url"]).toBe("https://www.vrbo.com/1234567");

      // case_quality_and_synthesis always runs (its gate returns run or run_for_absence), so it is
      // the one packet we can anchor on regardless of what the fixture gates in.
      expect(subagent.prompts.has("case_quality_and_synthesis")).toBe(true);
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("Short-term rental listing found on vrbo");
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("source_provider=realtor");
      // the realtor rental history reaches the synthesis packet beside the STR line
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain(
        "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.",
      );
      expect(subagent.prompts.get("case_quality_and_synthesis")!).toContain("last_sold_date=2018-10-25");

      // and every packet that DID run obeys the exposure map. Solo dispatch (FakeSubagent has no
      // run_group), so this asserts the per-packet scope, not the bucket union — which
      // test/external_evidence_exposure.test.ts covers.
      const STR_EXPOSED = new Set(["subject_occupancy_surfaces", "loan_tenure", "case_quality_and_synthesis"]);
      const FACTS_EXPOSED = new Set(["property_tax_context", "case_quality_and_synthesis"]);
      for (const [packet_id, prompt] of subagent.prompts) {
        if (STR_EXPOSED.has(packet_id)) {
          expect([packet_id, prompt.includes("Short-term rental listing found on vrbo")]).toEqual([packet_id, true]);
        } else {
          expect([packet_id, prompt.includes("Short-term rental listing")]).toEqual([packet_id, false]);
          expect([packet_id, prompt.includes("vrbo")]).toEqual([packet_id, false]);
        }
        expect([packet_id, prompt.includes("source_provider=realtor")]).toEqual([packet_id, FACTS_EXPOSED.has(packet_id)]);
        if (STR_EXPOSED.has(packet_id)) {
          expect([packet_id, prompt.includes("Property listed for rent (realtor history)")]).toEqual([packet_id, true]);
        } else {
          expect([packet_id, prompt.includes("Property listed for rent")]).toEqual([packet_id, false]);
          expect([packet_id, prompt.includes("AppfolioUnits")]).toEqual([packet_id, false]);
        }
        expect([packet_id, prompt.includes("last_sold_date=2018-10-25")]).toEqual([
          packet_id,
          FACTS_EXPOSED.has(packet_id),
        ]);
      }

      expect(a.heuristics.every((h: any) => h.status !== "error")).toBe(true);
      expect(a.adjudication.verdict_band).toBeTruthy();
    } finally {
      server.close();
    }
  });
});

describe("E2E-5: no code path attempts GraphQL", () => {
  test("a full investigation touches only Contract B/C paths", async () => {
    const server = new FixtureDataService(fixturePlan());
    try {
      const orch = new AgentOrchestrator({ data: new DataHttpClient(server.url), subagent: new FakeSubagent() });
      const a = await orch.investigate(
        AgentInvestigationRequestSchema.parse({ address: "1104 SPRING RUN RD", zip: "40514", data_url: server.url }),
      );
      // Without this the loop below is vacuous: a run that never reached the service at all would
      // satisfy "every path starts with /v1/" trivially.
      expect(a.resolved_address.selected).not.toBeNull();
      expect(server.requests.map((r) => r.path)).toContain("/v1/resolve");
      for (const r of server.requests) {
        expect([r.method, r.path, r.path.startsWith("/v1/")]).toEqual([r.method, r.path, true]);
      }
      expect(server.requests.some((r) => r.path === "/graphql")).toBe(false);
    } finally {
      server.close();
    }
  });
});
