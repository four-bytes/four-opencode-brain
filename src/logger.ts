// Re-exported from @four-bytes/opencode-plugin-lib
// Kept for backward compatibility — all internal imports use "../logger" etc.
export { createLogger } from "@four-bytes/opencode-plugin-lib";
export type { LogLevel } from "@four-bytes/opencode-plugin-lib";
import { createLogger as libCreateLogger } from "@four-bytes/opencode-plugin-lib";

const brainLogger = libCreateLogger("brain");

export const log = brainLogger;
export const setSilent = brainLogger.setSilent;
