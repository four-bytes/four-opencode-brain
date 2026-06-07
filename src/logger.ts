// Re-exported from @four-bytes/opencode-plugin-lib
// Console output removed — opencode TUI already captures stdout.
// Structured JSONL logging enabled via CC_DEBUG=true.
import { createJsonlLogger } from "@four-bytes/opencode-plugin-lib";

type LogLevel = "debug" | "info" | "warn" | "error";

const jsonl = createJsonlLogger("four-opencode-brain");

/** No-op — JSONL logger is opt-in via CC_DEBUG. Kept for API compat. */
export function setSilent(_val: boolean): void {}

export function log(
  level: LogLevel,
  key: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  jsonl(`${level}.${key}`, { msg, ...(data ?? {}) });
}
