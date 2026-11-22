import type { Layer, LayerConfig, LayerContent } from "../layers.js";

export class TaskSliceLayer implements Layer {
  config: LayerConfig;
  private lastContent?: LayerContent;
  private lastFetchTime = 0;

  constructor() {
    this.config = {
      id: "task_slice",
      order: 3,
      enabled: true,
      ttlMs: 30 * 60 * 1000,
    };
  }

  async generate(): Promise<LayerContent> {
    const now = Date.now();

    if (this.lastContent && (now - this.lastFetchTime) < (this.config.ttlMs || 0)) {
      return this.lastContent;
    }

    const task = process.env.OPENDOC_TASK || process.env.TASK || "";

    if (!task.trim()) {
      const empty: LayerContent = { content: "", updatedAt: now, source: "task_slice (no task)" };
      this.lastContent = empty;
      this.lastFetchTime = now;
      return empty;
    }

    const content = [
      "CURRENT TASK",
      task,
    ].join("\n");

    const result: LayerContent = { content, updatedAt: now, source: "OPENDOC_TASK env" };
    this.lastContent = result;
    this.lastFetchTime = now;
    return result;
  }
}
