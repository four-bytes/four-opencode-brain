// ---------------------------------------------------------------------------
// Per-session LRU cache using Map (TTL = process lifetime)
// ---------------------------------------------------------------------------

export class LRUCache<K, V> {
  private map = new Map<K, { value: V; ts: number }>();

  constructor(private maxEntries: number = 1000) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh LRU position
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first key in insertion order)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, { value, ts: Date.now() });
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Singleton session cache — reset on plugin init / opencode restart
// ---------------------------------------------------------------------------

export const sessionCache = {
  embeddings: new LRUCache<string, Float32Array>(500),   // text hash → embedding vector
  search: new LRUCache<string, unknown[]>(200),           // query+filters serialized → results
  chunks: new LRUCache<string, unknown>(500),             // chunk ID → chunk data
  hashes: new LRUCache<string, string>(2000),             // content → sha256 hex

  reset(): void {
    this.embeddings.clear();
    this.search.clear();
    this.chunks.clear();
    this.hashes.clear();
  },
};
