import { join } from "path";
import { homedir } from "os";
import { createHash } from "node:crypto";

/**
 * Returns a directory-scoped brain status file path.
 *
 * Each opencode session (project directory) gets its own status file,
 * preventing ingest progress from one session leaking into another's TUI.
 *
 * Uses MD5 hash of the resolved directory path for a stable identifier
 * that survives process restarts.
 */
export function getBrainStatusFile(directory: string): string {
  const hash = createHash("md5").update(directory).digest("hex").substring(0, 16);
  return join(homedir(), ".cache", "opencode", `brain-status-${hash}.json`);
}

/** @deprecated Use getBrainStatusFile(directory) — session-scoped */
export const BRAIN_STATUS_FILE = join(homedir(), ".cache", "opencode", "brain-status.json");
