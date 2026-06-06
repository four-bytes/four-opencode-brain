/**
 * Brain TUI Companion Plugin — renders ingest progress + version
 * into the opencode status bar footer (home_footer slot).
 *
 * Communicates with the server plugin via a shared JSON status file.
 * Polls every 2s; shows "• 🧠 ingest 42%" during indexing, "• 🧠 1.0.3" when idle.
 *
 * Uses @opentui primitives directly (no JSX) to avoid SolidJS build issues
 * with bun's jsx transform.
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Status file (shared with server plugin)
// ---------------------------------------------------------------------------

const STATUS_FILE = join(homedir(), ".cache", "opencode", "brain-status.json");

interface BrainStatus {
  ingesting: boolean;
  progress: number;  // 0–100
  current: number;
  total: number;
  version: string;
}

function readStatus(): BrainStatus | null {
  try {
    if (!existsSync(STATUS_FILE)) return null;
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as BrainStatus;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin version (must match package.json)
// ---------------------------------------------------------------------------

const VERSION: string = "1.0.3";

// ---------------------------------------------------------------------------
// Simple text node factory (creates @opentui TextNodeRenderable-compatible obj)
// ---------------------------------------------------------------------------

function makeTextNode(text: string): any {
  return {
    getText: () => text,
  };
}

// ---------------------------------------------------------------------------
// Footer renderer state
// ---------------------------------------------------------------------------

let currentText = `• 🧠 ${VERSION}`;
let intervalId: ReturnType<typeof setInterval> | null = null;

function startPolling(): void {
  const poll = () => {
    const status = readStatus();
    if (status?.ingesting && status.progress > 0) {
      currentText = `• 🧠 ingest ${status.progress}%`;
    } else {
      currentText = `• 🧠 ${VERSION}`;
    }
  };
  poll(); // immediate
  intervalId = setInterval(poll, 2000);
}

function stopPolling(): void {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

export default {
  tui: async (api: any) => {
    // Ensure cache dir exists
    try {
      const dir = join(homedir(), ".cache", "opencode");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }

    startPolling();

    api.slots.register({
      order: 999,
      setup() {
        startPolling();
      },
      dispose() {
        stopPolling();
      },
      slots: {
        home_footer: (_ctx: any, _props: any) => {
          // Return text as a simple string — @opentui slot renderer
          // accepts strings directly and renders them as TextNodeRenderable
          return currentText;
        },
      },
    });
  },
};
