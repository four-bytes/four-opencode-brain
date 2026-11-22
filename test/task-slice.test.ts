import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskSliceLayer } from "../src/layers/task-slice.js";

describe("TaskSliceLayer", () => {
  const origTask = process.env.OPENDOC_TASK;

  afterEach(() => {
    if (origTask) process.env.OPENDOC_TASK = origTask;
    else delete process.env.OPENDOC_TASK;
  });

  it("returns empty when no task set", async () => {
    delete process.env.OPENDOC_TASK;
    const layer = new TaskSliceLayer();
    const result = await layer.generate();
    expect(result.content).toBe("");
  });

  it("returns task content when set", async () => {
    process.env.OPENDOC_TASK = "Implement cacheable prefixes";
    const layer = new TaskSliceLayer();
    const result = await layer.generate();
    expect(result.content).toContain("CURRENT TASK");
    expect(result.content).toContain("cacheable prefixes");
  });

  it("returns cached within TTL (30min)", async () => {
    process.env.OPENDOC_TASK = "task-1";
    const layer = new TaskSliceLayer();
    const r1 = await layer.generate();
    process.env.OPENDOC_TASK = "task-2";
    const r2 = await layer.generate();
    // cached — still shows task-1 (changed env but TTL not expired)
    expect(r2.content).toContain("task-1");
  });
});
