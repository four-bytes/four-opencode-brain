// ---------------------------------------------------------------------------
// Throttled, rate-limited logger — no ANSI colors, compact single-line output
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

interface ThrottleState {
  lastCall: number;
  count: number;
}

const throttles = new Map<string, ThrottleState>();

function shouldLog(key: string, intervalMs: number = 60000): boolean {
  const now = Date.now();
  const state = throttles.get(key);
  if (!state || now - state.lastCall > intervalMs) {
    throttles.set(key, { lastCall: now, count: 1 });
    return true;
  }
  state.count++;
  return false;
}

export function log(
  level: LogLevel,
  key: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (level === "debug" && process.env.BRAIN_DEBUG !== "true") return;

  if (level === "warn" || level === "info") {
    // Throttle repetitive messages to once per 60s
    if (!shouldLog(key, 60000)) return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[brain] ${timestamp} ${level.toUpperCase()} ${key}`;
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  const line = `${prefix} ${msg}${payload}`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
