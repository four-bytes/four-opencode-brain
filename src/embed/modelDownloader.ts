/**
 * ModelDownloader — downloads GGUF embedding models from HuggingFace
 *
 * Caches downloaded models in `~/.cache/four-opencode-brain/models/` and provides
 * integrity verification via file size.
 *
 * Default model: all-MiniLM-L6-v2.Q8_0 (384-dim, ~25 MB, good balance of speed/quality).
 *
 * @module
 */

import path from 'node:path';
import fs from 'node:fs';
import { log } from '../logger';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ModelInfo {
  /** Short display name (e.g. 'all-MiniLM-L6-v2.Q8_0') */
  name: string;
  /** HuggingFace repository in 'owner/repo' format */
  hfRepo: string;
  /** GGUF filename in the repo (e.g. 'all-MiniLM-L6-v2.Q8_0.gguf') */
  filename: string;
  /** Embedding dimensions produced by this model */
  dimensions: number;
  /** Approximate file size in megabytes (for progress display and validation) */
  approxSizeMb: number;
}

// ---------------------------------------------------------------------------
// KNOWN_MODELS
// ---------------------------------------------------------------------------

export const KNOWN_MODELS: Record<string, ModelInfo> = {
  'all-MiniLM-L6-v2.Q8_0': {
    name: 'all-MiniLM-L6-v2.Q8_0',
    hfRepo: 'leliuga/all-MiniLM-L6-v2-GGUF',
    filename: 'all-MiniLM-L6-v2.Q8_0.gguf',
    dimensions: 384,
    approxSizeMb: 25,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function isCacheValid(filePath: string, modelInfo: ModelInfo): boolean {
  if (!fs.existsSync(filePath)) return false;

  const stat = fs.statSync(filePath);
  const expectedBytes = modelInfo.approxSizeMb * 1024 * 1024;
  const minSize = Math.round(expectedBytes * 0.8);
  const maxSize = Math.round(expectedBytes * 1.2);

  if (stat.size >= minSize && stat.size <= maxSize) return true;

  log('warn', 'model-downloader',
    `Model file size mismatch for ${modelInfo.filename}: expected ~${modelInfo.approxSizeMb} MB, got ${formatBytes(stat.size)}. Re-downloading...`,
  );
  return false;
}

// ---------------------------------------------------------------------------
// ensureModel
// ---------------------------------------------------------------------------

/**
 * Ensure a GGUF embedding model is available locally.
 *
 * 1. Looks up `modelName` in KNOWN_MODELS
 * 2. Returns cached path if valid (size check)
 * 3. Downloads from HuggingFace with progress logging
 * 4. Verifies integrity after download
 *
 * @param modelName Key in KNOWN_MODELS (e.g. 'all-MiniLM-L6-v2.Q8_0')
 * @param cacheDir  Cache directory for models (e.g. '~/.cache/four-opencode-brain/models')
 * @returns         Absolute path to the .gguf file
 * @throws          If model is unknown, download fails, or integrity check fails
 */
export async function ensureModel(
  modelName: string,
  cacheDir: string,
): Promise<string> {
  // 1. Lookup
  const modelInfo = KNOWN_MODELS[modelName];
  if (!modelInfo) {
    const available = Object.keys(KNOWN_MODELS).join(', ');
    throw new Error(
      `Unknown model: "${modelName}". Available models: ${available}`,
    );
  }

  const targetPath = path.join(cacheDir, modelInfo.filename);

  // 2. Check cache
  if (isCacheValid(targetPath, modelInfo)) {
    return targetPath;
  }

  // 3. Ensure cache directory
  fs.mkdirSync(cacheDir, { recursive: true });

  // 4. Download
  const url = `https://huggingface.co/${modelInfo.hfRepo}/resolve/main/${modelInfo.filename}`;
  log('info', 'model-downloader',
    `Downloading model "${modelInfo.name}" (~${modelInfo.approxSizeMb} MB) from HuggingFace...`,
  );

  const response = await fetch(url);

  if (!response.ok) {
    const curlCmd = `curl -L -o "${modelInfo.filename}" "${url}"`;
    throw new Error(
      `Failed to download model "${modelInfo.name}" from HuggingFace.\n` +
      `URL: ${url}\n` +
      `HTTP ${response.status}: ${response.statusText}\n\n` +
      `You can download it manually:\n` +
      `  ${curlCmd}\n\n` +
      `Then place the file at:\n` +
      `  ${targetPath}`,
    );
  }

  const contentLength = parseInt(
    response.headers.get('content-length') || '0',
    10,
  );
  const reader = response.body!.getReader();
  const writer = fs.createWriteStream(targetPath);

  let downloaded = 0;
  let lastReportedMb = 0;
  const reportIntervalBytes = 5 * 1024 * 1024; // 5 MB

  try {
    await new Promise<void>((resolve, reject) => {
      writer.on('error', reject);
      writer.on('finish', resolve);

      const pump = async (): Promise<void> => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              writer.end();
              return;
            }
            writer.write(Buffer.from(value));
            downloaded += value.length;

            // Progress logging every ~5 MB
            const downloadedMb = Math.floor(downloaded / reportIntervalBytes);
            if (downloadedMb > lastReportedMb) {
              lastReportedMb = downloadedMb;
              const percent = contentLength > 0
                ? Math.round((downloaded / contentLength) * 100)
                : 0;
              if (process.env.BRAIN_DEBUG === 'true') {
                log('debug', 'model-downloader',
                  `${formatBytes(downloaded)} / ${formatBytes(contentLength)} (${percent}%)`,
                );
              }
            }
          }
        } catch (err) {
          reject(err);
        }
      };

      pump();
    });
  } catch (err) {
    // Clean up partial download
    try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    throw new Error(
      `Download interrupted for "${modelInfo.name}": ${(err as Error).message}`,
    );
  }

  // 5. Post-download verification
  const finalStat = fs.statSync(targetPath);
  const expectedBytes = modelInfo.approxSizeMb * 1024 * 1024;
  const minSize = Math.round(expectedBytes * 0.8);
  const maxSize = Math.round(expectedBytes * 1.2);

  if (finalStat.size < minSize || finalStat.size > maxSize) {
    try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    throw new Error(
      `Downloaded model "${modelInfo.name}" size (${formatBytes(finalStat.size)}) ` +
      `is outside expected range (~${modelInfo.approxSizeMb} MB). ` +
      `The file may be corrupted. Try downloading manually:\n` +
      `  curl -L -o "${modelInfo.filename}" "${url}"`,
    );
  }

  log('info', 'model-downloader',
    `Model "${modelInfo.name}" ready at ${targetPath} (${formatBytes(finalStat.size)})`,
  );

  return targetPath;
}
