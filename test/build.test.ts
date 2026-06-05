import { describe, test, expect } from "bun:test";
import { existsSync, statSync } from "node:fs";

describe("build", () => {
  test("dist/four-opencode-brain.js exists", () => {
    expect(existsSync("dist/four-opencode-brain.js")).toBe(true);
  });

  test("dist/four-opencode-brain.js is not empty", () => {
    const stat = statSync("dist/four-opencode-brain.js");
    expect(stat.size).toBeGreaterThan(10000); // at least 10KB
  });
});
