import { describe, expect, test } from "bun:test";
import { compact_evidence_map } from "../src/agents/prompts.ts";

const LISTING_LINE =
  "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.";

function evidenceMap(): Record<string, any> {
  return {
    address_id: 1104,
    normalized_address: "1104 SPRING RUN RD",
    zip5: "40514",
    source_counts: { tax: 2, base: 1 },
    property_types: [],
    rental_market_summary: [LISTING_LINE],
    owner_summaries: [],
    people_at_address: [],
    owner_presence_hints: [],
    owner_elsewhere_hints: [],
    nonowner_occupancy_hints: [],
    freshness_hints: [],
    data_gaps: [],
    evidence_refs: [
      {
        source: "str_scan",
        table: "str_listing",
        rowid: null,
        record_id: "scan_123:0",
        summary: "str_scan; platform=vrbo",
        data: {},
      },
      {
        source: "property_facts",
        table: "property_facts",
        rowid: null,
        record_id: "scan_123:property_facts",
        summary: "property_facts; source_provider=realtor",
        data: {},
      },
      ...Array.from({ length: 8 }, (_, i) => ({
        source: "tax",
        table: "tax",
        rowid: i + 1,
        record_id: null,
        summary: `tax row ${i + 1}`,
        data: {},
      })),
    ],
  };
}

describe("compact_evidence_map: external evidence scope gating", () => {
  test("rental_market_summary reaches a str_scan-scoped packet", () => {
    expect(
      compact_evidence_map(evidenceMap(), ["trace", "utility", "tax", "str_scan"])[
        "rental_market_summary"
      ],
    ).toEqual([LISTING_LINE]);
  });

  test("rental_market_summary is WITHHELD from a packet without str_scan scope", () => {
    // The smoking-gun channel is unfiltered today; this is the selective-exposure design.
    expect(
      compact_evidence_map(evidenceMap(), ["tax", "base", "drive"])["rental_market_summary"],
    ).toEqual([]);
  });

  test("property_facts scope alone does not unlock the listing channel", () => {
    expect(
      compact_evidence_map(evidenceMap(), ["tax", "base", "property_facts"])[
        "rental_market_summary"
      ],
    ).toEqual([]);
  });

  test("an empty scope (the master prompts) sees everything, exactly as today", () => {
    expect(compact_evidence_map(evidenceMap(), null)["rental_market_summary"]).toEqual([
      LISTING_LINE,
    ]);
    expect(compact_evidence_map(evidenceMap(), [])["rental_market_summary"]).toEqual([
      LISTING_LINE,
    ]);
  });

  test("external refs are ordered FIRST and survive refs.slice(0, 8)", () => {
    const map = evidenceMap();
    // Put the external refs last so only the ordering can save them from the cap.
    map["evidence_refs"] = [...map["evidence_refs"].slice(2), ...map["evidence_refs"].slice(0, 2)];
    const refs = compact_evidence_map(map, ["tax", "str_scan", "property_facts"])[
      "evidence_refs"
    ] as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(8);
    expect(refs.map((r) => r["source"]).slice(0, 2)).toEqual(["str_scan", "property_facts"]);
  });

  test("an unscoped packet gets no external refs at all", () => {
    const refs = compact_evidence_map(evidenceMap(), ["tax", "base"])["evidence_refs"] as Array<
      Record<string, unknown>
    >;
    expect(refs.every((r) => r["source"] === "tax")).toBe(true);
    expect(refs).toHaveLength(8);
  });

  test("refs are still compacted to summary — data never rides the compact prompt", () => {
    const refs = compact_evidence_map(evidenceMap(), ["str_scan"])["evidence_refs"] as Array<
      Record<string, unknown>
    >;
    expect(refs[0]!["source"]).toBe("str_scan");
    expect(Object.hasOwn(refs[0]!, "data")).toBe(false);
  });
});
