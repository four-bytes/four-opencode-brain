// ---------------------------------------------------------------------------
// Brain Ingestion Pipeline
//
// 1. Resolve path
// 2. Walk files (recursive if dir, single if file)
// 3. Detect language from extension
// 4. Content-hash check against files table → skip unchanged
// 5. Insert/update files table
// 6. Insert documents table (dedup via BEFORE INSERT trigger)
// 7. Extract symbols (code files only)
// 8. Chunk content
// 9. Insert chunks (dedup via BEFORE INSERT trigger)
// 10. Wrap in SAVEPOINT for atomicity
// ---------------------------------------------------------------------------

import { stat } from "fs/promises";
import { resolve } from "path";
import type { Database } from "bun:sqlite";

import { generateId, hashBuffer } from "../schema";
import { log } from "../logger";
import { resolveFiles, detectLanguage } from "./loader";
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
  filesIndexed: number; // new or updated
  chunksCreated: number;
  chunksEmbedded: number; // chunks successfully embedded into vec0
  documentsCreated: number;
  errors: string[];
  durationMs: number;
}

export interface IngestOptions {
  recursive?: boolean;
  reIndex?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const startTime = Date.now();
  const result: IngestResult = {
    filesFound: 0,
    filesSkipped: 0,
    filesIndexed: 0,
    chunksCreated: 0,
    chunksEmbedded: 0,
    documentsCreated: 0,
    errors: [],
    durationMs: 0,
  };

  const recursive = options?.recursive !== false;
  const reIndex = options?.reIndex === true;

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
  let walkedFiles: { path: string; language: string | null }[];
  try {
    walkedFiles = await resolveFiles(absolutePath, recursive);
  } catch (err) {
    result.errors.push(`Failed to walk path: ${String(err)}`);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  result.filesFound = walkedFiles.length;

  if (walkedFiles.length === 0) {
    result.durationMs = Date.now() - startTime;
    return result;
  }

  // ── 3. SAVEPOINT: wrap the entire ingest ────────────────────────────
  const sp = "brain_ingest_" + Date.now();
  db.exec(`SAVEPOINT ${sp}`);

  try {
    for (const walked of walkedFiles) {
      const filePath = walked.path;
      const language = walked.language;

      // Read file as raw buffer — binary-safe hashing (avoids encoding issues)
      let buf: ArrayBuffer;
      try {
        buf = await Bun.file(filePath).arrayBuffer();
      } catch (err) {
        result.errors.push(`Failed to read ${filePath}: ${String(err)}`);
        continue;
      }

      const contentHash = hashBuffer(new Uint8Array(buf));
      const size = buf.byteLength;

      // ── 4. Content-hash check — skip if unchanged (unless reIndex) ──
      if (!reIndex) {
        const existing = db
          .query<{ content_hash: string }, []>(
            "SELECT content_hash FROM files WHERE path = ?",
          )
          .get(filePath);

        if (existing && existing.content_hash === contentHash) {
          result.filesSkipped++;
          continue;
        }
      }

      // Convert buffer to text for document/chunk storage
      const content = new TextDecoder().decode(buf);

      // ── 5. Insert/update files table ───────────────────────────────
      const fileId = generateId();
      const mtime = Date.now();

      try {
        db.run(
          `INSERT OR REPLACE INTO files (id, path, content_hash, mtime, lang, size, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          [fileId, filePath, contentHash, mtime, language, size],
        );
      } catch (err) {
        result.errors.push(`Failed to insert file ${filePath}: ${String(err)}`);
        continue;
      }

      // ── 6. Insert documents table ──────────────────────────────────
      const docId = generateId();
      const fileName = filePath.split("/").pop() ?? filePath;
      const filetype = filePath.split(".").pop() ?? "unknown";

      try {
        db.run(
          `INSERT OR IGNORE INTO documents (id, title, content, content_hash, type, path, language, filetype)
           VALUES (?, ?, ?, ?, 'file', ?, ?, ?)`,
          [docId, fileName, content, contentHash, filePath, language, filetype],
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

      // ── 7. Extract symbols (code files only) ───────────────────────
      // (Chunker handles symbol extraction internally for code files)

      // ── 8. Chunk content ────────────────────────────────────────────
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

      // ── 9. Insert chunks ────────────────────────────────────────────
      const newChunkIds: string[] = [];
      for (const chunk of chunks) {
        try {
          db.run(
            `INSERT OR IGNORE INTO chunks
             (id, document_id, file_id, chunk_index, content, content_hash,
              symbol, kind, start_line, end_line, chunk_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

      // ── 10. Embed chunks (vec0) ─────────────────────────────────────
      if (newChunkIds.length > 0 && loadVec0(db)) {
        const embedded = embedChunks(db, newChunkIds);
        result.chunksEmbedded += embedded;
      }

      result.filesIndexed++;
    }

    // ── Commit ────────────────────────────────────────────────────────
    db.exec(`RELEASE SAVEPOINT ${sp}`);
  } catch (err) {
    // ── Rollback on error ────────────────────────────────────────────
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    result.errors.push(`Ingest failed: ${String(err)}`);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
