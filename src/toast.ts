import type { PluginInput } from "@opencode-ai/plugin";

export type ToastVariant = "info" | "success" | "warning" | "error";

/**
 * Create a toast helper bound to a specific plugin.
 * Silently handles all errors — never breaks plugin operation on UI failure.
 */
export function createToast(
  client: PluginInput["client"],
  defaultTitle: string,
): (message: string, variant?: ToastVariant, title?: string) => void {
  return (message: string, variant: ToastVariant = "info", title?: string): void => {
    try {
      client.tui.showToast({
        body: { message, variant, ...(title ? { title } : { title: defaultTitle }) },
      }).catch(() => {});
    } catch {
      // Never let UI errors break plugin operation
    }
  };
}
