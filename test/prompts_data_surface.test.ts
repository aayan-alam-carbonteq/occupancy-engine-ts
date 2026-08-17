import { describe, expect, test } from "bun:test";
import {
  DATA_SURFACE_PRIMER,
  HEURISTIC_SYSTEM_PROMPT,
  MINI_SCHEMA_GUIDE,
  SOURCE_HUMAN_PHRASES,
  TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT,
  buildProseRegisterLines,
  grouped_heuristic_user_prompt,
  heuristic_user_prompt,
  schema_context_for_heuristic,
} from "../src/agents/prompts.ts";
import { sql_tools_guide, typed_tools_guide } from "../src/agents/typed_tools.ts";

const PACKET = { id: "h", packet: true, input_sources: ["tax"] };

function packet_prompt(): string {
  return heuristic_user_prompt(PACKET, { evidence_map: {} }, null);
}

const ALL = [
  DATA_SURFACE_PRIMER,
  MINI_SCHEMA_GUIDE,
  HEURISTIC_SYSTEM_PROMPT,
  TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT,
  schema_context_for_heuristic({ input_sources: ["tax", "drive"] }),
  typed_tools_guide({ context_scope: ["tax"] }),
  sql_tools_guide({ context_scope: ["tax"] }),
  packet_prompt(),
  // The plan's ALL omitted the grouped builder, which carried its own copy of the GraphQL
  // requirements block (`GraphQL Query Requirements`, `execute_graphql`) — so the guard below
  // could not have caught it. Both builders are in scope.
  grouped_heuristic_user_prompt([PACKET], { evidence_map: {} }, null, null),
  // Gated off by default; included so the guard holds with OE_PROSE_REGISTER=on too.
  buildProseRegisterLines("finding, caveats, missing_evidence").join("\n"),
].join("\n");

describe("no prompt advertises a surface that no longer exists", () => {
  test("GraphQL vocabulary is gone everywhere", () => {
    for (const dead of [
      "GraphQL",
      "graphql",
      "execute_graphql",
      "validate_graphql",
      "resolveAddress",
      "personAssociations",
      "propertyAssociations",
      "addressAssociations",
      "sourceRecord",
      "totalCount",
      "hasMore",
      "WhereInput",
      "mutation",
      "subscription",
      "```graphql",
      "get_address_records",
      "get_people_at_address",
      "get_person_records",
    ]) {
      expect(ALL).not.toContain(dead);
    }
  });

  test("the three dead shapes are gone everywhere, including the register glossary", () => {
    for (const dead of ["voter", "criminal", "linkedin"]) {
      expect(ALL).not.toContain(dead);
      expect(Object.keys(SOURCE_HUMAN_PHRASES)).not.toContain(dead);
    }
  });

  test("a stale voter/criminal scope cannot smuggle a dead shape back into the schema context", () => {
    // _heuristic_sources filters against the live shape catalogue, not a prompt-local field map.
    const ctx = schema_context_for_heuristic({ input_sources: ["voter", "criminal", "tax"] });
    expect(ctx).not.toContain("voter");
    expect(ctx).not.toContain("criminal");
    expect(ctx).toContain("tax");
  });
});

describe("the primer describes the real access paths", () => {
  test("it names the six typed operations and the seven live shapes", () => {
    for (const op of ["resolve", "records", "people", "search", "source record"]) {
      expect(DATA_SURFACE_PRIMER.toLowerCase()).toContain(op);
    }
    expect(DATA_SURFACE_PRIMER).toContain("base, tax, utility, trace, auto, loan, drive");
  });

  test("it names the owner-elsewhere pattern, which is the corpus's strongest use case", () => {
    // Grounded in spec §7: the signal is on the subject's own tax row; the pattern is
    // resolve subject -> read tax -> take the owner mailing address -> resolve THAT.
    expect(DATA_SURFACE_PRIMER).toContain("owneraddressline1");
    expect(DATA_SURFACE_PRIMER).toContain("resolve that mailing address as a second address");
  });

  test("it warns that a drive row is not independent of the loan row", () => {
    expect(DATA_SURFACE_PRIMER).toContain("the same physical record as a loan row");
  });

  test("it says address resolution takes only an address and a zip (no filtered search survives)", () => {
    // "can no longer answer" item 4: searchAddresses(query, zip, limit) with arbitrary where: filters
    // is gone; operation 1 takes {address, zip} and nothing else.
    expect(DATA_SURFACE_PRIMER.toLowerCase()).toContain("no filters");
  });

  test("it says a person's other addresses are read off record rows, not an edge list", () => {
    // "can no longer answer" item 2: Person.addressAssociations is gone.
    expect(DATA_SURFACE_PRIMER.toLowerCase()).toContain("no address-association edge list");
  });
});

describe("hatch guidance (tools mode)", () => {
  test("names run_sql, the refusal contract, and the provenance rule", () => {
    const g = sql_tools_guide({ context_scope: ["tax"] });
    expect(g).toContain("run_sql");
    expect(g).toContain("describe_schema");
    expect(g).toContain("get_source_record");
    // Grounded: run_sql returns column/row arrays with no rowid, so nothing is auto-harvested.
    expect(g).toContain("carries no provenance");
  });

  test("names the one question only the hatch can answer", () => {
    expect(sql_tools_guide({})).toContain("other properties");
  });

  test("teaches operation 6 WITH its required address_id", () => {
    // Contract B addendum 1: GET /v1/source-record/{shape}/{rowid} 400s without ?address_id=,
    // before it even validates the shape. A guide that omits it teaches an uncitable call.
    const g = sql_tools_guide({ context_scope: ["tax"] });
    expect(g).toContain("get_source_record(shape, rowid, address_id)");
    expect(g).toContain("__rowid");
  });

  test("teaches a 422 as a repair signal rather than a failure", () => {
    const g = sql_tools_guide({ context_scope: ["tax"] });
    expect(g).toContain("reason");
    expect(g).toContain("hint");
    expect(g.toLowerCase()).toContain("not a failure");
  });
});

describe("bounded guidance (typed_tools mode)", () => {
  test("says plainly what that mode cannot reach", () => {
    expect(TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT).toContain("cannot enumerate an owner's other properties");
    expect(TYPED_TOOLS_HEURISTIC_SYSTEM_PROMPT).not.toContain("run_sql");
  });
});

describe("identity confidence", () => {
  test("the primer tells the model to discount a low-confidence or suspicious identity", () => {
    expect(DATA_SURFACE_PRIMER).toContain("identity_confidence");
    expect(DATA_SURFACE_PRIMER).toContain("is_suspicious");
  });
});

describe("the refusal channel replaces the pre-execution validator", () => {
  test("the system prompt tells the model to repair from the reason and hint", () => {
    // "can no longer answer" item 7: validate_graphql's dry run is gone; the 422 arrives
    // per-attempt and carries the planner's own reason plus the indexed access paths.
    expect(HEURISTIC_SYSTEM_PROMPT).toContain("reason and hint");
    expect(HEURISTIC_SYSTEM_PROMPT).toContain("indexed access path");
  });

  test("the packet prompt repeats the repair rule where the model is working", () => {
    expect(packet_prompt()).toContain("If run_sql is refused, use the returned reason and hint");
  });

  test("the retrieval section is headed for the data surface, not for queries", () => {
    expect(packet_prompt()).toContain("Data Access Requirements");
    expect(heuristic_user_prompt({ id: "h", input_sources: ["tax"] }, { evidence_map: {} }, null)).toContain(
      "Data access requirements:",
    );
    expect(grouped_heuristic_user_prompt([PACKET], { evidence_map: {} }, null, null)).toContain(
      "Data Access Requirements",
    );
  });
});

describe("the schema context is the typed surface, not a query cookbook", () => {
  test("it teaches get_records first and get_source_record for provenance", () => {
    const ctx = schema_context_for_heuristic({ input_sources: ["tax"] });
    expect(ctx).toContain("get_records(shapes=[...])");
    expect(ctx).toContain("get_source_record(shape, rowid, address_id)");
    expect(ctx).toContain("identity_confidence");
  });
});

describe("the source glossary", () => {
  test("drive no longer claims to be an independent DMV source", () => {
    expect(SOURCE_HUMAN_PHRASES["drive"]).toBe("licence-bearing loan record");
    const glossary = buildProseRegisterLines("finding, caveats").join("\n");
    expect(glossary).toContain("drive → licence-bearing loan record");
    expect(glossary).not.toContain("driver's-license record");
  });
});
