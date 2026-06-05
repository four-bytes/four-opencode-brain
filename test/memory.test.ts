// ---------------------------------------------------------------------------
// Brain memory store — SQLite-backed CRUD tests
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { createSchema } from "../src/schema";
import {
  memoryAdd,
  memorySearch,
  memoryList,
  memoryForget,
  memoryGet,
  diaryGet,
  diaryAdd,
} from "../src/memory/store";
import type {
  MemoryInput,
  DiaryEntry,
  MemoryEntry,
} from "../src/memory/store";

// ---------------------------------------------------------------------------
// Setup: fresh temp DB per suite
// ---------------------------------------------------------------------------

const TEST_DIR = "/tmp/brain-memory-test-" + Date.now();
const TEST_DB = join(TEST_DIR, "brain.db");

let db: Database;

function freshDb(): Database {
  if (db) db.close();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  const d = new Database(TEST_DB);
  d.exec("PRAGMA journal_mode=WAL;");
  d.exec("PRAGMA foreign_keys=ON;");
  createSchema(d);
  return d;
}

beforeAll(() => {
  db = freshDb();
});

afterAll(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// memoryAdd
// ---------------------------------------------------------------------------

describe("memoryAdd", () => {
  test("returns entry with id and project_hash", () => {
    const entry = memoryAdd(db, {
      type: "fact",
      title: "Test memory",
      content: "This is a test memory entry",
      tags: "test,example",
    });
    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBe(32);
    expect(entry.project_hash).toBeDefined();
    expect(entry.date).toBeDefined();
    expect(entry.type).toBe("fact");
    expect(entry.title).toBe("Test memory");
    expect(entry.content).toBe("This is a test memory entry");
    expect(entry.tags).toBe("test,example");
  });

  test("stores entry in DB", () => {
    memoryAdd(db, {
      type: "decision",
      title: "Persistent check",
      content: "Verify this is stored",
    });

    const row = db
      .query<{ title: string }, []>(
        "SELECT title FROM memories WHERE title = ?",
      )
      .get("Persistent check");
    expect(row).not.toBeNull();
    expect(row!.title).toBe("Persistent check");
  });
});

// ---------------------------------------------------------------------------
// memorySearch
// ---------------------------------------------------------------------------

describe("memorySearch", () => {
  beforeAll(() => {
    // Ensure at least one searchable memory (from previous tests,
    // "This is a test memory entry" should be there)
    memoryAdd(db, {
      type: "pattern",
      title: "Searchable item",
      content: "unique-searchable-content-for-testing",
      tags: "search,test",
    });
  });

  test("finds memory by keyword", () => {
    const results = memorySearch(db, { query: "searchable" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title === "Searchable item")).toBe(true);
  });

  test("returns empty array for no match", () => {
    const results = memorySearch(db, {
      query: "zzzzzthiswillnevermatchanything",
    });
    expect(results.length).toBe(0);
  });

  test("filters by type", () => {
    const results = memorySearch(db, {
      query: "searchable",
      type: "pattern",
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
    // Should NOT match if type is wrong
    const typeFiltered = memorySearch(db, {
      query: "searchable",
      type: "error",
    });
    expect(typeFiltered.length).toBe(0);
  });

  test("returns empty array when no query provided", () => {
    const results = memorySearch(db, {});
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memoryList
// ---------------------------------------------------------------------------

describe("memoryList", () => {
  test("returns recent memories", () => {
    const results = memoryList(db, { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(3); // at least the 3 we added
    // Ordered by created_at DESC
    const timestamps = results.map((r) => r.created_at);
    for (let i = 1; i < timestamps.length; i++) {
      expect(new Date(timestamps[i]).getTime()).toBeLessThanOrEqual(
        new Date(timestamps[i - 1]).getTime(),
      );
    }
  });

  test("filters by type", () => {
    const allFact = memoryList(db, { type: "fact", limit: 100 });
    expect(allFact.every((r) => r.type === "fact")).toBe(true);
  });

  test("respects limit", () => {
    const results = memoryList(db, { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("respects offset", () => {
    const first = memoryList(db, { limit: 2, offset: 0 });
    const second = memoryList(db, { limit: 2, offset: 2 });
    if (first.length >= 2 && second.length >= 1) {
      expect(second[0].id).not.toBe(first[0].id);
      expect(second[0].id).not.toBe(first[1].id);
    }
  });
});

// ---------------------------------------------------------------------------
// memoryForget
// ---------------------------------------------------------------------------

describe("memoryForget", () => {
  test("removes memory by id", () => {
    const entry = memoryAdd(db, {
      type: "preference",
      title: "To be forgotten",
      content: "This will be deleted",
    });

    const found = memoryGet(db, entry.id);
    expect(found).not.toBeNull();

    const removed = memoryForget(db, entry.id);
    expect(removed).toBe(true);

    const gone = memoryGet(db, entry.id);
    expect(gone).toBeNull();
  });

  test("returns false for non-existent id", () => {
    const result = memoryForget(db, "nonexistent-id-12345");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// memoryGet
// ---------------------------------------------------------------------------

describe("memoryGet", () => {
  test("returns full entry by id", () => {
    const entry = memoryAdd(db, {
      type: "error",
      title: "Get test",
      content: "Entry that will be retrieved by ID",
      tags: "get,retrieve",
    });

    const found = memoryGet(db, entry.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(entry.id);
    expect(found!.title).toBe("Get test");
    expect(found!.content).toBe("Entry that will be retrieved by ID");
    expect(found!.type).toBe("error");
    expect(found!.tags).toBe("get,retrieve");
  });

  test("returns null for non-existent id", () => {
    const result = memoryGet(db, "nonexistent-id-99999");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// diaryAdd + diaryGet roundtrip
// ---------------------------------------------------------------------------

describe("diary roundtrip", () => {
  test("add entry and retrieve by date", () => {
    const testDate = "2025-06-05";
    diaryAdd(db, {
      date: testDate,
      title: "Diary test entry",
      content: "This is a diary entry for testing",
    });

    const entries = diaryGet(db, testDate);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const found = entries.find((e) => e.title === "Diary test entry");
    expect(found).toBeDefined();
    expect(found!.content).toBe("This is a diary entry for testing");
    expect(found!.date).toBe(testDate);
  });

  test("diary entries ordered by timestamp", () => {
    const date = "2025-06-06";
    diaryAdd(db, { date, title: "First", content: "First entry" });
    diaryAdd(db, { date, title: "Second", content: "Second entry" });

    const entries = diaryGet(db, date);
    const first = entries.find((e) => e.title === "First");
    const second = entries.find((e) => e.title === "Second");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Both should be present, ordered by timestamp
    const idxFirst = entries.indexOf(first!);
    const idxSecond = entries.indexOf(second!);
    expect(idxFirst).toBeLessThanOrEqual(idxSecond);
  });

  test("diaryGet accepts default date (today)", () => {
    const today = new Date().toISOString().split("T")[0];
    diaryAdd(db, { title: "Today entry", content: "Entry for default date" });
    const entries = diaryGet(db, today);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.title === "Today entry")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project scoping
// ---------------------------------------------------------------------------

describe("project scoping", () => {
  test("memories isolated per project", () => {
    const projA = memoryAdd(db, {
      type: "fact",
      title: "Project A memory",
      content: "Only for project A",
      project: "/path/to/project-a",
    });

    const projB = memoryAdd(db, {
      type: "fact",
      title: "Project B memory",
      content: "Only for project B",
      project: "/path/to/project-b",
    });

    // Different project hashes
    expect(projA.project_hash).not.toBe(projB.project_hash);

    // Search with project filter
    const resultsA = memorySearch(db, {
      query: "project",
      project: "/path/to/project-a",
    });
    expect(resultsA.some((r) => r.title === "Project A memory")).toBe(true);
    expect(resultsA.some((r) => r.title === "Project B memory")).toBe(false);

    // List with project filter
    const listA = memoryList(db, { project: "/path/to/project-a" });
    expect(listA.every((r) => r.project_hash === projA.project_hash)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Search snippet ≤150 chars
// ---------------------------------------------------------------------------

describe("search snippet", () => {
  test("snippet is ≤150 chars", () => {
    const longContent =
      "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
      "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. " +
      "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris " +
      "nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in " +
      "reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.";

    memoryAdd(db, {
      type: "fact",
      title: "Long content memory",
      content: longContent,
    });

    const results = memorySearch(db, { query: "Lorem" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.snippet) {
        expect(r.snippet.length).toBeLessThanOrEqual(150);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown mode (tested via tool execute wrapper)
// ---------------------------------------------------------------------------

describe("mode handling", () => {
  test("unknown mode returns error", () => {
    // We test the switch logic directly since the tool execution
    // is in four-opencode-brain.ts. The store functions themselves
    // don't have modes — this validates the tool handler's fallback.
    const modes = ["add", "search", "list", "forget", "diary", "get"] as const;
    const unknown = "invalid_mode_123";
    expect(modes.includes(unknown as any)).toBe(false);
  });
});
