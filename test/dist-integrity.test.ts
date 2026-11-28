import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const DIST_PATH = join(import.meta.dir, "..", "dist", "four-opencode-brain.js");
const TUI_DIST_PATH = join(import.meta.dir, "..", "dist", "four-opencode-brain-tui.jsx");
const PROGRESS_DIST_PATH = join(import.meta.dir, "..", "dist", "progress.jsx");
const SPINNER_DIST_PATH = join(import.meta.dir, "..", "dist", "spinner.jsx");

describe("dist-integrity", () => {
  const dist = readFileSync(DIST_PATH, "utf-8");

  test("forProject is present at least 1 time (call site)", () => {
    const matches = dist.match(/forProject/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
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

  test("TUI bundle imports TUI components from the plugin lib", () => {
    const tui = readFileSync(TUI_DIST_PATH, "utf-8");
    expect(tui).toContain("@four-bytes/opencode-plugin-lib/tui-components");
  });

  test("inlined progress/spinner artifacts are no longer emitted", () => {
    expect(existsSync(PROGRESS_DIST_PATH)).toBe(false);
    expect(existsSync(SPINNER_DIST_PATH)).toBe(false);
  });
});
