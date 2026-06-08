import { writeFileSync, mkdirSync, existsSync } from "fs";
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
  scanning?: boolean;
  searching?: boolean;
  ingesting?: boolean;
}

/** Merged state — published via event bus on every update */
let currentStatus: Record<string, unknown> = { phase: "init", version: "" };
let _version = "";

let _client: PluginInput["client"] | null = null;
let _statusFile = "";

/** Initialize with client for toast support */
export function initVersion(v: string): void {
  _version = v;
  write({ phase: "init", statusText: "initializing..." });
}

export function initStatus(client: PluginInput["client"], directory: string): void {
  _client = client;
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
        scanning: opts?.scanning ?? false,
        searching: opts?.searching ?? false,
        ingesting: opts?.ingesting ?? false,
        blocked: false,
      });
      break;

    case "success":
      write({
        phase: "idle",
        statusText: opts?.text ?? "",
        busy: false,
      });
      if (opts?.toast && _client) {
        _client.tui.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: opts.toastVariant ?? "success", duration: 5000 } });
      }
      break;

    case "warning":
      write({
        phase: "idle",
        statusText: opts?.text ?? "",
        busy: false,
      });
      if (opts?.toast && _client) {
        _client.tui.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: opts.toastVariant ?? "warning", duration: 5000 } });
      }
      break;

    case "error":
      write({
        phase: "idle",
        statusText: opts?.text ?? "error occurred",
        busy: false,
      });
      if (opts?.toast && _client) {
        _client.tui.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: "error", duration: 7000 } });
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
  _client?.tui.showToast({ body: { title: "Brain 🧠", message: msg, variant, duration: variant === "error" ? 7000 : 5000 } });
}
