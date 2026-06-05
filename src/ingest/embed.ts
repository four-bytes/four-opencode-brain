// ---------------------------------------------------------------------------
// Embedding pipeline for vec0 — hash-based cache + placeholder embeddings
//
// - embedChunks() processes all chunks by ID, generates embeddings,
//   caches by content hash, and inserts into chunks_vec
// - generateEmbedding() produces a deterministic 384-dim vector from
//   content hash (placeholder until a real embedding model is added)
// - float32ToBlob() serializes Float32Array to ArrayBuffer for SQLite
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import { hashContent } from "../schema";
import { sessionCache } from "../cache";
import { log } from "../logger";

// ---------------------------------------------------------------------------
// Float32Array ↔ BLOB serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a Float32Array to an ArrayBuffer suitable for SQLite BLOB storage.
 * The vec0 extension expects raw 32-bit float data.
 */
export function float32ToBlob(vec: Float32Array): ArrayBuffer {
  return vec.buffer.slice(0); // copy to avoid shared reference issues
}

/**
 * Deserialize a BLOB (ArrayBuffer or Buffer) back to Float32Array.
 */
export function blobToFloat32(blob: ArrayBuffer | Uint8Array): Float32Array {
  if (blob instanceof Uint8Array) {
    return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  }
  return new Float32Array(blob);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-embedding from content hash
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 384-dim Float32Array from text content.
 *
 * This is a PLACEHOLDER — it uses the SHA-256 hash of the content to produce
 * a pseudo-random but deterministic vector in range [-1, 1].
 *
 * In a follow-up, this will call an actual embedding model (e.g. nomic-embed-text).
 * For now, the vec0 infrastructure works end-to-end for testing and development.
 */
export function generateEmbedding(text: string): Float32Array {
  const vec = new Float32Array(384);
  const h = hashContent(text);

  // Spread the hash bytes across the 384 dimensions
  // SHA-256 produces 64 hex chars → 32 bytes → we cycle through them
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }

  for (let i = 0; i < 384; i++) {
    // Cycle through the 32 bytes with some mixing
    const b = bytes[i % 32];
    const mix = ((b * (i + 1)) ^ (bytes[(i * 7) % 32])) & 0xff;
    vec[i] = (mix / 255) * 2 - 1; // range [-1, 1]
  }

  return vec;
}

// ---------------------------------------------------------------------------
// Batch embedding pipeline
// ---------------------------------------------------------------------------

/**
 * Embed all chunks with the given IDs into the chunks_vec table.
 *
 * Uses sessionCache.embeddings for hash-based dedup: if the same content hash
 * has already been embedded in this session, the cached vector is reused.
 *
 * @param db       Open brain database handle
 * @param chunkIds Array of chunk UUIDs to embed
 * @returns        Number of chunks successfully embedded
 */
export function embedChunks(db: Database, chunkIds: string[]): number {
  if (chunkIds.length === 0) return 0;

  // Verify the chunks_vec table exists before proceeding
  const tableExists = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
    )
    .get()!;
  if (tableExists.c === 0) return 0;

  let embedded = 0;

  // Lazy-prepared statements (within function scope for table existence check)
  const getStmt = db.query<{ content: string; content_hash: string }, [string]>(
    "SELECT content, content_hash FROM chunks WHERE id = ?",
  );

  const insertStmt = db.query<unknown, [string, ArrayBuffer]>(
    "INSERT OR IGNORE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)",
  );

  for (const chunkId of chunkIds) {
    try {
      const row = getStmt.get(chunkId);
      if (!row) continue;

      const { content, content_hash } = row;

      // Check session cache first
      let vec = sessionCache.embeddings.get(content_hash);
      if (!vec) {
        vec = generateEmbedding(content);
        sessionCache.embeddings.set(content_hash, vec);
      }

      // Insert into vec0 — float32 blob
      insertStmt.run(chunkId, float32ToBlob(vec));
      embedded++;
    } catch (err) {
      log("warn", "embed-chunk", `Failed to embed chunk ${chunkId}: ${String(err)}`);
    }
  }

  return embedded;
}
