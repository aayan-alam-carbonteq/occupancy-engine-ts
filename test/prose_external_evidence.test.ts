//
// THE PROSE-SCRUBBER SURVIVAL TEST. The scrubber redacts "leaked" vocabulary from findings; this
// feature deliberately puts platform names and listing prose INTO findings. If it eats them, every
// gate stays green and the feature silently does nothing — the worst possible failure mode.
import { describe, expect, test } from "bun:test";
import { detect_leaks, redact_prose } from "../src/agents/prose_redaction.ts";

const FINDING =
  "A short-term rental listing was found on vrbo for this property (3 bd / 2 ba, sleeps 6), " +
  "matching the subject address at 92%. The listing record from realtor reports the home as for_rent.";

describe("the prose scrubber must not eat external evidence", () => {
  test("platform names and listing prose survive redaction intact", () => {
    const scrubbed = redact_prose(FINDING);
    expect(scrubbed).toContain("vrbo");
    expect(scrubbed).toContain("realtor");
    expect(scrubbed).toContain("short-term rental listing");
    expect(scrubbed).toContain("for_rent");
  });

  test("platform names are not reported as prose leaks", () => {
    const leaks = detect_leaks(FINDING).join(" ");
    expect(leaks).not.toContain("vrbo");
    expect(leaks).not.toContain("realtor");
    expect(leaks).not.toContain("for_rent");
  });

  test("the raw source tokens ARE still flagged — the model should humanize those", () => {
    // str_scan/property_facts are data-surface names, not evidence content. Flagging them is
    // correct and is what the register glossary gives the model a phrase for.
    expect(detect_leaks("The str_scan source shows a match.").join(" ")).toContain("str_scan");
  });
});

const REALTOR_FINDING =
  "Realtor history shows the home was listed for rent in 2026-05 ($2300) and 2025-03 ($2195), " +
  "sourced from AppfolioUnits; a foreclosure flag was present on the listing.";

describe("the prose scrubber must not eat realtor rental-history evidence (X-014)", () => {
  test("the property-manager source name and rental prose survive redaction intact", () => {
    const scrubbed = redact_prose(REALTOR_FINDING);
    expect(scrubbed).toContain("AppfolioUnits");
    expect(scrubbed).toContain("listed for rent");
    expect(scrubbed).toContain("foreclosure");
    expect(scrubbed).toContain("$2300");
  });

  test("none of that evidence content is reported as a leak", () => {
    const leaks = detect_leaks(REALTOR_FINDING).join(" ");
    expect(leaks).not.toContain("AppfolioUnits");
    expect(leaks).not.toContain("foreclosure");
    expect(leaks).not.toContain("listed");
  });
});
