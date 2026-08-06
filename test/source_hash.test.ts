import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HASHED_ROOTS, compute_source_hash, engine_source_hash } from "../src/fingerprint/source_hash.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const temps: string[] = [];

/** A miniature engine tree: two hashed roots, two hashed files, two files OUTSIDE the hashed set. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "engine-src-hash-"));
  temps.push(root);
  mkdirSync(join(root, "src", "agents"), { recursive: true });
  mkdirSync(join(root, "cli"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "agents", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "cli", "serve.ts"), "console.log('serve');\n");
  writeFileSync(join(root, "package.json"), '{"name":"x"}\n');
  writeFileSync(join(root, "bun.lock"), "lock\n");
  writeFileSync(join(root, "docs", "notes.md"), "notes\n");
  writeFileSync(join(root, "test", "a.test.ts"), "test\n");
  return root;
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

describe("compute_source_hash", () => {
  test("an unchanged tree hashes identically every time (stable across restarts)", () => {
    const root = makeTree();
    const first = compute_source_hash(root);
    expect(compute_source_hash(root)).toBe(first);
    expect(/^[0-9a-f]{64}$/.test(first)).toBe(true);
  });

  test("changing any hashed file changes the hash", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    writeFileSync(join(root, "src", "agents", "a.ts"), "export const a = 2;\n");
    expect(compute_source_hash(root)).not.toBe(before);
  });

  test("adding a nested file under a hashed root changes the hash (whole-tree walk, no curated list)", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    mkdirSync(join(root, "src", "fingerprint"), { recursive: true });
    writeFileSync(join(root, "src", "fingerprint", "b.ts"), "export const b = 1;\n");
    expect(compute_source_hash(root)).not.toBe(before);
  });

  test("files OUTSIDE the hashed set do not affect the hash (docs/, test/, progress churn)", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    writeFileSync(join(root, "docs", "notes.md"), "different notes\n");
    writeFileSync(join(root, "test", "a.test.ts"), "different test\n");
    writeFileSync(join(root, "PROGRESS.md"), "session record\n");
    expect(compute_source_hash(root)).toBe(before);
  });

  test("a missing hashed entry does not throw, and its removal changes the hash", () => {
    const root = makeTree();
    const before = compute_source_hash(root);
    rmSync(join(root, "bun.lock"));
    const after = compute_source_hash(root);
    expect(after).not.toBe(before);
    expect(/^[0-9a-f]{64}$/.test(after)).toBe(true);
  });
});

describe("engine_source_hash", () => {
  test("is this repo tree's hash, cached for the process", () => {
    const hash = engine_source_hash();
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true);
    expect(engine_source_hash()).toBe(hash);
    expect(hash).toBe(compute_source_hash(REPO_ROOT));
  });

  test("every hashed root actually ships in the image — .dockerignore must not exclude one", () => {
    const ignored = readFileSync(resolve(REPO_ROOT, ".dockerignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    for (const entry of HASHED_ROOTS) {
      expect(existsSync(resolve(REPO_ROOT, entry))).toBe(true);
      expect(ignored).not.toContain(entry);
    }
  });
});
