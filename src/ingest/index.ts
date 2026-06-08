// ---------------------------------------------------------------------------
// Brain Ingestion Pipeline
//
// 1. Resolve path
// 2. Walk files (recursive if dir, single if file)
// 3. Detect language from extension
// 4. 10MB file size cap (skip oversized files, never read content → avoid OOM)
// 5. Content-hash check against files table → skip unchanged
// 6. Upsert files table (FK-preserving: ON CONFLICT DO UPDATE, keeps rowid)
// 7. Insert documents table (dedup via BEFORE INSERT trigger)
// 8. Extract symbols (code files only, 10s timeout)
// 9. Chunk content (token-based)
// 10. Insert chunks (dedup via BEFORE INSERT trigger, includes token_count)
// 11. Wrap in SAVEPOINT for atomicity
// ---------------------------------------------------------------------------

import { stat } from "fs/promises";
import { resolve } from "path";
import type { Database } from "bun:sqlite";

import { generateId, hashBuffer, hashContent, checkpointDatabase } from "../schema";
import { log } from "../logger";
import { ingestMutex } from "./mutex";
import { resolveFiles, detectLanguage, isBinaryContent, type WalkResult } from "./loader";
import { chunkContent, type Chunk } from "./chunker";
import { extractSymbols } from "./symbolExtractor";
import { embedChunks } from "./embed";
import { loadVec0 } from "../embed/extensionLoader";

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
  errors: string[];
  durationMs: number;
}

export interface IngestOptions {
  recursive?: boolean;
  reIndex?: boolean;
  /** Project path for project_hash tagging on documents and symbols. */
  project?: string;
  /** Called after each file chunk+embed for progress reporting.
   *  Receives { current, total } — current is 0-based, total is filesFound. */
  progressCallback?: (progress: { current: number; total: number }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum file size for ingestion (10 MB). Files larger than this are skipped. */
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Progress event helpers (gated on BRAIN_DEBUG=true)
// ---------------------------------------------------------------------------

function emitProgressEvent(event: string, data: Record<string, unknown>): void {
  if (process.env.BRAIN_DEBUG !== "true") return;
  log("debug", `ingest.${event}`, typeof data === "object" ? JSON.stringify(data).slice(0, 500) : String(data));
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
 * The entire operation is wrapped in a SAVEPOINT. On error, all changes
 * are rolled back.
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
      filesIndexed: 0,
      unsupported: 0,
      chunksCreated: 0,
      chunksEmbedded: 0,
      documentsCreated: 0,
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

    emitProgressEvent("ingest.start", {
      totalFiles: walkedFiles.length,
      targetPath: absolutePath,
    });

    if (walkedFiles.length === 0) {
      result.durationMs = Date.now() - startTime;
      emitProgressEvent("ingest.done", { result });
      return result;
    }

    // ── 3. SAVEPOINT: wrap the entire ingest ────────────────────────────
    const sp = "brain_ingest_" + generateId();
    db.exec(`SAVEPOINT ${sp}`);

    // Yield so event loop can handle HTTP requests + tool calls before ingest starts
    await new Promise(r => setTimeout(r, 0));

    try {
      for (const [i, walked] of walkedFiles.entries()) {
        const filePath = walked.path;
        const language = walked.language;
        const fileStart = Date.now();

        emitProgressEvent("ingest.progress", {
          current: i + 1,
          total: walkedFiles.length,
          file: filePath,
        });

        // ── 4. 10MB file size cap (before reading content) ───────────────
        let fileStats;
        try {
          fileStats = await stat(filePath);
        } catch (err) {
          result.errors.push(`Failed to stat ${filePath}: ${String(err)}`);
          continue;
        }

        if (fileStats.size > MAX_FILE_SIZE) {
          result.errors.push(
            `Skipped ${filePath}: file size ${fileStats.size} exceeds 10MB cap`,
          );
          continue;
        }

        // Read file as raw buffer — binary-safe hashing (avoids encoding issues)
        let buf: ArrayBuffer;
        try {
          buf = await Bun.file(filePath).arrayBuffer();
        } catch (err) {
          result.errors.push(`Failed to read ${filePath}: ${String(err)}`);
          result.filesProcessed++;
          continue;
        }

        // Binary content guard: skip files with null bytes (safety net for misnamed binaries)
        if (isBinaryContent(new Uint8Array(buf))) {
          log("debug", "ingest", `Skipped binary content: ${filePath}`);
          continue;
        }

        const contentHash = hashBuffer(new Uint8Array(buf));
        const size = buf.byteLength;

        // ── 5. Content-hash check — skip if unchanged (unless reIndex) ──
        if (!reIndex) {
          const existing = db
            .query<{ content_hash: string }, []>(
              "SELECT content_hash FROM files WHERE path = ?",
            )
            .get(filePath);

          if (existing && existing.content_hash === contentHash) {
            result.filesSkipped++;
            result.filesProcessed++;
            options?.progressCallback?.({ current: result.filesProcessed, total: walkedFiles.length });
            continue;
          }
        }

        // Convert buffer to text for document/chunk storage
        const content = new TextDecoder().decode(buf);

        // ── 6. Upsert files table (FK-preserving: keeps rowid for FTS5) ─
        const fileId = generateId();
        const mtime = Date.now();

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
          result.errors.push(`Failed to insert file ${filePath}: ${String(err)}`);
          continue;
        }

        // ── 7. Insert documents table ──────────────────────────────────
        const docId = generateId();
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
            .query<{ c: number }, []>(
              "SELECT COUNT(*) AS c FROM documents WHERE path = ? AND content_hash = ?",
            )
            .get(filePath, contentHash)!.c;

          if (docCount > 0) {
            result.documentsCreated++;
          }
        } catch (err) {
          result.errors.push(`Failed to insert document ${filePath}: ${String(err)}`);
          continue;
        }

        // ── 8. Chunk content (symbol extraction happens inside chunker) ──
        const totalLines = content.split("\n").length;

        let chunks: Chunk[];
        try {
          chunks = await chunkContent({
            documentId: docId,
            fileId,
            content,
            filePath,
            language,
            totalLines,
          });
        } catch (err) {
          result.errors.push(`Failed to chunk ${filePath}: ${String(err)}`);
          continue;
        }

        // ── 9. Insert chunks (includes token_count) ───────────────────────
        // Clean up old chunks for this file before inserting new ones
        db.run("DELETE FROM chunks WHERE file_id = ?", [fileId]);
        const newChunkIds: string[] = [];
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

            result.chunksCreated++;
            newChunkIds.push(chunk.id);
          } catch (err) {
            result.errors.push(
              `Failed to insert chunk ${chunk.chunkIndex} for ${filePath}: ${String(err)}`,
            );
          }
        }

        // ── 10. Embed chunks (vec0) — non-fatal if unavailable ─────────
        if (newChunkIds.length > 0 && loadVec0(db)) {
          try {
            const embedded = await embedChunks(db, newChunkIds);
            result.chunksEmbedded += embedded;
          } catch (err) {
            result.errors.push(`Embedding failed (non-fatal): ${String(err)}`);
          }
        }

        // ── 11. Populate symbols table (global symbol store) ─────────────
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
            } catch {
              // Silently skip symbol insertion failures
            }
          }
        }

        result.filesIndexed++;
        result.filesProcessed++;
        options?.progressCallback?.({ current: result.filesProcessed, total: walkedFiles.length });

        // Per-file timing debug (BRAIN_DEBUG only)
        if (process.env.BRAIN_DEBUG === "true") {
          log("debug", "ingest", `processed ${result.filesProcessed}/${walkedFiles.length}: ${filePath} (${Date.now() - fileStart}ms)`);
        }

        // Yield so event loop can handle HTTP requests + tool calls
        await new Promise(r => setTimeout(r, 0));
      }

      // ── Commit ────────────────────────────────────────────────────────
      db.exec(`RELEASE SAVEPOINT ${sp}`);
    } catch (err) {
      // ── Rollback on error ────────────────────────────────────────────
      db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
      result.errors.push(`Ingest failed: ${String(err)}`);
    }

    // Checkpoint WAL to keep file manageable after large ingests
    checkpointDatabase(db);

    result.durationMs = Date.now() - startTime;
    emitProgressEvent("ingest.done", { result });
    return result;
  } finally {
    release();
  }
}
