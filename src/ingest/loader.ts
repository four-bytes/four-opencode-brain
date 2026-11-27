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
  skippedGenerated: number;
}

// ---------------------------------------------------------------------------
// Generated artifact filter
// ---------------------------------------------------------------------------

const GENERATED_ARTIFACT_PATTERNS: RegExp[] = [
  /\.min\.(?:js|mjs|cjs|css)$/i,
  /[-.]min\.(?:js|mjs|cjs|css)$/i,
  /\.bundle\.js$/i,
  /\.(?:js|css)\.map$/i,
  /\.map$/i,
];

/** True for minified/bundled JS/CSS and source maps — never index these. */
export function isGeneratedArtifact(filePath: string): boolean {
  return GENERATED_ARTIFACT_PATTERNS.some((re) => re.test(filePath));
}

// ---------------------------------------------------------------------------
// Long-line analysis (minified/generated text detection)
// ---------------------------------------------------------------------------

export const MAX_LINE_LENGTH = 20 * 1024; // 20 KB single line
export const MAX_AVG_LINE_LENGTH = 1024;  // 1 KB average

export interface LineStats {
  lineCount: number;
  maxLineLength: number;
  avgLineLength: number;
}

export interface PathologicalText {
  pathological: boolean;
  reason: string | null;
  stats: LineStats;
}

/** Scan raw bytes and derive line count / max / average line lengths. */
export function analyzeLineLengths(buf: Uint8Array): LineStats {
  const totalBytes = buf.length;
  if (totalBytes === 0) {
    return { lineCount: 0, maxLineLength: 0, avgLineLength: 0 };
  }

  let newlineCount = 0;
  let maxLineLength = 0;
  let currentLineLength = 0;

  for (let i = 0; i < totalBytes; i++) {
    if (buf[i] === 0x0a) {
      newlineCount++;
      if (currentLineLength > maxLineLength) maxLineLength = currentLineLength;
      currentLineLength = 0;
    } else {
      currentLineLength++;
    }
  }
  if (currentLineLength > maxLineLength) maxLineLength = currentLineLength;

  const lineCount = newlineCount + 1;
  const avgLineLength = Math.round(totalBytes / lineCount);
  return { lineCount, maxLineLength, avgLineLength };
}

/**
 * Detect minified/generated text that would block the event loop in tree-sitter
 * or produce quadratic chunking work.
 */
export function isPathologicalText(buf: Uint8Array): PathologicalText {
  const stats = analyzeLineLengths(buf);
  if (buf.length === 0) {
    return { pathological: false, reason: null, stats };
  }

  if (stats.maxLineLength > MAX_LINE_LENGTH) {
    return {
      pathological: true,
      reason: `max line ${stats.maxLineLength}B > ${MAX_LINE_LENGTH}B`,
      stats,
    };
  }
  if (stats.avgLineLength > MAX_AVG_LINE_LENGTH) {
    return {
      pathological: true,
      reason: `avg line ${stats.avgLineLength}B > ${MAX_AVG_LINE_LENGTH}B`,
      stats,
    };
  }

  return { pathological: false, reason: null, stats };
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

const FULL_SCAN_SIZE = 64 * 1024; // 64 KB — files ≤ this get fully scanned
const BINARY_RATIO_THRESHOLD = 0.3;

function isPrintable(b: number): boolean {
  if (b === 0x09 || b === 0x0a || b === 0x0d) return true; // tab, lf, cr
  if (b >= 0x20 && b <= 0x7e) return true;                // ascii printable
  if (b >= 0x80) return true;                              // utf-8 continuation/start
  return false;
}

/** Check a specific byte range for binary content. */
function isBinaryRegion(buf: Uint8Array, start: number, end: number): boolean {
  let nonPrintable = 0;
  const len = end - start;
  for (let i = start; i < end; i++) {
    if (buf[i] === 0) return true; // null byte → binary
    if (!isPrintable(buf[i])) nonPrintable++;
  }
  return len > 0 && nonPrintable / len > BINARY_RATIO_THRESHOLD;
}

/**
 * Returns true if the buffer appears binary (null bytes or >30% non-printable chars).
 *
 * Strategy:
 * - Files ≤ 64KB: scans the **entire file content**
 * - Files  > 64KB: first 8KB thorough scan + statistical stride sampling + last 8KB thorough scan
 * - Null byte in any region → immediate binary
 */
export function isBinaryContent(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;

  if (buf.length <= FULL_SCAN_SIZE) {
    // Small file: scan entire content (existing behavior)
    return isBinaryRegion(buf, 0, buf.length);
  }

  // Large file (>64KB): first 8KB thorough scan + stride sampling + last 8KB

  // 1. Thorough scan of first 8KB (catches ELF/PE/Mach-O headers)
  const firstEnd = Math.min(8192, buf.length);
  if (isBinaryRegion(buf, 0, firstEnd)) return true;

  // 2. Statistical stride sampling: check every 512th byte across the ENTIRE file
  let nonPrintable = 0;
  let sampled = 0;
  for (let i = 0; i < buf.length; i += 512) {
    if (buf[i] === 0) return true; // null byte → immediate binary
    if (!isPrintable(buf[i])) nonPrintable++;
    sampled++;
  }
  if (nonPrintable / sampled > BINARY_RATIO_THRESHOLD) return true;

  // 3. Thorough scan of last 8KB (catches trailers, symbol tables)
  const lastStart = Math.max(0, buf.length - 8192);
  if (isBinaryRegion(buf, lastStart, buf.length)) return true;

  return false;
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
  let skippedGenerated = 0;

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
        if (isGeneratedArtifact(fullPath)) {
          skippedGenerated++;
          continue;
        }
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
  log(
    "info",
    "walker",
    `Walked ${dirPath}: ${files.length} files (${skippedExt} skipped — unsupported extension, ${skippedGenerated} skipped — generated artifact)`,
  );
  return { files, skippedExt, skippedGenerated };
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
    if (isGeneratedArtifact(targetPath)) {
      return { files: [], skippedExt: 0, skippedGenerated: 1 };
    }
    const language = detectLanguage(targetPath);
    return {
      files: [{ path: targetPath, language }],
      skippedExt: language === null ? 1 : 0,
      skippedGenerated: 0,
    };
  }

  if (stats.isDirectory()) {
    return walkDirectory(targetPath, recursive);
  }

  throw new Error(`Not a file or directory: ${targetPath}`);
}
