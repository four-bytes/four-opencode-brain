import { writeFileSync, mkdirSync, existsSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import { BusClient } from "@four-bytes/opencode-plugin-lib";
import type { BrainStatusEvent } from "./event-bus";

export type StatusState = "busy" | "success" | "warning" | "error" | "ready";

export interface StatusOpts {
  /** Status bar text (e.g. "Indexing files…", "Searching…") */
  text?: string;
  /** Toast message (shown only on success/warning/error) */
  toast?: string;
  /** Toast variant (defaults based on state) */
  toastVariant?: "info" | "success" | "warning" | "error";
  /** Progress info for busy states */
  current?: number;
  total?: number;
}

/** Merged state — published via event bus on every update */
const _state = { current: {} as Record<string, unknown> };
_state.current = { status: "init", statusText: "", version: "" };
let _version = "";
let _sessionId = "";
let _channel = "brain/status";

let _client: PluginInput["client"] | null = null;
let _server: ReturnType<typeof Bun.serve> | null = null;
let _port = 0;
let _busPromise: Promise<BusClient> | null = null;

/** Initialize with client for toast support */
export function initVersion(v: string): void {
  _version = v;
  write({ status: "init", statusText: "initializing..." });
}

export function setSessionId(id: string): void {
  if (id === _sessionId) return;
  _sessionId = id;
  _channel = `brain/${id}`;
}

export function initStatus(client: PluginInput["client"], directory: string): void {
  _client = client;
  startStatusServer(directory);
}

function getBus(): Promise<BusClient> {
  if (!_busPromise) {
    _busPromise = BusClient.connect().catch((err) => {
      console.warn("[brain] BusClient connect failed:", (err as Error).message);
      throw err;
    });
  }
  return _busPromise;
}

export function startStatusServer(directory: string): void {
  if (_server) return;
  
  try {
    _server = Bun.serve({
      port: 0, // OS assigns free port — no collision possible
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/status") {
          const payload = { ..._state.current, version: _version, updated: Date.now() };
          return new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });
  } catch (err) {
    // Fallback: if Bun.serve fails (e.g., out of FDs), TUI will use default state
    _client?.app?.log({ body: { service: "brain", level: "error", message: "Failed to start status server", extra: { error: String(err) } } }).catch(() => {});
    return;
  }
  
  _port = _server.port;
  
  // Write port to session-scoped discovery file
  try {
    const hash = createHash("md5").update(directory).digest("hex").slice(0, 12);
    const portFile = join(homedir(), ".cache", "opencode", "brain", `status-port-${hash}.json`);
    const dir = portFile.replace(/\/[^/]+$/, "");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(portFile, JSON.stringify({ port: _port }));
  } catch { /* silently ignore */ }
}

export function stopStatusServer(): void {
  if (_server) {
    _server.stop();
    _server = null;
    _port = 0;
  }
}

function write(data: Record<string, unknown>): void {
  _state.current = { ..._state.current, ...data };
  const payload = { ..._state.current, version: _version } as BrainStatusEvent;

  // Real-time push via plugin bus (HTTP fallback still serves status endpoint)
  getBus()
    .then((bus) => bus.publish(_channel, payload))
    .catch((err) => {
      console.warn("[brain] Bus publish failed:", (err as Error).message);
    });
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
        status: "busy",
        statusText: opts?.text ?? "",
        current: opts?.current,
        total: opts?.total,
      });
      break;

    case "success":
      write({
        status: "ready",
        statusText: opts?.text ?? "",
      });
      if (opts?.toast && _client) {
        _client?.tui?.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: opts.toastVariant ?? "success", duration: 5000 } });
      }
      break;

    case "warning":
      write({
        status: "ready",
        statusText: opts?.text ?? "",
      });
      if (opts?.toast && _client) {
        _client?.tui?.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: opts.toastVariant ?? "warning", duration: 5000 } });
      }
      break;

    case "error":
      write({
        status: "error",
        statusText: opts?.text ?? "error occurred",
        error: opts?.text ?? "error occurred",
      });
      if (opts?.toast && _client) {
        _client?.tui?.showToast({ body: { title: "Brain 🧠", message: opts.toast, variant: "error", duration: 7000 } });
      }
      break;

    case "ready":
      write({
        status: "ready",
        statusText: "",
      });
      break;
  }
}

/** Convenience wrapper for direct toast calls without status file updates */
export function toast(msg: string, variant: "info" | "success" | "warning" | "error" = "info", _title?: string): void {
  _client?.tui?.showToast({ body: { title: "Brain 🧠", message: msg, variant, duration: variant === "error" ? 7000 : 5000 } });
}
