//
// THE CRITICAL NEGATIVE TEST. Given a payload, owner_identity_and_mailing must never see str_scan
// in its rendered prompt — solo, grouped, or under either prompt profile. This guards the whole
// selective-exposure design.
import { describe, expect, test } from "bun:test";
import {
  external_evidence_refs,
  property_types_from_external,
  rental_market_summary_lines,
} from "../src/agents/external_evidence_map.ts";
import {
  type HeuristicAgentInput,
  HeuristicAgentInputSchema,
  ResolvedAddressContextSchema,
} from "../src/agents/models.ts";
import { TypedToolset } from "../src/agents/toolsets/typed_toolset.ts";
import { get_heuristic_catalog } from "../src/heuristics/index.ts";
import { externalEvidenceFixture } from "./support/fixtures.ts";

// Every surface the payload could leak through: the source token, the listing prose, the platform
// name, and the listing url fragment.
const STR_MARKERS = ["str_scan", "Short-term rental listing", "vrbo", "1234567"];
// rental_listings rides the SAME str_scan gate as the STR line, so it is excluded from
// owner_identity at EVERY level (solo, full, and the production group).
const RENTAL_MARKERS = ["Property listed for rent (realtor history)", "AppfolioUnits"];
// the X-014 property_facts transaction fields. Excluded from a SOLO owner_identity prompt (which
// gets no property_facts at all); they DO reach its GROUP prompt via property_tax_context — a
// decision of record asserted below.
const FACTS_TXN_MARKERS = ["last_sold_date", "last_sold_price", "list_date"];

const SOURCE_COUNTS = { tax: 2, base: 1, trace: 1, utility: 1, loan: 1, drive: 1, voter: 0, auto: 0 };

function enrichedContext(): Record<string, unknown> {
  const evidence = externalEvidenceFixture();
  return ResolvedAddressContextSchema.parse({
    input_address: "1104 SPRING RUN RD",
    input_zip: "40514",
    selected: { id: 1104, norm_address: "1104 SPRING RUN RD", zip5: "40514", match_score: 1 },
    candidates: [],
    ambiguous: false,
    source_counts: SOURCE_COUNTS,
    // context-level only — evidence_map.property_types stays [] so the portfolio gate stays blind
    property_types: property_types_from_external(evidence),
    evidence_map: {
      address_id: 1104,
      normalized_address: "1104 SPRING RUN RD",
      zip5: "40514",
      source_counts: SOURCE_COUNTS,
      property_types: [],
      rental_market_summary: rental_market_summary_lines(evidence),
      evidence_refs: [
        ...external_evidence_refs(evidence),
        { source: "tax", table: "tax", rowid: 1, summary: "tax; ownername=DOE JOHN" },
      ],
    },
  }) as unknown as Record<string, unknown>;
}

function agentInput(
  packet_id: string,
  prompt_profile: "compact" | "full" = "compact",
): HeuristicAgentInput {
  const heuristic = get_heuristic_catalog().find((item) => item["id"] === packet_id);
  if (heuristic === undefined) {
    throw new Error(`unknown packet: ${packet_id}`);
  }
  return HeuristicAgentInputSchema.parse({
    heuristic,
    context: enrichedContext(),
    max_graphql_calls: 8,
    prompt_profile,
  });
}

/** The exact prompt a solo packet worker is sent. */
function renderSolo(packet_id: string, prompt_profile: "compact" | "full" = "compact"): string {
  const toolset = new TypedToolset();
  const input = agentInput(packet_id, prompt_profile);
  return toolset.user_prompt(input, toolset.build_context(input));
}

/** The exact shared prompt a production bucket is sent (scope is UNIONed across the bucket). */
function renderGroup(
  packet_ids: string[],
  prompt_profile: "compact" | "full" = "compact",
): string {
  return new TypedToolset().group_user_prompt(
    packet_ids.map((id) => agentInput(id, prompt_profile)),
  );
}

describe("THE CRITICAL NEGATIVE TEST: owner_identity_and_mailing never sees the rental channel", () => {
  test("solo prompt, compact profile — no STR, no realtor history, no transaction facts", () => {
    const prompt = renderSolo("owner_identity_and_mailing");
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS, ...FACTS_TXN_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("solo prompt, full profile — profile is verbosity, not authorization", () => {
    const prompt = renderSolo("owner_identity_and_mailing", "full");
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS, ...FACTS_TXN_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("its PRODUCTION group prompt — the bucket union carries property_facts but NOT the rental channel", () => {
    // _bucket_by_group pairs it with property_tax_context and run_group unions their scopes. The
    // union carries property_facts (so the transaction facts DO appear — see KNOWN CONSEQUENCES)
    // but NOT str_scan, so the realtor rental history is withheld here too.
    const prompt = renderGroup(["property_tax_context", "owner_identity_and_mailing"]);
    for (const marker of [...STR_MARKERS, ...RENTAL_MARKERS]) {
      expect(prompt).not.toContain(marker);
    }
  });
});

describe("portfolio_and_primary_comparison sees neither source", () => {
  test("it is a solo bucket, so nothing unions into it", () => {
    const prompt = renderSolo("portfolio_and_primary_comparison");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
    expect(prompt).not.toContain("source_provider=realtor");
  });
});

describe("KNOWN CONSEQUENCES of the bucket union (decisions of record, not surprises)", () => {
  test("owner_identity_and_mailing DOES see property_facts via its bucket-mate", () => {
    // Accepted: property facts are not the smoking gun, and the packet is excluded because the
    // payload gives it no owner identity to reason with — not for collapse risk.
    expect(renderGroup(["property_tax_context", "owner_identity_and_mailing"])).toContain(
      "source_provider=realtor",
    );
  });

  test("legal_address_presence DOES see str_scan via its bucket-mate", () => {
    // It shares the occupancy_presence bucket with subject_occupancy_surfaces. Accepted per the
    // umbrella's per-bucket re-pin: regrouping would change a cost/latency property to serve an
    // exposure rule, and this packet is excluded for having nothing useful to reason with.
    expect(renderGroup(["subject_occupancy_surfaces", "legal_address_presence"])).toContain(
      "Short-term rental listing found on vrbo",
    );
  });

  test("but legal_address_presence sees nothing when run solo", () => {
    const prompt = renderSolo("legal_address_presence");
    for (const marker of STR_MARKERS) {
      expect(prompt).not.toContain(marker);
    }
  });

  test("owner_identity_and_mailing DOES see the transaction facts via its bucket-mate", () => {
    // Same decision of record as source_provider=realtor: property facts are not the smoking gun,
    // and the packet is excluded for having no owner identity to reason with — not for collapse risk.
    const prompt = renderGroup(["property_tax_context", "owner_identity_and_mailing"]);
    expect(prompt).toContain("last_sold_date=2018-10-25");
    expect(prompt).toContain("list_date=2026-05-02");
  });
});

describe("the exposed packets do see their sources", () => {
  test("subject_occupancy_surfaces sees the listing and the address-match framing", () => {
    const prompt = renderSolo("subject_occupancy_surfaces");
    expect(prompt).toContain("Rental Market");
    expect(prompt).toContain(
      "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.",
    );
    expect(prompt).toContain("not a probability that the property is a rental");
  });

  test("subject_occupancy_surfaces sees it under the full profile too", () => {
    expect(renderSolo("subject_occupancy_surfaces", "full")).toContain(
      "Short-term rental listing found on vrbo",
    );
  });

  test("property_tax_context sees property_facts but NOT the listing channel", () => {
    const prompt = renderSolo("property_tax_context");
    expect(prompt).toContain("source_provider=realtor");
    expect(prompt).toContain("listing_status=for_rent");
    expect(prompt).not.toContain("Short-term rental listing");
    expect(prompt).not.toContain("vrbo");
  });

  test("loan_tenure sees the listing (it contradicts an own_rent: own claim)", () => {
    expect(renderSolo("loan_tenure")).toContain("Short-term rental listing found on vrbo");
  });

  test("case_quality_and_synthesis sees both — it cannot receive them transitively", () => {
    const prompt = renderSolo("case_quality_and_synthesis");
    expect(prompt).toContain("Short-term rental listing found on vrbo");
    expect(prompt).toContain("source_provider=realtor");
  });

  test("the property type reaches even an unexposed packet (context-level, global)", () => {
    expect(renderSolo("owner_identity_and_mailing")).toContain("single_family");
  });

  test("subject_occupancy_surfaces sees the realtor rental history beside the STR line", () => {
    const prompt = renderSolo("subject_occupancy_surfaces");
    expect(prompt).toContain(
      "Property listed for rent (realtor history): 2026-05 $2300, 2025-03 $2195 — source AppfolioUnits.",
    );
  });

  test("property_tax_context sees the transaction facts but NOT the rental channel", () => {
    const prompt = renderSolo("property_tax_context");
    expect(prompt).toContain("last_sold_date=2018-10-25");
    expect(prompt).toContain("list_date=2026-05-02");
    expect(prompt).not.toContain("Property listed for rent");
    expect(prompt).not.toContain("AppfolioUnits");
  });
});
