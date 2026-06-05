// ---------------------------------------------------------------------------
// Vec0 extension loader — loads the vec0 SQLite extension with priority:
// 1. Local build (dist/extensions/<platform>/vec0.so)
// 2. Cache fallback (~/.local/share/four-opencode-brain/extensions/...)
// 3. Graceful failure (no crash if extension missing)
// ---------------------------------------------------------------------------

import { join } from "path";
import { existsSync } from "fs";
import type { Database } from "bun:sqlite";
import { homedir } from "os";

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
 * Try to load vec0 extension into the given database handle.
 * Returns true if loaded successfully, false if extension not found.
 * Maintains a static loaded flag to avoid redundant loadExtension calls.
 */
let loaded = false;

export function loadVec0(db: Database): boolean {
  if (loaded) return true;

  const pDir = platformDir();
  if (!pDir) return false;

  const ext = extSuffix();
  const initFn = "sqlite3_vec_init";

  // Priority 1: Local build alongside the plugin
  const localPath = join(
    import.meta.dir ?? __dirname,
    "..",
    "dist",
    "extensions",
    pDir,
    `vec0.${ext}`,
  );
  if (existsSync(localPath)) {
    try {
      db.loadExtension(localPath, initFn);
      loaded = true;
      return true;
    } catch {
      // Silently fall through
    }
  }

  // Priority 2: Cache in user home
  const cachePath = join(
    homedir(),
    ".local",
    "share",
    "four-opencode-brain",
    "extensions",
    pDir,
    `vec0.${ext}`,
  );
  if (existsSync(cachePath)) {
    try {
      db.loadExtension(cachePath, initFn);
      loaded = true;
      return true;
    } catch {
      // Silently fall through
    }
  }

  return false;
}

/**
 * Reset loaded state (useful for testing).
 */
export function resetVec0Loaded(): void {
  loaded = false;
}
