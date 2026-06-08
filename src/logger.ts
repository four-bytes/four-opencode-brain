// ---------------------------------------------------------------------------
// Throttled, rate-limited console logger — captured by opencode session log
// ---------------------------------------------------------------------------

type LogLevel = "debug" | "info" | "warn" | "error";

interface ThrottleState {
  lastCall: number;
  count: number;
}

const throttles = new Map<string, ThrottleState>();
let silent = false;
let _logClient: any = null;

export function setLogClient(client: any): void {
  _logClient = client;
}

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

export function setSilent(val: boolean): void {
  silent = val;
}

export function log(
  level: LogLevel,
  key: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (level === "debug" && process.env.BRAIN_DEBUG !== "true") return;

  if (level === "warn" || level === "info") {
    if (!shouldLog(key, 60000)) return;
  }

  if (silent && level !== "error") return;

  const timestamp = new Date().toISOString();
  const prefix = `[brain] ${timestamp} ${level.toUpperCase()} ${key}`;
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  const line = `${prefix} ${msg}${payload}`;

  // App.log output (plugin mode) — additional structured channel
  if (_logClient) {
    const appLevel = level === "warn" ? "warn" : level === "error" ? "error" : level === "debug" ? "debug" : "info";
    _logClient.app?.log({
      body: { service: key, level: appLevel, message: msg, extra: data },
    }).catch(() => {});
    // Debug messages go ONLY to app.log — skip console
    if (level === "debug") return;
  }

  // Console output — preserved for user visibility (info/warn/error)
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (!silent) console.log(line);
}
