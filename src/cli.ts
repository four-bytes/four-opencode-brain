#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Brain CLI — standalone CLI for four-opencode-brain functions
//
// Usage:
//   bun run src/cli.ts ingest <path> [--recursive] [--reindex]
//   bun run src/cli.ts search <query> [--content-type <type>] [--limit <n>]
//   bun run src/cli.ts memory list|add <title> <content> [--type <type>]
//   bun run src/cli.ts stats
//   bun run src/cli.ts kb     get|add|search <args>
// ---------------------------------------------------------------------------

import { initBrainDatabase, dbStats, hashContent } from "./schema";
import { ingestPath } from "./ingest";
import { brainSearch } from "./search/unified";
import {
  memoryAdd,
  memoryList,
  memorySearch,
  memoryForget,
  memoryGet,
  diaryGet,
  diaryAdd,
} from "./memory/store";
import {
  kbGet,
  kbAdd,
  kbRecord,
  kbReview,
  kbSearch,
  deriveEntryKey,
} from "./knowledge/store";
import type { KbAddInput, KbRecordInput, KbReviewInput } from "./knowledge/store";
import { log } from "./logger";
import { getConfig } from "./config";

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const command = args[0];

  switch (command) {
    case "ingest":
      await cmdIngest(args.slice(1));
      break;
    case "search":
      await cmdSearch(args.slice(1));
      break;
    case "memory":
      await cmdMemory(args.slice(1));
      break;
    case "stats":
      await cmdStats();
      break;
    case "kb":
      await cmdKb(args.slice(1));
      break;
    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`
Usage: bun run src/cli.ts <command> [options]

Commands:
  ingest <path>              Ingest files/directories into brain index
    --recursive               Recurse into subdirectories (default: true)
    --reindex                 Force re-index even if unchanged

  search <query>             Search across documents, memories, knowledge
    --content-type <type>     document|memory|knowledge|chunk|all (default: all)
    --limit <n>               Max results (default: 20)

  memory list                List recent memories
    --type <type>             Filter by type (decision|pattern|fact|preference|error)
    --limit <n>               Max results (default: 20)
    --offset <n>              Result offset

  memory add <title> <content>  Add a memory
    --type <type>             Type (default: fact)
    --tags <tags>             Comma-separated tags

  memory search <query>      Search memories
    --type <type>             Filter by type

  memory get <id>            Get memory by ID
  memory forget <id>         Delete memory by ID

  stats                      Show database statistics

  kb get <key> [--kind <k>]  Get knowledge entry
  kb add <key> <title>       Add/update knowledge entry
    --kind <k>               Entry kind (default: problem)
    --description <text>     Description
    --entity-type <type>     Entity type
    --root-cause <text>      Root cause
    --solution <text>        Canonical solution
    --tags <tags>            Comma-separated tags
    --confidence <n>         Confidence (0.0-1.0)

  kb search <query>          Search knowledge entries
    --entity-type <type>     Filter by entity type
    --kind <k>               Filter by kind
    --confidence-min <n>     Minimum confidence
    --review-state <s>       Filter by review state
    --limit <n>              Max results (default: 20)

  help                       Show this help
`);
}

// ---------------------------------------------------------------------------
// Ingest command
// ---------------------------------------------------------------------------

async function cmdIngest(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: bun run src/cli.ts ingest <path> [--recursive] [--reindex]");
    process.exit(1);
  }

  const targetPath = args[0];
  const recursive = !args.includes("--no-recursive") && !args.includes("--recursive=false");
  const reIndex = args.includes("--reindex");

  const db = initBrainDatabase();
  try {
    const result = await ingestPath(db, targetPath, { recursive, reIndex });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Search command
// ---------------------------------------------------------------------------

async function cmdSearch(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: bun run src/cli.ts search <query> [--content-type <type>] [--limit <n>]");
    process.exit(1);
  }

  const query = args[0];
  const contentType = extractArg(args, "--content-type") ?? "all";
  const limit = parseInt(extractArg(args, "--limit") ?? "20", 10);

  const db = initBrainDatabase();
  try {
    const results = await brainSearch(db, query, {
      contentType: contentType as any,
      limit,
    });
    console.log(JSON.stringify({ results, count: results.length }, null, 2));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Memory command
// ---------------------------------------------------------------------------

async function cmdMemory(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: bun run src/cli.ts memory <list|add|search|get|forget> [...]");
    process.exit(1);
  }

  const subCmd = args[0];
  const rest = args.slice(1);
  const db = initBrainDatabase();
  try {
    switch (subCmd) {
      case "list": {
        const type = extractArg(rest, "--type");
        const limit = parseInt(extractArg(rest, "--limit") ?? "20", 10);
        const offset = parseInt(extractArg(rest, "--offset") ?? "0", 10);
        const entries = memoryList(db, { type, limit, offset });
        console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
        break;
      }
      case "add": {
        const title = rest[0];
        const content = rest[1];
        if (!title || !content) {
          console.error("Usage: bun run src/cli.ts memory add <title> <content> [--type <type>] [--tags <tags>]");
          process.exit(1);
        }
        const type = (extractArg(rest, "--type") ?? "fact") as any;
        const tags = extractArg(rest, "--tags");
        const result = memoryAdd(db, { type, title, content, tags });
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "search": {
        const query = rest[0];
        if (!query) {
          console.error("Usage: bun run src/cli.ts memory search <query> [--type <type>]");
          process.exit(1);
        }
        const type = extractArg(rest, "--type");
        const entries = memorySearch(db, { query, type });
        console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
        break;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          console.error("Usage: bun run src/cli.ts memory get <id>");
          process.exit(1);
        }
        const entry = memoryGet(db, id);
        console.log(JSON.stringify(entry ?? { error: "not found" }, null, 2));
        break;
      }
      case "forget": {
        const id = rest[0];
        if (!id) {
          console.error("Usage: bun run src/cli.ts memory forget <id>");
          process.exit(1);
        }
        const ok = memoryForget(db, id);
        console.log(JSON.stringify({ ok }, null, 2));
        break;
      }
      case "diary":
        await cmdDiary(rest, db);
        break;
      default:
        console.error(`Unknown memory subcommand: ${subCmd}`);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

async function cmdDiary(args: string[], db: any): Promise<void> {
  const subMode = args[0];
  const rest = args.slice(1);

  if (subMode === "add") {
    const title = rest[0];
    const content = rest[1];
    if (!title || !content) {
      console.error("Usage: bun run src/cli.ts memory diary add <title> <content> [--date YYYY-MM-DD]");
      process.exit(1);
    }
    const date = extractArg(rest, "--date");
    diaryAdd(db, { title, content, date });
    const entries = diaryGet(db, date ?? new Date().toISOString().split("T")[0]);
    console.log(JSON.stringify({ entries }, null, 2));
  } else {
    const date = args[0] ?? new Date().toISOString().split("T")[0];
    const entries = diaryGet(db, date);
    console.log(JSON.stringify({ entries, count: entries.length }, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Stats command
// ---------------------------------------------------------------------------

async function cmdStats(): Promise<void> {
  const db = initBrainDatabase();
  try {
    const stats = dbStats(db);

    // Knowledge-specific stats
    const totalKb = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM knowledge_entries")
      .get()!;
    const avgConfidence = db
      .query<{ c: number | null }, []>("SELECT AVG(confidence) AS c FROM knowledge_entries")
      .get()!;
    const byReviewState = db
      .query<{ review_state: string; c: number }, []>(
        "SELECT review_state, COUNT(*) AS c FROM knowledge_entries GROUP BY review_state ORDER BY c DESC",
      )
      .all();

    const result = {
      ...stats,
      kbStats: {
        totalEntries: totalKb.c,
        avgConfidence: avgConfidence.c ?? 0,
        byReviewState,
      },
      config: getConfig(),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Knowledge base command
// ---------------------------------------------------------------------------

async function cmdKb(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.error("Usage: bun run src/cli.ts kb <get|add|record|review|search> [...]");
    process.exit(1);
  }

  const subCmd = args[0];
  const rest = args.slice(1);
  const db = initBrainDatabase();
  try {
    switch (subCmd) {
      case "get": {
        const entryKey = rest[0];
        if (!entryKey) {
          console.error("Usage: bun run src/cli.ts kb get <key> [--kind <k>]");
          process.exit(1);
        }
        const kind = extractArg(rest, "--kind");
        const entry = kbGet(db, entryKey, kind);
        console.log(JSON.stringify(entry ?? { error: "not found" }, null, 2));
        break;
      }
      case "add": {
        const entryKey = rest[0];
        const title = rest[1] ?? rest[0];
        if (!entryKey) {
          console.error("Usage: bun run src/cli.ts kb add <key> [title] [options]");
          process.exit(1);
        }
        const result = kbAdd(db, {
          entry_key: entryKey,
          kind: extractArg(rest, "--kind") ?? "problem",
          title,
          description: extractArg(rest, "--description"),
          entity_type: extractArg(rest, "--entity-type"),
          root_cause: extractArg(rest, "--root-cause"),
          canonical_solution: extractArg(rest, "--solution"),
          tags: extractArg(rest, "--tags"),
          confidence: parseFloat(extractArg(rest, "--confidence") ?? "NaN") || undefined,
        } satisfies KbAddInput);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "record": {
        const entryKey = rest[0];
        const outcome = extractArg(rest, "--outcome") as string;
        if (!entryKey || !outcome) {
          console.error("Usage: bun run src/cli.ts kb record <key> --outcome fixed|failed|workaround|observed");
          process.exit(1);
        }
        const kind = extractArg(rest, "--kind") ?? "problem";
        const occurrence = kbRecord(db, {
          entry_key: entryKey,
          kind,
          outcome: outcome as any,
          project_ref: extractArg(rest, "--project-ref"),
          repo_ref: extractArg(rest, "--repo-ref"),
          issue_ref: extractArg(rest, "--issue-ref"),
          commit_ref: extractArg(rest, "--commit-ref"),
          observed_symptoms: extractArg(rest, "--symptoms"),
        } satisfies KbRecordInput);
        console.log(JSON.stringify(occurrence, null, 2));
        break;
      }
      case "review": {
        const entryKey = rest[0];
        const reviewState = extractArg(rest, "--state") as string;
        if (!entryKey || !reviewState) {
          console.error("Usage: bun run src/cli.ts kb review <key> --state draft|reviewed|accepted|rejected|superseded [--confidence <n>]");
          process.exit(1);
        }
        const kind = extractArg(rest, "--kind") ?? "problem";
        const confidence = parseFloat(extractArg(rest, "--confidence") ?? "NaN") || undefined;
        const entry = kbReview(db, {
          entry_key: entryKey,
          kind,
          review_state: reviewState as any,
          confidence,
        } satisfies KbReviewInput);
        console.log(JSON.stringify(entry, null, 2));
        break;
      }
      case "search": {
        const query = rest[0];
        if (!query) {
          console.error("Usage: bun run src/cli.ts kb search <query> [options]");
          process.exit(1);
        }
        const results = kbSearch(db, {
          query,
          entity_type: extractArg(rest, "--entity-type"),
          kind: extractArg(rest, "--kind"),
          confidence_min: parseFloat(extractArg(rest, "--confidence-min") ?? "NaN") || undefined,
          review_state: extractArg(rest, "--review-state"),
          limit: parseInt(extractArg(rest, "--limit") ?? "20", 10),
        });
        console.log(JSON.stringify({ results, count: results.length }, null, 2));
        break;
      }
      default:
        console.error(`Unknown kb subcommand: ${subCmd}`);
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the value of a `--key <value>` option from args array.
 * Returns undefined if not found.
 */
function extractArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`CLI error: ${String(err)}`);
  process.exit(1);
});
