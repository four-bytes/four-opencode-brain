import { expect, test, describe, beforeAll } from "bun:test";
import { LRUCache, sessionCache } from "../src/cache";
import { hashContent } from "../src/schema";

// ---------------------------------------------------------------------------
// LRUCache unit tests
// ---------------------------------------------------------------------------

describe("LRUCache", () => {
  test("set + get returns value", () => {
    const cache = new LRUCache<string, number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBe(2);
  });

  test("returns undefined for missing key", () => {
    const cache = new LRUCache<string, number>(5);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts oldest when maxEntries exceeded", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // should evict "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("re-accessing a key refreshes its LRU position", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Access "a" so it moves to most-recent
    cache.get("a");
    // Now "b" should be the LRU candidate
    cache.set("d", 4);
    expect(cache.get("a")).toBe(1); // still present
    expect(cache.get("b")).toBeUndefined(); // evicted
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  test("clear() empties all entries", () => {
    const cache = new LRUCache<string, number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  test("set overwrites existing value and updates position", () => {
    const cache = new LRUCache<string, number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Overwrite "a"
    cache.set("a", 99);
    // Now "b" is the LRU
    cache.set("d", 4);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("d")).toBe(4);
  });

  test("has() returns correct boolean", () => {
    const cache = new LRUCache<string, number>(5);
    cache.set("a", 1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  test("size reflects current entry count", () => {
    const cache = new LRUCache<string, number>(10);
    expect(cache.size).toBe(0);
    cache.set("a", 1);
    expect(cache.size).toBe(1);
    cache.set("b", 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  test("eviction respects maxEntries=1", () => {
    const cache = new LRUCache<string, number>(1);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sessionCache singleton
// ---------------------------------------------------------------------------

describe("sessionCache", () => {
  // Reset before testing to avoid cross-test pollution
  beforeAll(() => sessionCache.reset());

  test("has all four cache instances", () => {
    expect(sessionCache.embeddings).toBeInstanceOf(LRUCache);
    expect(sessionCache.search).toBeInstanceOf(LRUCache);
    expect(sessionCache.chunks).toBeInstanceOf(LRUCache);
    expect(sessionCache.hashes).toBeInstanceOf(LRUCache);
  });

  test("reset() clears all four caches", () => {
    sessionCache.embeddings.set("a", new Float32Array([0.1, 0.2]));
    sessionCache.search.set("query1", [{ id: 1 }]);
    sessionCache.chunks.set("chunk1", { data: "test" });
    sessionCache.hashes.set("content", "abc123");

    expect(sessionCache.embeddings.size).toBe(1);
    expect(sessionCache.search.size).toBe(1);
    expect(sessionCache.chunks.size).toBe(1);
    expect(sessionCache.hashes.size).toBe(1);

    sessionCache.reset();

    expect(sessionCache.embeddings.size).toBe(0);
    expect(sessionCache.search.size).toBe(0);
    expect(sessionCache.chunks.size).toBe(0);
    expect(sessionCache.hashes.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// hashContent consistency (shared via schema.ts)
// ---------------------------------------------------------------------------

describe("hashCache consistency", () => {
  test("hashContent returns consistent sha256 for same content", () => {
    const h1 = hashContent("same input string");
    const h2 = hashContent("same input string");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(h1)).toBe(true);
  });

  test("hashContent differs for different inputs", () => {
    const h1 = hashContent("input A");
    const h2 = hashContent("input B");
    expect(h1).not.toBe(h2);
  });
});
