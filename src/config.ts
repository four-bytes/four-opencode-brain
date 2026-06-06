// ---------------------------------------------------------------------------
// Brain Configuration — structured config from env vars with validation
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrainConfig {
  /** Database + cache directory (default: ~/.local/share/four-opencode-brain) */
  home: string;
  /** Auto-ingest on plugin startup (default: true) */
  autoIngest: boolean;
  /** Enable debug logging (default: false) */
  debug: boolean;
  /** Max file size in MB for ingestion (default: 10) */
  maxFileSizeMb: number;
  /** Max tokens per chunk (default: 1024) */
  chunkMaxTokens: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: BrainConfig = {
  home: join(homedir(), ".local", "share", "four-opencode-brain"),
  autoIngest: true,
  debug: false,
  maxFileSizeMb: 10,
  chunkMaxTokens: 1024,
};

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: BrainConfig | null = null;

/**
 * Parse and validate a positive integer from a string env value.
 * Returns `fallback` on NaN, negative, or zero.
 */
function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Parse a boolean from a string env value.
 * "true", "1", "yes" → true; everything else → false.
 */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const lower = raw.toLowerCase().trim();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  return fallback;
}

/**
 * Get the singleton BrainConfig, parsing env vars on first call.
 *
 * Supported env vars:
 *   BRAIN_HOME             — database directory (default: ~/.local/share/…)
 *   BRAIN_AUTO_INGEST      — "false"|"0" disables auto-ingest (default: true)
 *   BRAIN_DEBUG            — "true" enables debug logging (default: false)
 *   BRAIN_MAX_FILE_SIZE_MB — max file size for ingestion (default: 10)
 *   BRAIN_CHUNK_MAX_TOKENS — max tokens per chunk (default: 1024)
 */
export function getConfig(): BrainConfig {
  if (instance) return instance;

  const home = process.env.BRAIN_HOME ?? DEFAULTS.home;
  const autoIngest = parseBool(process.env.BRAIN_AUTO_INGEST, DEFAULTS.autoIngest);
  const debug = parseBool(process.env.BRAIN_DEBUG, DEFAULTS.debug);
  const maxFileSizeMb = parsePositiveInt(
    process.env.BRAIN_MAX_FILE_SIZE_MB,
    DEFAULTS.maxFileSizeMb,
  );
  const chunkMaxTokens = parsePositiveInt(
    process.env.BRAIN_CHUNK_MAX_TOKENS,
    DEFAULTS.chunkMaxTokens,
  );

  instance = { home, autoIngest, debug, maxFileSizeMb, chunkMaxTokens };
  return instance;
}

/**
 * Reset the singleton config (useful for testing).
 */
export function resetConfig(): void {
  instance = null;
}
