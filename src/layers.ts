export interface LayerConfig {
  /** Layer-ID (repo_profile, task_slice, issue_slice) */
  id: string;
  /** Determines position in system prompt (lower = earlier = better cache) */
  order: number;
  /** Whether this layer is active */
  enabled: boolean;
  /** Optional TTL in ms (for dynamic layers) */
  ttlMs?: number;
}

export interface LayerContent {
  /** Text or structured content to inject into system prompt */
  content: string;
  /** When content was last updated (for TTL checks) */
  updatedAt: number;
  /** Optional source reference (for debugging) */
  source?: string;
}

export interface Layer {
  config: LayerConfig;
  /** Generates (or retrieves cached) layer content */
  generate(): Promise<LayerContent>;
}

export const DEFAULT_LAYERS: LayerConfig[] = [
  { id: "repo_profile", order: 2, enabled: true },
  { id: "task_slice", order: 3, enabled: true, ttlMs: 30 * 60 * 1000 },
];
