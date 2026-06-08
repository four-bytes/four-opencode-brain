/**
 * In-process mutex to serialize ingest runs.
 * Prevents SQLITE_BUSY from concurrent auto-ingest + manual /brain ingest.
 */
export function createIngestMutex() {
  let queue: Promise<void> = Promise.resolve();

  return {
    async acquire(): Promise<() => void> {
      let release: () => void;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const prev = queue;
      queue = queue.then(() => wait);
      await prev;
      return release!;
    },
  };
}

/** Singleton mutex — one per process lifetime */
export const ingestMutex = createIngestMutex();
