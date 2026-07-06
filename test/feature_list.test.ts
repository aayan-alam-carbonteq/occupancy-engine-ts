import { describe, expect, test } from "bun:test";
import features from "../feature_list.json";

const STATUSES = new Set(["not_started", "in_progress", "blocked", "passing"]);
const REQUIRED = ["id", "priority", "area", "title", "user_visible_behavior", "status", "verification", "evidence", "notes"];

describe("feature_list.json", () => {
  test("is a non-empty array", () => {
    expect(Array.isArray(features)).toBe(true);
    expect((features as unknown[]).length).toBeGreaterThan(0);
  });

  test("every entry has the required fields and a valid status", () => {
    for (const f of features as Record<string, unknown>[]) {
      for (const key of REQUIRED) expect(f).toHaveProperty(key);
      expect(typeof f.id).toBe("string");
      expect(typeof f.priority).toBe("number");
      expect(STATUSES.has(f.status as string)).toBe(true);
    }
  });

  test("ids are unique", () => {
    const ids = (features as { id: string }[]).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("at most one feature is in_progress", () => {
    const inProgress = (features as { status: string }[]).filter((f) => f.status === "in_progress");
    expect(inProgress.length).toBeLessThanOrEqual(1);
  });
});
