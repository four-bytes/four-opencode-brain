// ---------------------------------------------------------------------------
// File walker with skip-dirs and language detection
// ---------------------------------------------------------------------------

import { readdir, stat } from "fs/promises";
import { extname, join } from "path";
import { log } from "../logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "bower_components",
  ".git",
  "dist",
  "build",
  ".bun",
  "coverage",
  ".idea",
  ".vscode",
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".tox",
  ".venv",
  "venv",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  "target",
  "zig-cache",
  "zig-out",
  ".opencode",
  "docker",
  "var",
  "bundles",
  "db-dumps",
]);

const EXTENSION_LANG_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".php": "php",
  ".rs": "rust",
  ".py": "python",
  ".java": "java",
  ".go": "go",
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sc": "scala",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hrl": "erlang",
  ".hs": "haskell",
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".fs": "fsharp",
  ".fsx": "fsharp",
  ".zig": "zig",
  ".nim": "nim",
  ".cr": "crystal",
  ".pl": "perl",
  ".pm": "perl",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".sass": "sass",
  ".less": "less",
  ".vue": "vue",
  ".svelte": "svelte",
  ".xml": "xml",
  ".svg": "svg",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".cfg": "ini",
  ".conf": "ini",
  ".properties": "properties",
  ".env": "text",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "hcl",
  ".tfvars": "hcl",
  ".md": "markdown",
  ".rst": "restructuredtext",
  ".tex": "latex",
  ".txt": "text",
  ".csv": "csv",
  ".patch": "diff",
  ".diff": "diff",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".twig": "twig",
};

const BINARY_EXTENSIONS = new Set([
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".tgz", ".zst",
  ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".avif",
  ".mp3", ".mp4", ".wav", ".ogg", ".avi", ".mov", ".mkv", ".webm", ".flac",
  ".so", ".dylib", ".dll", ".o", ".a", ".obj", ".ko",
  ".exe", ".bin", ".out", ".app", ".msi", ".deb", ".rpm",
  ".wasm",
  ".pyc", ".pyo",
  ".class", ".jar", ".war", ".ear",
  ".db", ".sqlite", ".sqlite3", ".mdb",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".iso", ".dmg", ".img",
  ".pdf",
  ".map",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalkedFile {
  path: string;
  language: string | null;
}

export interface WalkResult {
  files: WalkedFile[];
  skippedExt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect language from file extension. Returns null for unknown. */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_LANG_MAP[ext] ?? null;
}

/** Returns true if the file extension is a known binary format. */
export function isBinaryExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

const BINARY_SCAN_BYTES = 256;
const BINARY_RATIO_THRESHOLD = 0.3;

function isPrintable(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true; // tab, lf, cr
  if (b >= 0x20 && b <= 0x7e) return true;                // ascii printable
  if (b >= 0x80) return true;                              // utf-8 continuation/start
  return false;
}

/** Returns true if the buffer appears binary (null bytes or >30% non-printable chars). */
export function isBinaryContent(buf: Uint8Array): boolean {
  const limit = Math.min(BINARY_SCAN_BYTES, buf.length);
  let nonPrintable = 0;
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true; // null byte → binary
    if (!isPrintable(buf[i])) nonPrintable++;
  }
  return nonPrintable / limit > BINARY_RATIO_THRESHOLD;
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
): Promise<WalkResult> {
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
        if (isBinaryExtension(fullPath)) continue;
        const language = detectLanguage(fullPath);
        if (language === null) {
          skippedExt++;
        } else {
          files.push({ path: fullPath, language });
          if (files.length % 1000 === 0) {
            log("info", "walker", `Scanning... ${files.length} files found (${skippedExt} skipped)`);
          }
        }
      }
    }
  }

  await walk(dirPath);
  log("info", "walker", `Walked ${dirPath}: ${files.length} files (${skippedExt} skipped — unsupported extension)`);
  return { files, skippedExt };
}

/**
 * Resolve a path and return the appropriate file list.
 * - If targetPath is a file, returns a single-entry array.
 * - If targetPath is a directory, walks it (optionally recursive).
 */
let _scanCount = 0;
export async function resolveFiles(
  targetPath: string,
  recursive: boolean = true,
): Promise<WalkResult> {
  const stats = await stat(targetPath);

  if (stats.isFile()) {
    const language = detectLanguage(targetPath);
    return { files: [{ path: targetPath, language }], skippedExt: language === null ? 1 : 0 };
  }

  if (stats.isDirectory()) {
    return walkDirectory(targetPath, recursive);
  }

  throw new Error(`Not a file or directory: ${targetPath}`);
}
