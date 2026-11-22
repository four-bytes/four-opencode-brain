import type { Layer, LayerConfig, LayerContent } from "./layers.js";

export interface HookContext {
  layers: Layer[];
  configs: LayerConfig[];
  cache: Map<string, LayerContent>;
}

export interface LayerPipelineResult {
  content: string;
  source?: string;
  id: string;
}

export function createHookContext(configs: LayerConfig[], layers: Layer[]): HookContext {
  return {
    layers,
    configs,
    cache: new Map(),
  };
}

export async function runLayerPipelineWithSources(ctx: HookContext): Promise<LayerPipelineResult[]> {
  const results: LayerPipelineResult[] = [];

  const enabled = ctx.configs
    .filter(c => c.enabled)
    .sort((a, b) => a.order - b.order);

  for (const config of enabled) {
    const layer = ctx.layers.find(l => l.config.id === config.id);
    if (!layer) continue;

    // Check TTL cache
    if (config.ttlMs) {
      const cached = ctx.cache.get(config.id);
      if (cached && (Date.now() - cached.updatedAt) < config.ttlMs) {
        results.push({ content: cached.content, source: cached.source, id: config.id });
        continue;
      }
    }

    try {
      const content = await layer.generate();
      ctx.cache.set(config.id, content);
      if (content.content.trim()) {
        results.push({ content: content.content, source: content.source, id: config.id });
      }
    } catch (err) {
      // Layer failure = non-fatal. Logging via console, never block.
      // eslint-disable-next-line no-console
      console.warn(`[four-brain] layer '${config.id}' failed:`, err);
    }
  }

  return results;
}

export async function runLayerPipeline(ctx: HookContext): Promise<string[]> {
  return (await runLayerPipelineWithSources(ctx)).map(r => r.content);
}
