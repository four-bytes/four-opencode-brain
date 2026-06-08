// ---------------------------------------------------------------------------
// Embedding pipeline for vec0 — real embeddings via node-llama-cpp
// with hash-based pseudo-embedding fallback when model unavailable.
//
// - embedChunks() processes all chunks by ID, generates embeddings,
//   caches by content hash, and inserts into chunks_vec
// - generateEmbedding() produces a deterministic 384-dim vector from
//   content hash (fallback when real embedding model is unavailable)
// - float32ToBlob() serializes Float32Array to Uint8Array for SQLite
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import { hashContent } from "../schema";
import { sessionCache } from "../cache";
import { log } from "../logger";
import { loadVec0 } from "../embed/extensionLoader";
import { EmbeddingService } from "../embed/embeddingService";

// ---------------------------------------------------------------------------
// Float32Array ↔ BLOB serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a Float32Array to a Uint8Array suitable for SQLite BLOB storage.
 * The vec0 extension expects raw 32-bit float data.
 */
export function float32ToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer);
}

/**
 * Deserialize a BLOB (Uint8Array) back to Float32Array.
 */
export function blobToFloat32(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-embedding from content hash (FALLBACK)
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic 384-dim Float32Array from text content.
 *
 * This is a FALLBACK — it uses the SHA-256 hash of the content to produce
 * a pseudo-random but deterministic vector in range [-1, 1].
 *
 * Used only when the real embedding model (node-llama-cpp) is unavailable.
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
 * Prefers real embeddings via EmbeddingService (node-llama-cpp).
 * Falls back to hash-based pseudo-embeddings when model unavailable.
 *
 * @param db       Open brain database handle
 * @param chunkIds Array of chunk UUIDs to embed
 * @returns        Number of chunks successfully embedded
 */
export async function embedChunks(db: Database, chunkIds: string[]): Promise<number> {
  if (chunkIds.length === 0) return 0;

  // Guard: vec0 module must be loaded on this handle
  if (!loadVec0(db)) {
    log("warn", "embed", "vec0 extension not loaded on this handle — skipping embedding");
    return 0;
  }

  // Verify the chunks_vec table exists before proceeding
  const tableExists = db
    .query<{ c: number }, []>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='chunks_vec'",
    )
    .get()!;
  if (tableExists.c === 0) return 0;

  // ── Try to initialize real embedding model ────────────────────────────
  const embService = EmbeddingService.getInstance();
  let useRealEmbeddings = false;
  if (!embService.isAvailable() && !embService.getDimensions()) {
    // Try real embeddings unless explicitly disabled
    if (process.env.BRAIN_EMBED_DISABLE !== "true" && process.env.BRAIN_EMBED_DISABLE !== "1") {
      try {
        await embService.initialize();
        useRealEmbeddings = embService.isAvailable();
      } catch {
        useRealEmbeddings = false;
      }
    }
  } else {
    useRealEmbeddings = embService.isAvailable();
  }

  if (!useRealEmbeddings) {
    log("warn", "embed", "Real embedding model unavailable — using hash-based pseudo-embeddings");
  }

  let embedded = 0;

  // Lazy-prepared statements
  const getStmt = db.query<{ content: string; content_hash: string }, [string]>(
    "SELECT content, content_hash FROM chunks WHERE id = ?",
  );

  const insertStmt = db.query<unknown, [string, Uint8Array]>(
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
        if (useRealEmbeddings) {
          vec = await embService.embed(content);
        } else {
          vec = generateEmbedding(content);
        }
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
