/**
 * EmbeddingService — generates text embeddings via node-llama-cpp.
 *
 * Singleton pattern (like SymbolExtractor). Downloads the GGUF model on first use,
 * then loads it via node-llama-cpp. Returns 384-dim Float32Array per embedding.
 *
 * Falls back to hash-based pseudo-embeddings when model is unavailable.
 *
 * Features a priority queue: search jobs (from embed()) are processed before
 * ingest jobs (from embedBatch()). The queue supports interleaving so that
 * interactive search queries are not blocked by bulk ingestion.
 *
 * @module
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { ensureModel } from './modelDownloader';
import { log } from '../logger';
import { generateEmbedding } from '../ingest/embed';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'all-MiniLM-L6-v2.Q8_0';
const DEFAULT_CACHE_DIR = join(homedir(), '.cache', 'four-opencode-brain', 'models');
const MAX_TEXT_LENGTH = 8192;

// ---------------------------------------------------------------------------
// Priority Queue Types
// ---------------------------------------------------------------------------

/**
 * The kind of embedding job — used to prioritise search over ingest.
 * - 'search':  high-priority, single-text (from embed())
 * - 'ingest':  low-priority, multi-text chunk (from embedBatch())
 */
type EmbedJobKind = 'search' | 'ingest';

/**
 * A unit of work in the embedding priority queue.
 */
interface EmbedJob {
  /** Job kind — search jobs are dequeued before ingest jobs */
  kind: EmbedJobKind;
  /** Texts to embed (1 for search, up to 10 for ingest chunks) */
  texts: string[];
  /** Called with results when the job completes successfully */
  resolve: (results: Float32Array[]) => void;
  /** Called with the error when the job fails */
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// EmbeddingService
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private static instance: EmbeddingService;

  private ctx: any = null;
  private model: any = null;
  private dimensions = 0;
  private initialized = false;
  private _available = false; // true when real model loaded successfully

  // Promise-lock for initialize() — parallel callers await the SAME promise
  private initPromise: Promise<void> | null = null;

  // Priority queue for embedding jobs
  private queue: EmbedJob[] = [];
  private processing = false;

  private constructor() {}

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Initialize the embedding model. Downloads the GGUF model on first use
   * and loads it via node-llama-cpp.
   *
   * Uses a Promise-lock pattern: multiple parallel callers receive the same
   * promise. After init completes (success or failure), `initPromise` stays
   * set so subsequent calls still return it.
   *
   * @param modelPath Optional path to a pre-downloaded GGUF model file.
   *                  If omitted, downloads all-MiniLM-L6-v2.Q8_0 automatically.
   * @param cacheDir  Optional cache directory (default: ~/.cache/four-opencode-brain/models/)
   */
  async initialize(modelPath?: string, cacheDir?: string): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (process.env.BRAIN_EMBED_ENABLE !== "true" && process.env.BRAIN_EMBED_ENABLE !== "1") {
        this.initialized = true;
        this._available = false;
        return;
      }

      try {
        const resolvedModelPath = modelPath ?? await ensureModel(DEFAULT_MODEL, cacheDir ?? DEFAULT_CACHE_DIR);
        log("debug", "embedding-service", "Resolving node-llama-cpp from plugin location", { metaUrl: import.meta.url });
        const llamaEntry = import.meta.resolve("node-llama-cpp");
        log("debug", "embedding-service", "Resolved node-llama-cpp entry", { entry: llamaEntry });
        const { getLlama } = await import(llamaEntry);
        // Skip binding binary test — fails in Worker context but binary works
        process.env.NODE_LLAMA_CPP_BINDING_TEST_LOG_LEVEL = "silent";
        process.env.NODE_LLAMA_CPP_SKIP_BINDING_TEST = "true";
        log("debug", "embedding-service", "Calling getLlama", { gpu: false, build: "auto" });
        const llama = await getLlama({ gpu: false, build: "auto" as any} as any);
        log("debug", "embedding-service", "getLlama succeeded", { gpu: llama.gpu });
        this.model = await llama.loadModel({ modelPath: resolvedModelPath });
        this.ctx = await this.model.createEmbeddingContext();
        this._available = true;
        log("info", "embedding-service", "Real embedding model loaded successfully");
      } catch (err) {
        this._available = false;
        log("error", "embedding-service", "Embedding init failed, falling back to hash-based", { error: String(err) });
      } finally {
        this.initialized = true;
      }
    })();

    return this.initPromise;
  }

  /**
   * Returns true if the real embedding model is loaded and available.
   * When false, callers should use the hash-based fallback.
   */
  isAvailable(): boolean {
    return this._available;
  }

  /**
   * Generate an embedding vector for a single text string.
   *
   * This is the high-priority path — if no queue contention exists the call
   * is dispatched directly (lowest latency). When the queue is busy the job
   * is unshifted to the front as a 'search' priority.
   *
   * - Empty strings → zero vector (all zeros, length `dimensions`)
   * - Long strings (>8192 chars) → truncated to 8192 chars
   *
   * @param text  Input text to embed
   * @returns     Float32Array of length `dimensions`
   */
  async embed(text: string): Promise<Float32Array> {
    // Fallback to hash-based pseudo-embeddings when real model unavailable
    if (!this._available) {
      return generateEmbedding(text);
    }

    // Fast path: no queue contention → call directly for lowest latency
    if (this.queue.length === 0 && !this.processing) {
      return this.embedDirect(text);
    }

    // Queue path: add as high-priority search job (unshift to front)
    return new Promise<Float32Array>((resolve, reject) => {
      const job: EmbedJob = {
        kind: 'search',
        texts: [text],
        resolve: (results) => resolve(results[0]),
        reject,
      };
      this.queue.unshift(job);
      this.pump();
    });
  }

  /**
   * Generate embeddings for multiple texts in batch.
   *
   * This is the low-priority ingest path. Texts are split into chunks of 10
   * and each chunk is pushed as an 'ingest' job to the back of the queue,
   * allowing interleaving search jobs to be processed first.
   *
   * @param texts  Array of input texts
   * @returns      Array of Float32Array embeddings, same order as input
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Fallback to hash-based pseudo-embeddings when real model unavailable
    if (!this._available) {
      return texts.map(generateEmbedding);
    }

    const total = texts.length;
    const results: Float32Array[] = new Array(total);

    // Split into chunks of 10 and process each through the queue sequentially
    for (let offset = 0; offset < total; offset += 10) {
      const chunk = texts.slice(offset, offset + 10);

      const chunkResults = await new Promise<Float32Array[]>((resolve, reject) => {
        const job: EmbedJob = {
          kind: 'ingest',
          texts: chunk,
          resolve,
          reject,
        };
        this.queue.push(job);
        this.pump();
      });

      // Place results in the correct position
      for (let i = 0; i < chunkResults.length; i++) {
        results[offset + i] = chunkResults[i];
      }

      // Yield to event loop every 100 items when batching large sets
      if (total > 200 && (offset + 10) % 100 === 0) {
        if (process.env.BRAIN_DEBUG === 'true') {
          log('debug', 'embedding-service', `Embedding progress: ${Math.min(offset + 10, total)}/${total} chunks`);
        }
        await Bun.sleep(0);
      }
    }

    return results;
  }

  /**
   * Get the embedding dimensions of the loaded model.
   * Returns 0 if no embed() call has been made yet (dimensions are discovered lazily).
   */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Release all underlying resources (llama model + context).
   * Rejects all pending queue jobs with an error.
   * This instance must not be used after disposal.
   */
  dispose(): void {
    // Reject all pending queue jobs
    const disposeErr = new Error('EmbeddingService disposed');
    for (const job of this.queue) {
      job.reject(disposeErr);
    }
    this.queue = [];
    this.processing = false;

    try {
      this.ctx?.dispose();
    } catch {
      // Ignore disposal errors
    }
    try {
      this.model?.dispose();
    } catch {
      // Ignore disposal errors
    }
    this.initialized = false;
    this._available = false;
    this.dimensions = 0;
    this.ctx = null;
    this.model = null;
    this.initPromise = null;
  }

  /**
   * Reset the singleton (useful for testing).
   */
  static resetInstance(): void {
    if (EmbeddingService.instance) {
      EmbeddingService.instance.dispose();
      EmbeddingService.instance = null as any;
    }
  }

  // -----------------------------------------------------------------------
  // Private — Priority Queue
  // -----------------------------------------------------------------------

  /**
   * Execute a single embedding call against the real model.
   *
   * Lazy-discovers the model's embedding dimension on the first call.
   * Falls back to generateEmbedding() on any error.
   *
   * @param text  Input text to embed
   * @returns     Float32Array embedding vector
   */
  private async embedDirect(text: string): Promise<Float32Array> {
    try {
      // Lazy dimension discovery on first real call
      if (this.dimensions === 0) {
        const probe = await this.ctx.getEmbeddingFor('test');
        this.dimensions = probe.vector.length;
        if (process.env.BRAIN_DEBUG === 'true') {
          log('debug', 'embedding-service', `Dimensions resolved: ${this.dimensions}d`);
        }
      }

      if (!text || text.length === 0) {
        return new Float32Array(this.dimensions);
      }

      const truncated =
        text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

      const result = await this.ctx.getEmbeddingFor(truncated);
      return new Float32Array(result.vector);
    } catch (err) {
      log("warn", "embedding-service", "Real embedding failed, falling back to hash-based", { error: String(err) });
      return generateEmbedding(text);
    }
  }

  /**
   * Process the job queue.
   *
   * Guarded by `this.processing` to prevent concurrent pump loops.
   * Prioritises 'search' jobs over 'ingest' jobs on every dequeue.
   * For ingest jobs with >10 texts, only the first 10 are processed and
   * the remainder is re-queued at the back.
   * On error, all remaining queue items are rejected and the queue is cleared.
   */
  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        // Prioritise search jobs: find the first 'search' job, or take the front
        const searchIdx = this.queue.findIndex((j) => j.kind === 'search');
        const job = searchIdx >= 0
          ? this.queue.splice(searchIdx, 1)[0]
          : this.queue.shift()!;

        // For ingest jobs with >10 texts, process only first 10 then re-queue remainder
        let textsToProcess = job.texts;
        if (job.kind === 'ingest' && job.texts.length > 10) {
          textsToProcess = job.texts.slice(0, 10);
          const remainder = job.texts.slice(10);
          this.queue.push({ ...job, texts: remainder });
        }

        // Process each text sequentially through embedDirect
        try {
          const results: Float32Array[] = [];
          for (const text of textsToProcess) {
            const vec = await this.embedDirect(text);
            results.push(vec);
          }
          job.resolve(results);
        } catch (err) {
          // On error: reject this job and all remaining queue items
          job.reject(err as Error);
          const errorMessage = err instanceof Error ? err.message : String(err);
          const disposeErr = new Error(`Embedding pipeline error: ${errorMessage}`);
          for (const remaining of this.queue) {
            remaining.reject(disposeErr);
          }
          this.queue = [];
          return;
        }
      }
    } finally {
      this.processing = false;

      // If new jobs arrived while we were finishing (race edge), restart the pump
      if (this.queue.length > 0) {
        this.pump();
      }
    }
  }
}
