import { writeFileSync, mkdirSync, existsSync } from "fs";
import { createToast } from "@four-bytes/opencode-plugin-lib";
import type { PluginInput } from "@opencode-ai/plugin";
import { brainBus, type BrainStatusEvent } from "./event-bus";
import { getBrainStatusFile } from "./shared";

export type StatusState = "busy" | "success" | "warning" | "error" | "ready";

export interface StatusOpts {
  /** Status bar text (e.g. "Indexing files…", "Searching…") */
  text?: string;
  /** Toast message (shown only on success/warning/error) */
  toast?: string;
  /** Toast variant (defaults based on state) */
  toastVariant?: "info" | "success" | "warning" | "error";
  /** Progress info for busy states */
  progress?: number;
  current?: number;
  total?: number;
}

/** Merged state — published via event bus on every update */
let currentStatus: Record<string, unknown> = { phase: "init", version: "" };
let _version = "";

let toastFn: ReturnType<typeof createToast> | null = null;
let _statusFile = "";

/** Initialize with client for toast support */
export function initVersion(v: string): void {
  _version = v;
  write({ phase: "init", statusText: "initializing..." });
}

export function initStatus(client: PluginInput["client"], directory: string): void {
  toastFn = createToast(client, "Brain 🧠");
  _statusFile = getBrainStatusFile(directory);
}

function write(data: Record<string, unknown>): void {
  currentStatus = { ...currentStatus, ...data };
  const payload = { ...currentStatus, version: _version, updated: Date.now() };
  brainBus.emit("status", payload as BrainStatusEvent);
  try {
    if (_statusFile) {
      const dir = _statusFile.replace(/\/[^/]+$/, "");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(_statusFile, JSON.stringify(payload));
    }
  } catch { /* never crash on status file failure */ }
}

/**
 * Unified status update — one call for all tool operations.
 *
 * @example
 *   updateStatus("busy", { text: "Indexing files…", total: 100 });
 *   updateStatus("success", { toast: "Indexed 42 files" });
 *   updateStatus("error", { text: "Failed", toast: "Error: permission denied" });
 *   updateStatus("ready");
 */
export function updateStatus(state: StatusState, opts?: StatusOpts): void {
  switch (state) {
    case "busy":
      write({
        phase: "busy",
        statusText: opts?.text ?? "",
        progress: opts?.progress,
        current: opts?.current,
        total: opts?.total,
        scanning: false,
        blocked: false,
      });
      break;

    case "success":
      write({
        phase: "idle",
        statusText: opts?.text ?? "",
        busy: false,
      });
      if (opts?.toast && toastFn) {
        toastFn(opts.toast, opts.toastVariant ?? "success");
      }
      break;

    case "warning":
      write({
        phase: "idle",
        statusText: opts?.text ?? "",
        busy: false,
      });
      if (opts?.toast && toastFn) {
        toastFn(opts.toast, opts.toastVariant ?? "warning");
      }
      break;

    case "error":
      write({
        phase: "idle",
        statusText: opts?.text ?? "error occurred",
        busy: false,
      });
      if (opts?.toast && toastFn) {
        toastFn(opts.toast, "error");
      }
      break;

    case "ready":
      write({
        phase: "idle",
        statusText: "",
        busy: false,
      });
      break;
  }
}

/** Convenience wrapper for direct toast calls without status file updates */
export function toast(msg: string, variant: "info" | "success" | "warning" | "error" = "info", _title?: string): void {
  if (toastFn) toastFn(msg, variant);
}
