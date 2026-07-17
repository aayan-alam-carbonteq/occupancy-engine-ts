import { describe, expect, test } from "bun:test";
import { render_context_sections } from "../src/agents/prompts.ts";

const LISTING_LINE =
  "Short-term rental listing found on vrbo: 3 bd / 2 ba / sleeps 6. Address match 92%.";

describe("render_context_sections: the rental market channel", () => {
  test("renders the rental market lines when the packet is authorized to see them", () => {
    const text = render_context_sections({
      input_address: "1104 SPRING RUN RD",
      input_zip: "40514",
      evidence_map: { rental_market_summary: [LISTING_LINE] },
    });
    expect(text).toContain("Rental Market");
    expect(text).toContain(`- ${LISTING_LINE}`);
  });

  test("renders NOTHING when empty — a blind run's prompt text is unchanged", () => {
    const text = render_context_sections({
      input_address: "1104 SPRING RUN RD",
      input_zip: "40514",
      evidence_map: { rental_market_summary: [] },
    });
    expect(text).not.toContain("Rental Market");
  });

  test("renders nothing when the field is absent entirely", () => {
    expect(
      render_context_sections({ input_address: "1104 SPRING RUN RD", evidence_map: {} }),
    ).not.toContain("Rental Market");
  });

  test("Property Types still renders '- none' when empty — that section is unchanged", () => {
    const text = render_context_sections({ input_address: "x", evidence_map: {} });
    expect(text).toContain("Property Types");
    expect(text).toContain("- none");
  });
});
