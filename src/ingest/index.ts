// ---------------------------------------------------------------------------
// Brain Ingestion Pipeline
//
// 1. Resolve path
// 2. Walk files (recursive if dir, single if file)
// 3. Detect language from extension
// 4. 2MB file size cap (skip oversized files, never read content → avoid OOM)
// 5. Content-hash check against files table → skip unchanged
// 6. Upsert files table (FK-preserving: ON CONFLICT DO UPDATE, keeps rowid)
// 7. Insert documents table (dedup via BEFORE INSERT trigger)
// 8. Extract symbols (code files only, 10s timeout)
// 9. Chunk content (token-based)
// 10. Insert chunks (dedup via BEFORE INSERT trigger, includes token_count)
// 11. Per-file SAVEPOINT for atomicity (individual files, not the entire ingest)
// ---------------------------------------------------------------------------

import { stat } from "fs/promises";
import { resolve } from "path";
import type { Database } from "bun:sqlite";

import { generateId, hashBuffer, hashContent, checkpointDatabase } from "../schema";
import { log } from "../logger";
import { ingestMutex } from "./mutex";
import { resolveFiles, isBinaryContent, isPathologicalText, type WalkResult, type WalkedFile } from "./loader";
import { chunkContent, FileBudgetExceededError, type ChunkResult, type Chunk } from "./chunker";
import { extractSymbols } from "./symbolExtractor";
import { computeEmbeddings, insertEmbeddings } from "./embed";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestResult {
  filesFound: number;
  filesSkipped: number; // hash match — already indexed
  filesProcessed: number; // total processed (indexed + skipped)
  filesIndexed: number; // new or updated
  unsupported: number;  // excluded at walk time — unsupported extension
  chunksCreated: number;
  chunksEmbedded: number; // chunks successfully embedded into vec0
  documentsCreated: number;
  binarySkipped: number; // files/chunks skipped due to binary content detection
  minifiedSkipped: number; // minified/long-line/generated files skipped
  errors: string[];
  durationMs: number;
}

export interface ProgressUpdate {
  current: number;
  total: number;
  currentFile?: string;
  currentFileSize?: number;
}

export interface IngestOptions {
  recursive?: boolean;
  reIndex?: boolean;
  /** Project path for project_hash tagging on documents and symbols. */
  project?: string;
  /** Called after each file for progress reporting.
   *  Receives { current, total, currentFile?, currentFileSize? }. */
  progressCallback?: (update: ProgressUpdate) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size for ingestion (2 MB). Files larger than this are skipped. */
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

/** Default per-file CPU budget (2 s). Files exceeding it are skipped with a warning. */
const DEFAULT_FILE_TIME_BUDGET_MS = 2_000;

/**
 * Resolve the per-file CPU budget from `BRAIN_FILE_TIME_BUDGET_MS`.
 *
 * Read at ingest start (not module load) so the value can be tuned per run
 * and exercised by tests.
 */
function resolveFileTimeBudgetMs(): number {
  const raw = process.env.BRAIN_FILE_TIME_BUDGET_MS;
  if (!raw) return DEFAULT_FILE_TIME_BUDGET_MS;
  const n = Number(raw);
  const ms = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_FILE_TIME_BUDGET_MS;
  return Math.max(1, ms);
}

/** Per-file processing timeout (30 seconds). */
const FILE_TIMEOUT_MS = 30_000; // 30 seconds per file

/** Files exceeding this duration get logged to app.log as a warning. */
const SLOW_FILE_WARN_MS = 10_000; // 10 seconds

/** Delay before showing current file name in progress (3 seconds). */
const SLOW_FILE_DISPLAY_MS = 3_000;

// ---------------------------------------------------------------------------
// Progress event helpers (gated on BRAIN_DEBUG=true)
// ---------------------------------------------------------------------------

function emitProgressEvent(event: string, data: Record<string, unknown>): void {
  if (process.env.BRAIN_DEBUG !== "true") return;
  log("debug", `ingest.${event}`, typeof data === "object" ? JSON.stringify(data).slice(0, 500) : String(data));
}

/**
 * Roll back to a per-file savepoint and release it.
 *
 * `ROLLBACK TO` keeps the savepoint on the stack, so it must always be
 * followed by `RELEASE` to avoid leaking savepoints across files.
 */
function rollbackSavepoint(db: Database, name: string): void {
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
  } catch { /* best-effort */ }
  try {
    db.exec(`RELEASE SAVEPOINT ${name}`);
  } catch { /* best-effort */ }
}

/**
 * Read the current `wal_autocheckpoint` threshold (pages).
 * Falls back to SQLite's default (1000) if the pragma cannot be read.
 */
function readWalAutocheckpoint(db: Database): number {
  try {
    const row = db
      .query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint")
      .get();
    return row?.wal_autocheckpoint ?? 1000;
  } catch {
    return 1000;
  }
}

/** Set the `wal_autocheckpoint` threshold. Best-effort — never throws. */
function setWalAutocheckpoint(db: Database, pages: number): void {
  try {
    db.exec(`PRAGMA wal_autocheckpoint=${Math.max(0, Math.floor(pages))}`);
  } catch { /* best-effort */ }
}

/**
 * Run a PASSIVE WAL checkpoint. Must only be called OUTSIDE a write
 * transaction (never between SAVEPOINT and RELEASE), otherwise it fails or
 * blocks. Best-effort — never throws.
 */
function checkpointWalPassive(db: Database): void {
  try {
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Ingest a file or directory into the brain database.
 *
 * Implements content-hash dedup: files with unchanged content are skipped.
 * New/updated files are inserted into `files`, `documents`, and `chunks` tables.
 *
 * Each file is wrapped in a per-file SAVEPOINT for atomicity. On per-file error,
 * only that file's changes are rolled back and processing continues to the next file.
 */
export async function ingestPath(
  db: Database,
  targetPath: string,
  options?: IngestOptions,
): Promise<IngestResult> {
  const release = await ingestMutex.acquire();
  try {
    const startTime = Date.now();
    const result: IngestResult = {
      filesFound: 0,
      filesSkipped: 0,
      filesProcessed: 0,
      filesIndexed: 0,
      unsupported: 0,
      chunksCreated: 0,
      chunksEmbedded: 0,
      documentsCreated: 0,
      binarySkipped: 0,
      minifiedSkipped: 0,
      errors: [],
      durationMs: 0,
    };

    const recursive = options?.recursive !== false;
    const reIndex = options?.reIndex === true;
    const projectHash = options?.project ? hashContent(options.project) : "global";

    // ── 1. Resolve path ─────────────────────────────────────────────────
    let absolutePath: string;
    try {
      absolutePath = resolve(targetPath);
      await stat(absolutePath);
    } catch (err) {
      result.errors.push(`Path not found: ${targetPath}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // ── 2. Walk files ───────────────────────────────────────────────────
    let walkResult: WalkResult;
    try {
      walkResult = await resolveFiles(absolutePath, recursive);
    } catch (err) {
      result.errors.push(`Failed to walk path: ${String(err)}`);
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const walkedFiles = walkResult.files;
    result.filesFound = walkedFiles.length;
    result.filesProcessed = 0;
    result.unsupported = walkResult.skippedExt;
    result.minifiedSkipped = walkResult.skippedGenerated;

    emitProgressEvent("ingest.start", {
      totalFiles: walkedFiles.length,
      targetPath: absolutePath,
    });

    if (walkedFiles.length === 0) {
      result.durationMs = Date.now() - startTime;
      emitProgressEvent("ingest.done", { result });
      return result;
    }

    // ── File-count guard: warn at 500, hard-abort at 5000 ──────────────
    const FILE_COUNT_WARN = 500;
    const FILE_COUNT_ABORT = 5000;
    if (walkedFiles.length > FILE_COUNT_ABORT) {
      result.errors.push(`Aborted: ${walkedFiles.length} files found — exceeds hard limit of ${FILE_COUNT_ABORT}. Use a more specific path.`);
      result.durationMs = Date.now() - startTime;
      return result;
    }
    if (walkedFiles.length > FILE_COUNT_WARN) {
      log("warn", "ingest", `Large ingest: ${walkedFiles.length} files — may take a while`);
    }

    // Yield so event loop can handle HTTP requests + tool calls before ingest starts
    await new Promise(r => setTimeout(r, 0));

    const abortFlags = new Map<number, boolean>();
    const fileTimeBudgetMs = resolveFileTimeBudgetMs();

    /**
     * Process one file in two phases.
     *
     * Phase 1 (no transaction): stat, read, guards, hash + dedup check, decode,
     * chunking (tree-sitter) and embedding computation. This phase may await
     * and yield freely because no SQLite write lock is held.
     *
     * Phase 2 (one tight transaction): SAVEPOINT → files → documents → chunks
     * → vec0 vectors → symbols → RELEASE. Strictly synchronous: no await, no
     * yields, no setTimeout, no I/O — so the write lock spans a single
     * event-loop turn instead of being held across turns.
     */
    async function processFile(walked: WalkedFile, i: number, aborted: Map<number, boolean>): Promise<void> {
        const filePath = walked.path;
        const language = walked.language;
        const fileStart = Date.now();
        const deadline = fileStart + fileTimeBudgetMs;

        const skipForBudget = (): void => {
          log(
            "warn",
            "ingest.budget",
            `File exceeded ${fileTimeBudgetMs}ms budget — skipped: ${filePath}`,
            { path: filePath, budgetMs: fileTimeBudgetMs },
          );
          result.errors.push(`Time budget exceeded (${fileTimeBudgetMs}ms): ${filePath}`);
        };

        emitProgressEvent("ingest.progress", {
          current: i + 1,
          total: walkedFiles.length,
          file: filePath,
        });

        // ── 4. 2MB file size cap (before reading content) ───────────────
        let fileStats;
        try {
          fileStats = await stat(filePath);
        } catch (err) {
          result.errors.push(`Failed to stat ${filePath}: ${String(err)}`);
          return;
        }

        result.filesProcessed++;

        // Log per-file progress with a stable per-file key so a hang is attributable
        log("info", `ingest.file.${filePath}`, `Ingesting ${filePath}`, { path: filePath, size: fileStats.size });

        // Update counter immediately for every file (BEFORE MAX_FILE_SIZE gate — skipped files still advance the counter)
        options?.progressCallback?.({ current: result.filesProcessed, total: walkedFiles.length });

        if (fileStats.size > MAX_FILE_SIZE) {
          const msg = `Skipped (too large, ${(fileStats.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`;
          log("info", "ingest", msg);
          result.errors.push(msg);
          return;
        }

        // Only show filename in progress if the file takes longer than 3s
        let slowFileTimer: ReturnType<typeof setTimeout> | undefined;
        slowFileTimer = setTimeout(() => {
            options?.progressCallback?.({ current: result.filesProcessed, total: walkedFiles.length, currentFile: filePath, currentFileSize: fileStats.size });
        }, SLOW_FILE_DISPLAY_MS) as unknown as ReturnType<typeof setTimeout>;

        try {
          // ════════════════════════════════════════════════════════════════
          // PHASE 1 — all heavy work, NO transaction open
          // ════════════════════════════════════════════════════════════════

          // Read file as raw buffer — binary-safe hashing (avoids encoding issues)
          let buf: ArrayBuffer;
          try {
            buf = await Bun.file(filePath).arrayBuffer();
          } catch (err) {
            result.errors.push(`Failed to read ${filePath}: ${String(err)}`);
            return;
          }

          // Binary content guard: skip files with null bytes (safety net for misnamed binaries)
          if (isBinaryContent(new Uint8Array(buf))) {
            log("info", "ingest", `Skipped (binary content): ${filePath}`);
            result.binarySkipped++;
            return;
          }

          // Minified/long-line guard: never hand pathological text to tree-sitter/chunker
          const patho = isPathologicalText(new Uint8Array(buf));
          if (patho.pathological) {
            const msg = `Skipped (minified/long lines, ${patho.reason}): ${filePath}`;
            log("warn", "ingest.minified", msg, { path: filePath, size: buf.byteLength, ...patho.stats });
            result.minifiedSkipped++;
            result.errors.push(msg);
            return;
          }

          const contentHash = hashBuffer(new Uint8Array(buf));
          const size = buf.byteLength;

          // ── 5. Content-hash check — skip if unchanged (unless reIndex) ──
          // Read-only, so it does not need the write transaction.
          if (!reIndex) {
            const existing = db
              .query<{ content_hash: string }, [string]>(
                "SELECT content_hash FROM files WHERE path = ?",
              )
              .get(filePath);

            if (existing && existing.content_hash === contentHash) {
              result.filesSkipped++;
              return;
            }
          }

          // Convert buffer to text for document/chunk storage
          const content = new TextDecoder().decode(buf);
          const totalLines = content.split("\n").length;

          // IDs are generated up-front so chunking and the write phase agree.
          const fileId = generateId();
          const docId = generateId();
          const mtime = Date.now();

          // ── 8. Chunk content (symbol extraction happens inside chunker) ──
          // Tree-sitter runs here, in Phase 1, on a deadline that never starts
          // a long parse when the budget is nearly exhausted.
          let chunks: Chunk[];
          let chunkResult: ChunkResult;
          try {
            chunkResult = await chunkContent({
              documentId: docId,
              fileId,
              content,
              filePath,
              language,
              totalLines,
              deadline,
            });
            chunks = chunkResult.chunks;
          } catch (err) {
            if (err instanceof FileBudgetExceededError) {
              skipForBudget();
              return;
            }
            result.errors.push(`Failed to chunk ${filePath}: ${String(err)}`);
            return;
          }

          // Slow-file warning after chunking completes
          const fileElapsed = Date.now() - fileStart;
          if (fileElapsed > SLOW_FILE_WARN_MS) {
            log("warn", "ingest", `Slow file (${(fileElapsed / 1000).toFixed(1)}s): ${filePath} (${chunks.length} chunks)`);
          }

          // Re-check budget after chunking, before any writes.
          if (Date.now() > deadline) {
            skipForBudget();
            return;
          }

          // ── Embedding computation (async, still Phase 1 — no writes) ─────
          const preparedEmbeddings = chunks.length > 0
            ? await computeEmbeddings(
                db,
                chunks.map((c) => ({ chunkId: c.id, content: c.content, contentHash: c.contentHash })),
              )
            : [];

          // Re-check budget after embedding, before the write phase.
          if (Date.now() > deadline) {
            skipForBudget();
            return;
          }

          // 30s hard timeout fired during Phase 1 → skip cleanly, no tx.
          if (aborted.get(i)) {
            log("warn", "ingest.timeout", `Timeout processing ${filePath}: skipped before writes`, { path: filePath, timeoutMs: FILE_TIMEOUT_MS });
            return;
          }

          // Only commit side counters once the file is guaranteed to be written.
          result.binarySkipped += chunkResult.binarySkipped;

          // ════════════════════════════════════════════════════════════════
          // PHASE 2 — one tight synchronous write transaction
          // Rule: no await / no yield / no setTimeout / no I/O between
          // SAVEPOINT and RELEASE.
          // ════════════════════════════════════════════════════════════════
          const spFile = "brain_file_" + generateId();

          const filesIndexedBefore = result.filesIndexed;
          const docsCreatedBefore = result.documentsCreated;
          const chunksCreatedBefore = result.chunksCreated;
          const chunksEmbeddedBefore = result.chunksEmbedded;
          const revertCounters = (): void => {
            result.filesIndexed = filesIndexedBefore;
            result.documentsCreated = docsCreatedBefore;
            result.chunksCreated = chunksCreatedBefore;
            result.chunksEmbedded = chunksEmbeddedBefore;
          };

          db.exec(`SAVEPOINT ${spFile}`);

          // ── 6. Upsert files table (FK-preserving: keeps rowid for FTS5) ─
          try {
            db.run(
              `INSERT INTO files (id, path, content_hash, mtime, lang, size, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(path) DO UPDATE SET
                 content_hash = excluded.content_hash,
                 mtime         = excluded.mtime,
                 lang          = excluded.lang,
                 size          = excluded.size,
                 indexed_at    = datetime('now')`,
              [fileId, filePath, contentHash, mtime, language, size],
            );
          } catch (err) {
            rollbackSavepoint(db, spFile);
            revertCounters();
            result.errors.push(`Failed to insert file ${filePath}: ${String(err)}`);
            return;
          }

          // ── 7. Insert documents table ──────────────────────────────────
          const fileName = filePath.split("/").pop() ?? filePath;
          const filetype = filePath.split(".").pop() ?? "unknown";

          try {
            db.run(
              `INSERT OR IGNORE INTO documents (id, title, content, content_hash, type, path, language, filetype, project_hash)
               VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?)`,
              [docId, fileName, content, contentHash, filePath, language, filetype, projectHash],
            );

            // Check if document was actually inserted (not dedup'd)
            const docCount = db
              .query<{ c: number }, [string, string]>(
                "SELECT COUNT(*) AS c FROM documents WHERE path = ? AND content_hash = ?",
              )
              .get(filePath, contentHash)!.c;

            if (docCount > 0) {
              result.documentsCreated++;
            }
          } catch (err) {
            rollbackSavepoint(db, spFile);
            revertCounters();
            result.errors.push(`Failed to insert document ${filePath}: ${String(err)}`);
            return;
          }

          // ── 9. Insert chunks (includes token_count) ────────────────────
          // Clean up old chunks for this file before inserting new ones
          try {
            db.run("DELETE FROM chunks WHERE file_id = ?", [fileId]);
          } catch (err) {
            rollbackSavepoint(db, spFile);
            revertCounters();
            result.errors.push(`Failed to clear chunks ${filePath}: ${String(err)}`);
            return;
          }

          for (const chunk of chunks) {
            try {
              db.run(
                `INSERT OR IGNORE INTO chunks
                 (id, document_id, file_id, chunk_index, content, content_hash,
                  symbol, kind, start_line, end_line, chunk_type, token_count)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  chunk.id,
                  chunk.documentId,
                  chunk.fileId,
                  chunk.chunkIndex,
                  chunk.content,
                  chunk.contentHash,
                  chunk.symbol,
                  chunk.kind,
                  chunk.startLine,
                  chunk.endLine,
                  chunk.chunkType,
                  chunk.tokenCount,
                ],
              );
            } catch (err) {
              rollbackSavepoint(db, spFile);
              revertCounters();
              result.errors.push(
                `Failed to insert chunk ${chunk.chunkIndex} for ${filePath}: ${String(err)}`,
              );
              return;
            }
            result.chunksCreated++;
          }

          // ── 10. Insert vectors (vec0) — synchronous, non-fatal ─────────
          try {
            const embedded = insertEmbeddings(db, preparedEmbeddings);
            result.chunksEmbedded += embedded;
          } catch (err) {
            rollbackSavepoint(db, spFile);
            revertCounters();
            result.errors.push(`Embedding failed: ${String(err)}`);
            return;
          }

          // ── 11. Populate symbols table (global symbol store) ───────────
          for (const chunk of chunks) {
            if (chunk.symbol) {
              try {
                const symId = generateId();
                db.run(
                  `INSERT OR IGNORE INTO symbols (id, name, qualified_name, kind, project_hash, file_path, document_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  [
                    symId,
                    chunk.symbol.split(".").pop() ?? chunk.symbol,
                    chunk.symbol,
                    chunk.kind ?? null,
                    projectHash,
                    filePath,
                    docId,
                  ],
                );
              } catch (err) {
                rollbackSavepoint(db, spFile);
                revertCounters();
                log(
                  "warn",
                  "ingest.symbol_insert_failed",
                  `Symbol insert failed for ${filePath} (${chunk.symbol}): ${String(err)}`,
                  { path: filePath },
                );
                result.errors.push(
                  `Failed to insert symbol ${chunk.symbol} for ${filePath}: ${String(err)}`,
                );
                return;
              }
            }
          }

          // ── RELEASE per-file SAVEPOINT (commit of this file) ───────────
          db.exec(`RELEASE SAVEPOINT ${spFile}`);

          result.filesIndexed++;
          options?.progressCallback?.({ current: result.filesProcessed, total: walkedFiles.length });

          // Per-file timing debug (BRAIN_DEBUG only)
          if (process.env.BRAIN_DEBUG === "true") {
            log("debug", "ingest", `processed ${result.filesProcessed}/${walkedFiles.length}: ${filePath} (${Date.now() - fileStart}ms)`);
          }

          // Slow-file warning: log to app.log for diagnostics
          const elapsed = Date.now() - fileStart;
          if (elapsed > SLOW_FILE_WARN_MS) {
            log("warn", `ingest.slow_file.${filePath}`, `${filePath} took ${elapsed}ms`, { path: filePath, durationMs: elapsed, size });
          }
        } finally {
          if (slowFileTimer) clearTimeout(slowFileTimer);
        }
    }

    // Scope auto-checkpoint OFF for the duration of this ingest run.
    //
    // SQLite's default auto-checkpoint (1000 pages) can fire inside a commit,
    // blocking the single-threaded event loop for ~2 s on a large ingest. We
    // disable it only here and restore the previous value in the finally, so
    // memory / knowledge / analytics writes keep their normal WAL behaviour
    // (their WAL must not grow without bound).
    //
    // Between files — always after RELEASE, never inside the per-file
    // SAVEPOINT — a PASSIVE checkpoint copies committed frames into the main
    // DB and resets the WAL. Because it runs after every file, the WAL never
    // accumulates more than a single file's frames and can never reach the
    // 1000-page auto-checkpoint threshold that caused the stall.
    const previousAutocheckpoint = readWalAutocheckpoint(db);
    setWalAutocheckpoint(db, 0);
    try {
      for (const [i, walked] of walkedFiles.entries()) {
          try {
              await Promise.race([
                  processFile(walked, i, abortFlags),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FILE_TIMEOUT_MS))
              ]);
          } catch (err) {
              if (err instanceof Error && err.message === 'timeout') {
                  abortFlags.set(i, true);
                  emitProgressEvent("ingest.file_timeout", { file: walked.path });
                  log("warn", "ingest.timeout", `Timeout processing ${walked.path}: exceeded ${FILE_TIMEOUT_MS}ms`, { path: walked.path, timeoutMs: FILE_TIMEOUT_MS });
                  result.errors.push(`Timeout after ${FILE_TIMEOUT_MS}ms: ${walked.path}`);
                  continue; // Don't increment filesProcessed — processFile handles it if it completes
              }
              throw err;
          }

          // Yield so event loop can handle HTTP requests + tool calls
          await new Promise(r => setTimeout(r, 0));

          // Between-file PASSIVE checkpoint — outside the per-file SAVEPOINT.
          checkpointWalPassive(db);
      }

      // Final checkpoint before the pragma is restored (still outside any tx).
      checkpointWalPassive(db);
    } finally {
      setWalAutocheckpoint(db, previousAutocheckpoint);
    }

    // Truncate the WAL after restoring normal auto-checkpoint behaviour.
    checkpointDatabase(db);

    result.durationMs = Date.now() - startTime;
    emitProgressEvent("ingest.done", { result });
    return result;
  } finally {
    release();
  }
}
