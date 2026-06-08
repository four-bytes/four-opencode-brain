import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";

export function getBrainStatusFile(directory: string): string {
  const hash = createHash("md5").update(directory).digest("hex").slice(0, 12);
  return join(homedir(), ".cache", "opencode", "brain", `status-${hash}.json`);
}
