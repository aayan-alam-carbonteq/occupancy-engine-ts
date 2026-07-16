import { describe, expect, it } from "bun:test";
import { reportDestination } from "../cli/run_address.ts";

describe("reportDestination", () => {
  it("routes the report to the --out file whenever --out is given", () => {
    expect(reportDestination(true, "/x/out.json")).toBe("file");
    expect(reportDestination(false, "/x/out.json")).toBe("file");
  });

  it("keeps stdout progress-only: report to stderr when --progress and no --out", () => {
    expect(reportDestination(true, undefined)).toBe("stderr");
  });

  it("without --progress and no --out, report stays on stdout", () => {
    expect(reportDestination(false, undefined)).toBe("stdout");
  });
});
