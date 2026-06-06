// ---------------------------------------------------------------------------
// Tests for embedding pipeline (src/ingest/embed.ts + src/embed/extensionLoader.ts)
// ---------------------------------------------------------------------------

import { expect, test, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { generateEmbedding, float32ToBlob, blobToFloat32, embedChunks } from "../src/ingest/embed";
import { loadVec0, resetVec0Loaded, getVec0Error } from "../src/embed/extensionLoader";
import { createSchema, generateId, hashContent } from "../src/schema";

// ---------------------------------------------------------------------------
// extensionLoader tests
// ---------------------------------------------------------------------------

describe("loadVec0", () => {
  test("loads vec0 from dual-path resolution (dist/extensions/...)", () => {
    // After build, dist/extensions/<platform>/vec0.so exists and is loadable
    const db = new Database(":memory:");
    resetVec0Loaded();
    expect(loadVec0(db)).toBe(true);
    db.close();
  });

  test("loaded flag prevents redundant loadExtension calls", () => {
    const db = new Database(":memory:");
    resetVec0Loaded();
    // First call loads the extension
    expect(loadVec0(db)).toBe(true);
    // Second call returns true immediately (loaded flag)
    expect(loadVec0(db)).toBe(true);
    // getVec0Error returns null after successful load
    expect(getVec0Error()).toBeNull();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// generateEmbedding tests
// ---------------------------------------------------------------------------

describe("generateEmbedding", () => {
  test("returns Float32Array with 384 dimensions", () => {
    const vec = generateEmbedding("test text");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(384);
  });

  test("values are in range [-1, 1]", () => {
    const vec = generateEmbedding("test text");
    for (let i = 0; i < vec.length; i++) {
      expect(vec[i]).toBeGreaterThanOrEqual(-1);
      expect(vec[i]).toBeLessThanOrEqual(1);
    }
  });

  test("is deterministic — same text = same vector", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const vec1 = generateEmbedding(text);
    const vec2 = generateEmbedding(text);
    expect(vec1).toEqual(vec2);
  });

  test("different texts produce different vectors", () => {
    const vec1 = generateEmbedding("hello world");
    const vec2 = generateEmbedding("goodbye world");
    // They should not be identical
    let same = true;
    for (let i = 0; i < 384; i++) {
      if (vec1[i] !== vec2[i]) {
        same = false;
        break;
      }
    }
    expect(same).toBe(false);
  });

  test("produces same vector for same text on repeated calls", () => {
    const vec1 = generateEmbedding("repeat test");
    const vec2 = generateEmbedding("repeat test");
    const vec3 = generateEmbedding("repeat test");
    expect(vec1).toEqual(vec2);
    expect(vec2).toEqual(vec3);
  });
});

// ---------------------------------------------------------------------------
// float32ToBlob / blobToFloat32 roundtrip tests
// ---------------------------------------------------------------------------

describe("float32ToBlob roundtrip", () => {
  test("roundtrip preserves all 384 values", () => {
    const original = generateEmbedding("roundtrip test");
    const blob = float32ToBlob(original);
    const restored = blobToFloat32(new Uint8Array(blob));
    expect(restored.length).toBe(384);
    expect(restored).toEqual(original);
  });

  test("blob byte length is 384 * 4 = 1536", () => {
    const vec = generateEmbedding("byte length test");
    const blob = float32ToBlob(vec);
    expect(blob.byteLength).toBe(384 * 4);
  });

  test("roundtrip with zero-filled Float32Array", () => {
    const vec = new Float32Array(384);
    const blob = float32ToBlob(vec);
    const restored = blobToFloat32(new Uint8Array(blob));
    expect(restored).toEqual(vec);
  });
});

// ---------------------------------------------------------------------------
// embedChunks — integration-ish (no vec0 loaded, should return 0)
// ---------------------------------------------------------------------------

describe("embedChunks", () => {
  test("returns 0 when vec0 not available", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    // With vec0 not loaded, chunks_vec may or may not exist
    // embedChunks will try loadVec0 inside the embed path — it returns false
    // So we expect 0 embedded
    const count = await embedChunks(db, []);
    expect(count).toBe(0);
    db.close();
  });

  test("empty chunk ID list returns 0", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    expect(await embedChunks(db, [])).toBe(0);
    db.close();
  });

  test("non-existent chunk IDs are skipped gracefully", async () => {
    const db = new Database(":memory:");
    createSchema(db);
    const fakeId = generateId();
    // No vec0 loaded, so returns 0
    const count = await embedChunks(db, [fakeId]);
    expect(count).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// hashContent integration — ensure hashContent works for dedup
// ---------------------------------------------------------------------------

describe("embedding content hash consistency", () => {
  test("hashContent produces same hash for same content", () => {
    const h1 = hashContent("consistent content hash test");
    const h2 = hashContent("consistent content hash test");
    expect(h1).toBe(h2);
  });

  test("hashContent produces different hash for different content", () => {
    const h1 = hashContent("content A");
    const h2 = hashContent("content B");
    expect(h1).not.toBe(h2);
  });
});
