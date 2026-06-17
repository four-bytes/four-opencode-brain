import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const DIST_PATH = join(import.meta.dir, "..", "dist", "four-opencode-brain.js");
const PKG_PATH = join(import.meta.dir, "..", "package.json");

describe("dist-integrity", () => {
  const dist = readFileSync(DIST_PATH, "utf-8");

  test("forProject is present at least 2 times (definition + call site)", () => {
    const matches = dist.match(/forProject/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("forService is present at least 2 times (definition + call site)", () => {
    const matches = dist.match(/forService/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("forSession is present at least 1 time (definition)", () => {
    const matches = dist.match(/forSession/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test("version is read dynamically from package.json (not inlined)", () => {
    // The dist must contain readFileSync + package.json to prove version is read at runtime
    const hasReadFileSync = /readFileSync/.test(dist);
    const hasPackageJson = /package\.json/.test(dist);
    expect(hasReadFileSync).toBe(true);
    expect(hasPackageJson).toBe(true);
  });
});
