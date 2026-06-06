import { createToast } from "@four-bytes/opencode-plugin-lib";
import type { PluginInput } from "@opencode-ai/plugin";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { BRAIN_STATUS_FILE } from "./shared";

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

/** Merged state — written to file on every update */
let currentStatus: Record<string, unknown> = { phase: "init" };

let toastFn: ReturnType<typeof createToast> | null = null;

/** Initialize with client for toast support */
export function initStatus(client: PluginInput["client"]): void {
  toastFn = createToast(client, "Brain 🧠");
}

function write(data: Record<string, unknown>): void {
  currentStatus = { ...currentStatus, ...data };
  try {
    const dir = BRAIN_STATUS_FILE.replace(/\/[^/]+$/, "");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BRAIN_STATUS_FILE, JSON.stringify({ ...currentStatus, updated: Date.now() }));
  } catch {
    // never crash on status file failure
  }
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
