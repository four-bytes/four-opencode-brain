// ---------------------------------------------------------------------------
// Timeout wrappers — race promises against a deadline, never crash
// ---------------------------------------------------------------------------

import { log } from "../logger";

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class TimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`Timeout after ${ms}ms: ${label}`);
    this.name = "TimeoutError";
  }
}

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Rejects with `TimeoutError` when the
 * deadline is exceeded. On timeout, logs a warning but does NOT crash.
 *
 * Callers **must** catch `TimeoutError` and return partial/fallback results.
 *
 * @param promise  The operation to wrap
 * @param ms       Timeout in milliseconds
 * @param label    Human-readable label for logging
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise: Promise<never> = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(ms, label));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
}

/**
 * Safe variant: wraps `withTimeout` and catches `TimeoutError`, logging a
 * warning and returning `fallback` instead of rejecting.
 */
export async function withTimeoutSafe<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  fallback: T,
): Promise<T> {
  try {
    return await withTimeout(promise, ms, label);
  } catch (err) {
    if (err instanceof TimeoutError) {
      log("warn", "timeout", `${label} timed out after ${ms}ms — returning fallback`);
      return fallback;
    }
    throw err; // rethrow non-timeout errors
  }
}
