// ---------------------------------------------------------------------------
// File walker with skip-dirs and language detection
// ---------------------------------------------------------------------------

import { readdir, stat } from "fs/promises";
import { extname, join } from "path";
import os from "os";
import { log } from "../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".bun",
  "coverage",
  ".idea",
  ".vscode",
  "__pycache__",
  ".cache",
]);

const EXTENSION_LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".php": "php",
  ".md": "markdown",
  ".txt": "text",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkedFile {
  path: string;
  language: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect language from file extension. Returns null for unknown. */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANG_MAP[ext] ?? null;
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively, returning all files that pass skip filters.
 * Returns relative file paths.
 */
export async function walkDirectory(
  dirPath: string,
  recursive: boolean = true,
): Promise<WalkedFile[]> {
  const files: WalkedFile[] = [];
  let skippedExt = 0;

  async function walk(currentPath: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(currentPath);
    } catch (err) {
      log("warn", "walker", `Failed to read directory ${currentPath}: ${String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const fullPath = join(currentPath, entry);

      let stats;
      try {
        stats = await stat(fullPath);
      } catch (err) {
        log("warn", "walker", `Failed to stat ${fullPath}: ${String(err)}`);
        continue;
      }

      if (stats.isDirectory()) {
        if (recursive) {
          await walk(fullPath);
        }
      } else if (stats.isFile()) {
        const language = detectLanguage(fullPath);
        if (language === null) {
          skippedExt++;
        } else {
          files.push({ path: fullPath, language });
        }
      }
    }
  }

  await walk(dirPath);
  log("info", "walker", `Walked ${dirPath}: ${files.length} files (${skippedExt} skipped — unsupported extension)`);
  return files;
}

/**
 * Resolve a path and return the appropriate file list.
 * - If targetPath is a file, returns a single-entry array.
 * - If targetPath is a directory, walks it (optionally recursive).
 */
export async function resolveFiles(
  targetPath: string,
  recursive: boolean = true,
): Promise<WalkedFile[]> {
  const stats = await stat(targetPath);

  if (stats.isFile()) {
    const language = detectLanguage(targetPath);
    return [{ path: targetPath, language }];
  }

  if (stats.isDirectory()) {
    return walkDirectory(targetPath, recursive);
  }

  throw new Error(`Not a file or directory: ${targetPath}`);
}
