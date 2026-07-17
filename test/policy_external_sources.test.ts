import { describe, expect, test } from "bun:test";
import * as atomic from "../src/heuristics/atomic.ts";
import {
  EXTERNAL_EVIDENCE_NOTE,
  EXTERNAL_EVIDENCE_SOURCES,
  SUBSTANTIVE_SOURCES,
} from "../src/heuristics/policy.ts";

describe("external evidence source vocabulary", () => {
  test("names exactly the two external sources", () => {
    expect([...EXTERNAL_EVIDENCE_SOURCES]).toEqual(["str_scan", "property_facts"]);
  });

  test("they are deliberately NOT substantive sources", () => {
    const substantive = new Set<string>(SUBSTANTIVE_SOURCES);
    for (const source of EXTERNAL_EVIDENCE_SOURCES) {
      expect(substantive.has(source)).toBe(false);
    }
    // SUBSTANTIVE_SOURCES feeds row pre-seeding, the data-density gate, reliability weights,
    // RANKED_SOURCE_ORDER and _SOURCE_TOKEN_BY_PATH — the deterministic weighted synthesis.
    // Locking its contents makes any accidental widening fail here.
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

  test("the note records the injection route and the exclusion", () => {
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("--evidence-file");
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("input_sources");
    expect(EXTERNAL_EVIDENCE_NOTE).toContain("SUBSTANTIVE_SOURCES");
  });

  test("the stale withheld-evidence note is gone from atomic.ts", () => {
    // It asserted this data is excluded — which this change makes false — and was imported nowhere.
    expect(Object.keys(atomic)).not.toContain("WITHHELD_EXTERNAL_EVIDENCE_NOTE");
  });
});
