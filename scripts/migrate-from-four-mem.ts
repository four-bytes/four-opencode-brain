#!/usr/bin/env bun

/**
 * One-time migration script — imports data from ~/.four-mem/ into the brain SQLite DB.
 *
 * Reads:
 *   ~/.four-mem/MEMORY.md  →  memories table
 *   ~/.four-mem/diary/*.md  →  diary_entries table
 *
 * Usage: bun run scripts/migrate-from-four-mem.ts
 *
 * Note: Personal script, not part of plugin runtime.
 */

import { join, resolve } from "path";
import { homedir } from "os";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { initBrainDatabase } from "../src/schema";
import { memoryAdd } from "../src/memory/store";
import { diaryAdd } from "../src/memory/store";

const FOUR_MEM = join(homedir(), ".four-mem");
const MEMORY_FILE = join(FOUR_MEM, "MEMORY.md");
const DIARY_DIR = join(FOUR_MEM, "diary");

console.log("🧠 four-opencode-brain — Migration from ~/.four-mem/");

if (!existsSync(FOUR_MEM)) {
  console.log("  No ~/.four-mem/ directory found — nothing to migrate.");
  process.exit(0);
}

const db = initBrainDatabase();
let memoryCount = 0;
let diaryCount = 0;

// ---- Migrate MEMORY.md entries ----
if (existsSync(MEMORY_FILE)) {
  const content = readFileSync(MEMORY_FILE, "utf-8");
  const entries = content.split(/^## /gm).slice(1); // split by ## headers

  for (const entry of entries) {
    const lines = entry.trim().split("\n");
    const title = lines[0]?.trim() ?? "Untitled";
    const body = lines.slice(1).join("\n").trim();

    if (!body) continue;

    try {
      memoryAdd(db, {
        type: "fact",
        title,
        content: body,
        project: "four-mem-migration",
      });
      memoryCount++;
    } catch (e: any) {
      console.log(`  ⚠ Skipped duplicate: ${title}`);
    }
  }
  console.log(`  ✅ Migrated ${memoryCount} memory entries`);
} else {
  console.log("  No MEMORY.md found");
}

// ---- Migrate diary entries ----
if (existsSync(DIARY_DIR)) {
  const files = readdirSync(DIARY_DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = join(DIARY_DIR, file);
    const date = file.replace(".md", ""); // e.g. "2026-06-05"
    const content = readFileSync(filePath, "utf-8").trim();
    const firstLine = content.split("\n")[0]?.trim() ?? date;
    const title = firstLine.replace(/^#+\s*/, "");

    if (!content) continue;

    diaryAdd(db, { date, title, content });
    diaryCount++;
  }
  console.log(`  ✅ Migrated ${diaryCount} diary entries`);
} else {
  console.log("  No diary/ directory found");
}

db.close();
console.log(`\n✨ Done. ${memoryCount} memories + ${diaryCount} diary entries migrated.`);
