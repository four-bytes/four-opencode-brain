import { EventBus } from "@four-bytes/opencode-plugin-lib";

export const brainBus = new EventBus();

export interface BrainStatusEvent {
  status?: "init" | "busy" | "ready" | "error";
  statusText?: string;
  current?: number;
  total?: number;
  version?: string;
  error?: string;
}
