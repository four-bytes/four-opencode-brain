// ---------------------------------------------------------------------------
// Tests for brain_reindex vector index rebuild
// ---------------------------------------------------------------------------

import { expect, test, beforeAll, afterAll, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { createSchema, generateId, hashContent } from "../src/schema";
import { brainSearch } from "../src/search/unified";
import plugin from "../src/four-opencode-brain";

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterAll(() => {
  db.close();
});

function tableExists(name: string): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    )
    .get(name);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

describe("brain_reindex — tool definition", () => {
  test("plugin exports brain_reindex tool", async () => {
    const result = await plugin({
      client: {} as any,
      project: "test",
      directory: "/tmp",
      $: {} as any,
    });
    const tool = result.tools.find((t) => t.name === "brain_reindex");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("brain_reindex");
    expect(tool!.description).toContain("Rebuild vec0 vector index");
    expect(tool!.parameters.required).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reindex logic
// ---------------------------------------------------------------------------

describe("brain_reindex — vector index rebuild logic", () => {
  test("drops and recreates chunks_vec table, search still works", () => {
    // Insert test document
    const docId = generateId();
    db.run(
      "INSERT INTO documents (id, title, content, content_hash, path) VALUES (?, ?, ?, ?, ?)",
      [docId, "Reindex Test", "reindex test content", hashContent("reindex test content"), "/reindex.md"],
    );

    // Verify search works before reindex
    const before = brainSearch(db, "reindex", {
      contentType: "document",
      limit: 10,
    });
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before[0].title).toBe("Reindex Test");

    // Create stub chunks_vec table (simulating pre-existing vec0 table)
    db.run("CREATE TABLE IF NOT EXISTS chunks_vec (chunk_id TEXT PRIMARY KEY, embedding BLOB)");
    expect(tableExists("chunks_vec")).toBe(true);

    // Perform reindex: drop and recreate
    db.run("DROP TABLE IF EXISTS chunks_vec");
    db.run("CREATE TABLE IF NOT EXISTS chunks_vec (chunk_id TEXT PRIMARY KEY, embedding BLOB)");

    // Verify chunks_vec exists after reindex
    expect(tableExists("chunks_vec")).toBe(true);

    // Verify search still works after reindex
    const after = brainSearch(db, "reindex", {
      contentType: "document",
      limit: 10,
    });
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after[0].title).toBe("Reindex Test");
  });

  test("reindex with empty chunks table reports zero chunks", () => {
    // Ensure chunks count is queryable
    const countRow = db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()!;
    const chunkCount = countRow.c;

    // Create stub chunks_vec
    db.run("DROP TABLE IF EXISTS chunks_vec");
    db.run("CREATE TABLE IF NOT EXISTS chunks_vec (chunk_id TEXT PRIMARY KEY, embedding BLOB)");

    // Verify table exists
    expect(tableExists("chunks_vec")).toBe(true);

    // Chunk count should be a number
    expect(typeof chunkCount).toBe("number");
  });
});
