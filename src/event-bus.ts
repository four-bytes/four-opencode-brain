type Listener<T> = (payload: T) => void;

class BrainEventBus {
  private listeners = new Map<string, Set<Listener<any>>>();
  private latest = new Map<string, any>();

  on<T>(event: string, listener: Listener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    if (this.latest.has(event)) listener(this.latest.get(event));
    return () => this.listeners.get(event)?.delete(listener);
  }

  emit<T>(event: string, payload: T): void {
    this.latest.set(event, payload);
    this.listeners.get(event)?.forEach(fn => fn(payload));
  }

  clear(): void {
    this.listeners.clear();
    this.latest.clear();
  }
}

export const brainBus = new BrainEventBus();

export interface BrainStatusEvent {
  phase?: "init" | "ingest" | "idle" | "busy";
  statusText?: string;
  progress?: number;
  current?: number;
  total?: number;
  scanning?: boolean;
  searching?: boolean;
  ingesting?: boolean;
  blocked?: boolean;
  busy?: boolean;
  version?: string;
  error?: string;
}
