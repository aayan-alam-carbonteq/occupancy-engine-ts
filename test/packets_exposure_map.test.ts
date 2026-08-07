import { describe, expect, test } from "bun:test";
import { PACKETS } from "../src/heuristics/packets.ts";
import { EXTERNAL_EVIDENCE_SOURCES, SUBSTANTIVE_SOURCES } from "../src/heuristics/policy.ts";

const EXTERNAL: ReadonlySet<string> = new Set<string>(EXTERNAL_EVIDENCE_SOURCES);

// The pinned exposure map. The three exclusions are forced by the payload, not by taste: it carries
// no host or owner identity, so the identity/portfolio packets have nothing to reason with, and
// legal_address_presence covers drive/voter/auto, which neither payload touches.
const EXPOSURE: Record<string, string[]> = {
  property_tax_context: ["property_facts"],
  owner_identity_and_mailing: [],
  subject_occupancy_surfaces: ["str_scan"],
  legal_address_presence: [],
  loan_tenure: ["str_scan"],
  portfolio_and_primary_comparison: [],
  case_quality_and_synthesis: ["str_scan", "property_facts"],
};

describe("the pinned exposure map", () => {
  test("covers every packet — a new packet must make an explicit exposure decision", () => {
    expect(PACKETS.map((p) => p.id).sort()).toEqual(Object.keys(EXPOSURE).sort());
  });

  test("each packet names exactly its pinned external sources in input_sources", () => {
    for (const packet of PACKETS) {
      expect([packet.id, packet.input_sources.filter((s) => EXTERNAL.has(s))]).toEqual([
        packet.id,
        EXPOSURE[packet.id]!,
      ]);
    }
  });

  test("gate.source_scope matches input_sources for the external sources", () => {
    for (const packet of PACKETS) {
      expect([packet.id, packet.gate.source_scope.filter((s) => EXTERNAL.has(s))]).toEqual([
        packet.id,
        EXPOSURE[packet.id]!,
      ]);
    }
  });

  test("case_quality_and_synthesis COPIES SUBSTANTIVE_SOURCES — it never mutates it", () => {
    const packet = PACKETS.find((p) => p.id === "case_quality_and_synthesis")!;
    expect(packet.input_sources).not.toBe(SUBSTANTIVE_SOURCES);
    expect(packet.gate.source_scope).not.toBe(SUBSTANTIVE_SOURCES);
    expect([...packet.input_sources]).toEqual([...SUBSTANTIVE_SOURCES, "str_scan", "property_facts"]);
    expect([...packet.gate.source_scope]).toEqual([
      ...SUBSTANTIVE_SOURCES,
      "str_scan",
      "property_facts",
    ]);
    // and the shared constant is unchanged after the catalog is built
    expect([...SUBSTANTIVE_SOURCES]).toEqual([
      "tax",
      "base",
      "loan",
      "drive",
      "voter",
      "auto",
      "trace",
      "utility",
    ]);
  });

  test("case_quality_and_synthesis stays score-neutral, so exposing it cannot inflate the score", () => {
    const packet = PACKETS.find((p) => p.id === "case_quality_and_synthesis")!;
    expect(packet.score).toBe(0);
    expect(packet.score_cap).toBe(0);
  });
});
