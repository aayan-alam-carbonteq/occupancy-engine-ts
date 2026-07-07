import { describe, expect, test } from "bun:test";
import { resolveGraphqlUrl } from "../cli/run_address.ts";

describe("resolveGraphqlUrl", () => {
  test("prefers the flag, falls back to env, else undefined", () => {
    expect(resolveGraphqlUrl("http://flag", "http://env")).toBe("http://flag");
    expect(resolveGraphqlUrl(undefined, "http://env")).toBe("http://env");
    expect(resolveGraphqlUrl(undefined, undefined)).toBeUndefined();
  });
});
