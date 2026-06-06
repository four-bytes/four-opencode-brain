import { join } from "path";
import { homedir } from "os";

/** Shared status file — server writes, TUI reads via Bun.file().json() */
export const BRAIN_STATUS_FILE = join(homedir(), ".cache", "opencode", "brain-status.json");
