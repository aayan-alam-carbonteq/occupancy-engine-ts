import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEvidenceFile } from "../cli/run_address.ts";

const dir = mkdtempSync(join(tmpdir(), "oe-evidence-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, { encoding: "utf-8" });
  return path;
}

describe("readEvidenceFile", () => {
  test("parses a valid payload", () => {
    const path = write(
      "ok.json",
      JSON.stringify({
        scan_id: "s1",
        str_listings: [{ platform: "airbnb", address_match_pct: 91 }],
      }),
    );
    expect(readEvidenceFile(path).str_listings[0]!.platform).toBe("airbnb");
  });

  test("a missing file throws — never a silent fallback to blind", () => {
    // Running blind when evidence was meant to arrive produces a plausible, confident, wrong
    // investigation whose failure mode is indistinguishable from a legitimate clean result.
    expect(() => readEvidenceFile(join(dir, "nope.json"))).toThrow(/could not be read/);
  });

  test("malformed JSON throws", () => {
    expect(() => readEvidenceFile(write("bad.json", "{not json"))).toThrow(/not valid JSON/);
  });

  test("a schema-violating payload throws", () => {
    expect(() =>
      readEvidenceFile(write("wrong.json", JSON.stringify({ str_listings: [{ platform: "airbnb" }] }))),
    ).toThrow(/external evidence contract/);
  });

  test("an unknown key throws — strict() makes structural drift loud", () => {
    expect(() =>
      readEvidenceFile(write("extra.json", JSON.stringify({ scan_id: "s1", verdict: "risk" }))),
    ).toThrow(/external evidence contract/);
  });

  test("an empty-but-present payload is valid (negative evidence)", () => {
    expect(readEvidenceFile(write("empty.json", JSON.stringify({ scan_id: "s2" }))).str_listings).toEqual(
      [],
    );
  });
});

describe("cli exit codes", () => {
  test("a bad --evidence-file exits 2 before any investigation runs", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "cli/run_address.ts",
        "--address",
        "1104 SPRING RUN RD",
        // an unroutable port: if we ever reached the investigation this would fail differently
        "--graphql-url",
        "http://127.0.0.1:9/graphql",
        "--evidence-file",
        join(dir, "nope.json"),
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("--evidence-file could not be read");
  });

  test("a schema-violating --evidence-file exits 2", async () => {
    const path = write("cli_wrong.json", JSON.stringify({ str_listings: [{ platform: "airbnb" }] }));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        "cli/run_address.ts",
        "--address",
        "x",
        "--graphql-url",
        "http://127.0.0.1:9/graphql",
        "--evidence-file",
        path,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stderr).text()).toContain("external evidence contract");
  });
});
