// ---------------------------------------------------------------------------
// Vec0 extension loader — loads the vec0 SQLite extension from the build
// output at dist/extensions/<platform>/vec0.so (produced by scripts/build-vec.sh).
// No cache fallback — only the shipped build output is used.
// 
// Per-handle loading via WeakSet: each Database handle independently loads
// the extension. The RAG plugin loads once per server instance; the brain
// plugin opens a fresh handle per tool call — so we track per-handle.
// ---------------------------------------------------------------------------

import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";

/**
 * Platform directory name for SQLite extensions.
 */
function platformDir(): string | null {
  const { platform, arch } = process;
  if (platform === "linux" && arch === "x64") return "linux-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "win32" && arch === "x64") return "win32-x64";
  return null;
}

/**
 * Extension file extension per platform.
 */
function extSuffix(): string {
  const p = process.platform;
  if (p === "win32") return "dll";
  if (p === "darwin") return "dylib";
  return "so";
}

/**
 * Per-handle tracking: which Database handles already have vec0 loaded.
 * WeakSet allows GC of closed handles without explicit bookkeeping.
 */
const loadedHandles = new WeakSet<Database>();

/**
 * Error message from the last load attempt, for diagnostics.
 */
let lastError: string | null = null;

/**
 * Whether at least one handle has ever been successfully loaded.
 * Used for startup toasts / diagnostics.
 */
let anyLoaded = false;

/**
 * Try to load vec0 extension into the given database handle.
 * Looks only at dist/extensions/<platform>/vec0.<ext> — the shipped build output.
 * Returns true if loaded successfully (or already loaded on this handle),
 * false if extension not found or load failed.
 */
export function loadVec0(db: Database): boolean {
  // Already loaded globally — vec0 only safe to load once per process
  if (anyLoaded) return true;

  const pDir = platformDir();
  if (!pDir) {
    lastError = `Unsupported platform: ${process.platform}-${process.arch}`;
    return false;
  }

  const ext = extSuffix();
  const initFn = "sqlite3_vec_init";

  // Try multiple locations for the extension:
  // 1. process.cwd()/dist/extensions/<platform>/vec0.<ext> (development mode)
  // 2. import.meta.dir/extensions/<platform>/vec0.<ext> (bundled under dist/)
  // 3. ../../dist/extensions/<platform>/vec0.<ext> (from src/embed/ to project root)
  const resolved = import.meta.dir;
  const candidates = [
    join(process.cwd(), "dist", "extensions", pDir, `vec0.${ext}`),
    join(resolved, "extensions", pDir, `vec0.${ext}`),
    join(resolved, "..", "..", "dist", "extensions", pDir, `vec0.${ext}`),
  ];
  
  let localPath = "";
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      localPath = candidate;
      break;
    }
  }

  if (!localPath) {
    lastError = `Extension not found (tried: ${candidates.join(", ")})`;
    return false;
  }

  try {
    db.loadExtension(localPath, initFn);
    anyLoaded = true;
    lastError = null;
    return true;
  } catch (err: unknown) {
    lastError = `Failed to load vec0 extension: ${err instanceof Error ? err.message : String(err)}`;
    return false;
  }
}

/**
 * Get the last error message from a failed load attempt.
 */
export function getVec0Error(): string | null {
  return lastError;
}

/**
 * Check whether vec0 has been successfully loaded on at least one handle.
 */
export function isVec0Loaded(): boolean {
  return anyLoaded;
}

/**
 * Reset loaded state (useful for testing).
 */
export function resetVec0Loaded(): void {
  anyLoaded = false;
  lastError = null;
  // WeakSet cannot be cleared — individual handles will be GC'd naturally
}
