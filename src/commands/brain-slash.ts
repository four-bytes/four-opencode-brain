import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COMMANDS_DIR = join(homedir(), ".config", "opencode", "commands");

const BRAIN_COMMANDS: Record<string, string> = {
  "brain-ingest.md": `Ingest files/directories into the brain index with content-hash dedup.

**Usage:** /brain-ingest <path> [--recursive] [--reindex]

Uses the brain_ingest tool to index: $ARGUMENTS
`,
  "brain-search.md": `Search the brain index across documents, memories, and knowledge.

**Usage:** /brain-search <query> [--content-type document|memory|knowledge|chunk|all]

Uses the brain_search tool to find: $ARGUMENTS
`,
  "brain-memory.md": `Manage brain memories — add, search, list, forget, get, or view diary.

**Modes:** add | search | list | forget | diary | get

Uses the brain_memory tool with mode $ARGUMENTS
`,
  "brain-stats.md": `Get brain database statistics: document, chunk, memory, and knowledge counts.

Uses a SQL query against the brain database to report: $ARGUMENTS
`,
};

export function installBrainCommands(): { installed: number; skipped: number; errors: string[] } {
  let installed = 0;
  let skipped = 0;
  const errors: string[] = [];

  try {
    if (!existsSync(COMMANDS_DIR)) {
      mkdirSync(COMMANDS_DIR, { recursive: true });
    }

    for (const [filename, content] of Object.entries(BRAIN_COMMANDS)) {
      const filePath = join(COMMANDS_DIR, filename);
      try {
        if (existsSync(filePath)) {
          skipped++;
          continue; // Don't overwrite existing user commands
        }
        writeFileSync(filePath, content, "utf-8");
        installed++;
      } catch (e: unknown) {
        errors.push(`${filename}: ${String(e)}`);
      }
    }
  } catch (e: unknown) {
    errors.push(`commands dir: ${String(e)}`);
  }

  return { installed, skipped, errors };
}
