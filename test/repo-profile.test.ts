import { describe, it, expect } from "bun:test";
import { RepoProfileLayer } from "../src/layers/repo-profile.js";

describe("RepoProfileLayer", () => {
  it("generates empty content when no project files found", async () => {
    const layer = new RepoProfileLayer();
    const result = await layer.generate();
    expect(result.content.length).toBeLessThanOrEqual(3000);
    // Will be empty in CI/tmp dirs where no AGENTS.md exists
  });

  it("has config with id repo_profile", () => {
    const layer = new RepoProfileLayer();
    expect(layer.config.id).toBe("repo_profile");
    expect(layer.config.order).toBe(2);
  });
});
