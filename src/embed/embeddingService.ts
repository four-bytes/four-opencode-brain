/**
 * EmbeddingService — generates text embeddings via node-llama-cpp.
 *
 * Singleton pattern (like SymbolExtractor). Downloads the GGUF model on first use,
 * then loads it via node-llama-cpp. Returns 384-dim Float32Array per embedding.
 *
 * Falls back to hash-based pseudo-embeddings when model is unavailable.
 *
 * @module
 */

import { existsSync } from 'node:fs';
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
// EmbeddingService
// ---------------------------------------------------------------------------

export class EmbeddingService {
  private static instance: EmbeddingService;

  private ctx: any = null;
  private model: any = null;
  private dimensions = 0;
  private initialized = false;
  private _available = false; // true when real model loaded successfully

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
   * @param modelPath Optional path to a pre-downloaded GGUF model file.
   *                  If omitted, downloads all-MiniLM-L6-v2.Q8_0 automatically.
   * @param cacheDir  Optional cache directory (default: ~/.cache/four-opencode-brain/models/)
   */
  async initialize(modelPath?: string, cacheDir?: string): Promise<void> {
    if (this.initialized) return;

    // Skip real embeddings only if explicitly disabled
    if (process.env.BRAIN_EMBED_DISABLE === "true" || process.env.BRAIN_EMBED_DISABLE === "1") {
      this.initialized = true;
      this._available = false;
      return;
    }

    try {
      const resolvedModelPath = modelPath ?? await ensureModel(
        DEFAULT_MODEL,
        cacheDir ?? DEFAULT_CACHE_DIR,
      );

      if (!existsSync(resolvedModelPath)) {
        throw new Error(`Model file not found: ${resolvedModelPath}`);
      }

      // Dynamic import to avoid top-level dependency on node-llama-cpp
      const { getLlama, LlamaLogLevel } = await import('node-llama-cpp');

      const llama = await getLlama({ gpu: false, build: "never" as any, logLevel: LlamaLogLevel.error });
      this.model = await llama.loadModel({ modelPath: resolvedModelPath });
      this.ctx = await this.model.createEmbeddingContext();

      // Lazy dimension discovery on first embed() call
      this._available = true;
      this.initialized = true;

      if (process.env.BRAIN_DEBUG === 'true') {
        log('debug', 'embedding-service',
          `Initialized via node-llama-cpp (model: ${resolvedModelPath})`,
        );
      }
    } catch (err) {
      log('info', 'embedding-service',
        'Real embedding model not available (prebuilt binary missing or incompatible), using hash-based pseudo-embeddings. Set BRAIN_EMBED_DISABLE=true to skip this attempt.',
      );
      this.initialized = true; // Mark initialized so consumers don't block
      this._available = false;
    }
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
  }

  /**
   * Generate embeddings for multiple texts in batch.
   *
   * @param texts  Array of input texts
   * @returns      Array of Float32Array embeddings, same order as input
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const total = texts.length;
    const results: Float32Array[] = new Array(total);

    for (let i = 0; i < total; i++) {
      results[i] = await this.embed(texts[i]);

      // Yield to event loop every 100 items when batching large sets
      if (total > 200 && (i + 1) % 100 === 0) {
        if (process.env.BRAIN_DEBUG === 'true') {
          log('debug', 'embedding-service', `Embedding progress: ${i + 1}/${total} chunks`);
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
   * This instance must not be used after disposal.
   */
  dispose(): void {
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
}
