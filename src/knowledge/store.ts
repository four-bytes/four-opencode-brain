// ---------------------------------------------------------------------------
// Brain knowledge store — SQLite-backed knowledge base with confidence-gated
// updates, automatic revision tracking, and occurrence history.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { generateId } from "../schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KbEntryFull {
  entry_key: string;
  kind: string;
  title: string;
  description: string | null;
  entity_type: string | null;
  root_cause: string | null;
  canonical_solution: string | null;
  tags: string | null;
  confidence: number;
  review_state: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string | null;
  occurrences: KbOccurrence[];
  revisions: KbRevision[];
}

export interface KbOccurrence {
  id: string;
  entry_key: string;
  kind: string;
  project_ref: string | null;
  repo_ref: string | null;
  issue_ref: string | null;
  commit_ref: string | null;
  observed_symptoms: string | null;
  outcome: string;
  occurred_at: string;
}

export interface KbRevision {
  id: string;
  entry_key: string;
  kind: string;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  confidence_at_time: number | null;
  review_state_at_time: string | null;
  created_at: string;
}

export interface KbAddInput {
  entry_key: string;
  kind: string;
  title: string;
  description?: string;
  entity_type?: string;
  root_cause?: string;
  canonical_solution?: string;
  tags?: string;
  confidence?: number;
  review_state?: string;
}

export interface KbAddResult {
  entry: KbEntryFull;
  action: "created" | "updated" | "gated";
}

export interface KbRecordInput {
  entry_key: string;
  kind: string;
  project_ref?: string;
  repo_ref?: string;
  issue_ref?: string;
  commit_ref?: string;
  observed_symptoms?: string;
  outcome: "fixed" | "failed" | "workaround" | "observed";
}

export interface KbReviewInput {
  entry_key: string;
  kind: string;
  review_state: "draft" | "reviewed" | "accepted" | "rejected" | "superseded";
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Internal row types (from SQLite)
// ---------------------------------------------------------------------------

interface KbEntryRow {
  entry_key: string;
  kind: string;
  title: string;
  description: string | null;
  entity_type: string | null;
  root_cause: string | null;
  canonical_solution: string | null;
  tags: string | null;
  confidence: number;
  review_state: string;
  superseded_by: string | null;
  created_at: string;
  updated_at: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function deriveEntryKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/** Fields tracked for revision diffs */
const REVISION_FIELDS: Array<{ field: string; dbField: string }> = [
  { field: "title", dbField: "title" },
  { field: "description", dbField: "description" },
  { field: "entity_type", dbField: "entity_type" },
  { field: "root_cause", dbField: "root_cause" },
  { field: "canonical_solution", dbField: "canonical_solution" },
  { field: "tags", dbField: "tags" },
  { field: "confidence", dbField: "confidence" },
  { field: "review_state", dbField: "review_state" },
];

// ---------------------------------------------------------------------------
// kbGet — Get full entry with occurrences + revisions
// ---------------------------------------------------------------------------

export function kbGet(
  db: Database,
  entryKey: string,
  kind?: string,
): KbEntryFull | null {
  let sql = "SELECT * FROM knowledge_entries WHERE entry_key = ?";
  const params: unknown[] = [entryKey];
  if (kind) {
    sql += " AND kind = ?";
    params.push(kind);
  }
  sql += " LIMIT 1";

  const row = db.query<KbEntryRow, unknown[]>(sql).get(...params);
  if (!row) return null;

  const occurrences = db
    .query<KbOccurrence, unknown[]>(
      "SELECT * FROM knowledge_occurrences WHERE entry_key = ? AND kind = ? ORDER BY occurred_at DESC",
    )
    .all(row.entry_key, row.kind);

  const revisions = db
    .query<KbRevision, unknown[]>(
      "SELECT * FROM knowledge_revisions WHERE entry_key = ? AND kind = ? ORDER BY created_at ASC",
    )
    .all(row.entry_key, row.kind);

  return { ...row, occurrences, revisions };
}

// ---------------------------------------------------------------------------
// kbAdd — Add or update with confidence-gating
// ---------------------------------------------------------------------------

export function kbAdd(db: Database, input: KbAddInput): KbAddResult {
  // Validate confidence range
  if (input.confidence !== undefined) {
    if (input.confidence < 0 || input.confidence > 1) {
      throw new Error("Confidence must be between 0.0 and 1.0");
    }
  }

  // Derive entry_key from title if empty
  const entryKey = input.entry_key || deriveEntryKey(input.title);

  // Check for existing entry
  const existing = db
    .query<KbEntryRow, unknown[]>(
      "SELECT * FROM knowledge_entries WHERE entry_key = ? AND kind = ? LIMIT 1",
    )
    .get(entryKey, input.kind);

  if (!existing) {
    // --- CREATE: new entry, always confidence 0.0 / review_state "draft" ---
    db.run(
      `INSERT INTO knowledge_entries (entry_key, kind, title, description, entity_type, root_cause, canonical_solution, tags, confidence, review_state, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryKey,
        input.kind,
        input.title,
        input.description ?? null,
        input.entity_type ?? "problem",
        input.root_cause ?? null,
        input.canonical_solution ?? null,
        input.tags ?? null,
        0.0,
        "draft",
        null,
      ],
    );

    const full = kbGet(db, entryKey, input.kind)!;
    return { entry: full, action: "created" };
  }

  // --- CONFIDENCE GATE ---
  const inputConfidence = input.confidence ?? 0.0;
  if (inputConfidence <= existing.confidence) {
    // Rejected: return existing entry unchanged
    const full = kbGet(db, entryKey, input.kind)!;
    return { entry: full, action: "gated" };
  }

  // --- UPDATE: overwrite with new values ---
  const newReviewState = input.review_state ?? "draft";

  // Record revisions for each changed field
  for (const { field, dbField } of REVISION_FIELDS) {
    const oldVal = String((existing as any)[dbField] ?? "");
    const newVal = String(input[field as keyof KbAddInput] ?? "");
    if (oldVal !== newVal) {
      db.run(
        `INSERT INTO knowledge_revisions (id, entry_key, kind, field_name, old_value, new_value, confidence_at_time, review_state_at_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          entryKey,
          input.kind,
          field,
          (existing as any)[dbField] !== null
            ? String((existing as any)[dbField])
            : null,
          input[field as keyof KbAddInput] !== undefined
            ? String(input[field as keyof KbAddInput])
            : null,
          inputConfidence,
          newReviewState,
        ],
      );
    }
  }

  // Perform the UPDATE
  db.run(
    `UPDATE knowledge_entries
     SET title = ?, description = ?, entity_type = ?, root_cause = ?,
         canonical_solution = ?, tags = ?, confidence = ?,
         review_state = ?, updated_at = datetime('now')
     WHERE entry_key = ? AND kind = ?`,
    [
      input.title,
      input.description ?? null,
      input.entity_type ?? "problem",
      input.root_cause ?? null,
      input.canonical_solution ?? null,
      input.tags ?? null,
      inputConfidence,
      newReviewState,
      entryKey,
      input.kind,
    ],
  );

  const full = kbGet(db, entryKey, input.kind)!;
  return { entry: full, action: "updated" };
}

// ---------------------------------------------------------------------------
// kbRecord — Record occurrence outcome
// ---------------------------------------------------------------------------

export function kbRecord(db: Database, input: KbRecordInput): KbOccurrence {
  // Verify entry exists
  const existing = db
    .query<KbEntryRow, unknown[]>(
      "SELECT entry_key, kind FROM knowledge_entries WHERE entry_key = ? AND kind = ? LIMIT 1",
    )
    .get(input.entry_key, input.kind);

  if (!existing) {
    throw new Error("entry not found");
  }

  const id = generateId();
  db.run(
    `INSERT INTO knowledge_occurrences (id, entry_key, kind, project_ref, repo_ref, issue_ref, commit_ref, observed_symptoms, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.entry_key,
      input.kind,
      input.project_ref ?? null,
      input.repo_ref ?? null,
      input.issue_ref ?? null,
      input.commit_ref ?? null,
      input.observed_symptoms ?? null,
      input.outcome,
    ],
  );

  const row = db
    .query<KbOccurrence, unknown[]>(
      "SELECT * FROM knowledge_occurrences WHERE id = ?",
    )
    .get(id);

  // ── E8.1: Confidence Auto-Bump ──────────────────────────────────────────
  if (input.outcome === "fixed") {
    const current = db
      .query<KbEntryRow, unknown[]>(
        "SELECT * FROM knowledge_entries WHERE entry_key = ? AND kind = ? LIMIT 1",
      )
      .get(input.entry_key, input.kind);

    if (current) {
      // Count fixed outcomes
      const fixedCount = db
        .query<{ c: number }, unknown[]>(
          "SELECT COUNT(*) AS c FROM knowledge_occurrences WHERE entry_key = ? AND kind = ? AND outcome = 'fixed'",
        )
        .get(input.entry_key, input.kind)!;

      // Auto-bump confidence by 0.1 (capped at 0.9)
      const newConfidence = Math.min(0.9, current.confidence + 0.1);

      // Auto-accept if 5+ fixed outcomes
      let newReviewState = current.review_state;
      if (fixedCount.c >= 5) {
        newReviewState = "accepted";
      }

      // Only update if something changed
      if (newConfidence !== current.confidence || newReviewState !== current.review_state) {
        // Record revision for confidence change
        if (newConfidence !== current.confidence) {
          db.run(
            `INSERT INTO knowledge_revisions (id, entry_key, kind, field_name, old_value, new_value, confidence_at_time, review_state_at_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              generateId(),
              input.entry_key,
              input.kind,
              "confidence",
              String(current.confidence),
              String(newConfidence),
              newConfidence,
              newReviewState,
            ],
          );
        }

        // Record revision for review_state change
        if (newReviewState !== current.review_state) {
          db.run(
            `INSERT INTO knowledge_revisions (id, entry_key, kind, field_name, old_value, new_value, confidence_at_time, review_state_at_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              generateId(),
              input.entry_key,
              input.kind,
              "review_state",
              current.review_state,
              newReviewState,
              newConfidence,
              newReviewState,
            ],
          );
        }

        db.run(
          `UPDATE knowledge_entries
           SET confidence = ?, review_state = ?, updated_at = datetime('now')
           WHERE entry_key = ? AND kind = ?`,
          [newConfidence, newReviewState, input.entry_key, input.kind],
        );
      }
    }
  }

  return row!;
}

// ---------------------------------------------------------------------------
// REGATE — Validated review-state transitions
// ---------------------------------------------------------------------------

const ALLOWED_REVIEW_TRANSITIONS: Record<string, string[]> = {
  draft: ["reviewed", "rejected"],
  reviewed: ["accepted", "rejected"],
  accepted: ["rejected"],
};

function validateReviewTransition(current: string, target: string): void {
  // Terminal states can NEVER be changed
  if (current === "rejected" || current === "superseded") {
    throw new Error(`terminal state: ${current}`);
  }

  // ANY → rejected is always allowed
  if (target === "rejected") return;

  // Allow no-op (same state)
  if (current === target) return;

  // Look up allowed transitions from current state
  const allowed = ALLOWED_REVIEW_TRANSITIONS[current];
  if (!allowed || !allowed.includes(target)) {
    throw new Error(`Invalid transition: ${current} → ${target}`);
  }
}

// ---------------------------------------------------------------------------
// kbReview — Review-state lifecycle with REGATE
// ---------------------------------------------------------------------------

export function kbReview(db: Database, input: KbReviewInput): KbEntryFull {
  // Validate confidence range if provided
  if (input.confidence !== undefined) {
    if (input.confidence < 0 || input.confidence > 1) {
      throw new Error("Confidence must be between 0.0 and 1.0");
    }
  }

  // Get current entry
  const current = db
    .query<KbEntryRow, unknown[]>(
      "SELECT * FROM knowledge_entries WHERE entry_key = ? AND kind = ? LIMIT 1",
    )
    .get(input.entry_key, input.kind);

  if (!current) {
    throw new Error("entry not found");
  }

  // Validate transition
  validateReviewTransition(current.review_state, input.review_state);

  // No-op: same state, no confidence change — return as-is
  if (
    current.review_state === input.review_state &&
    input.confidence === undefined
  ) {
    return kbGet(db, input.entry_key, input.kind)!;
  }

  // Resolve new confidence
  const newConfidence =
    input.confidence !== undefined ? input.confidence : current.confidence;

  // Record revision for review_state change (if changed)
  if (current.review_state !== input.review_state) {
    db.run(
      `INSERT INTO knowledge_revisions (id, entry_key, kind, field_name, old_value, new_value, confidence_at_time, review_state_at_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        input.entry_key,
        input.kind,
        "review_state",
        current.review_state,
        input.review_state,
        newConfidence,
        input.review_state,
      ],
    );
  }

  // Record revision for confidence change (if changed)
  if (
    input.confidence !== undefined &&
    current.confidence !== input.confidence
  ) {
    db.run(
      `INSERT INTO knowledge_revisions (id, entry_key, kind, field_name, old_value, new_value, confidence_at_time, review_state_at_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        input.entry_key,
        input.kind,
        "confidence",
        String(current.confidence),
        String(input.confidence),
        input.confidence,
        input.review_state,
      ],
    );
  }

  // Perform the UPDATE
  db.run(
    `UPDATE knowledge_entries
     SET review_state = ?,
         confidence = ?,
         updated_at = datetime('now')
     WHERE entry_key = ? AND kind = ?`,
    [
      input.review_state,
      newConfidence,
      input.entry_key,
      input.kind,
    ],
  );

  return kbGet(db, input.entry_key, input.kind)!;
}

// ---------------------------------------------------------------------------
// kbSearch — FTS5 search knowledge entries with optional filters
// ---------------------------------------------------------------------------

export interface KbSearchOptions {
  query: string;
  entity_type?: string;
  kind?: string;
  confidence_min?: number;
  review_state?: string;
  limit?: number;
  offset?: number;
}

export interface KbSearchResult {
  entry_key: string;
  kind: string;
  title: string;
  description: string | null;
  entity_type: string;
  root_cause: string | null;
  canonical_solution: string | null;
  tags: string | null;
  confidence: number;
  review_state: string;
  rank: number;
}

export function kbSearch(
  db: Database,
  options: KbSearchOptions,
): KbSearchResult[] {
  if (!options.query || options.query.trim().length === 0) {
    return [];
  }

  let sql = `
    SELECT k.entry_key, k.kind, k.title, k.description, k.entity_type,
           k.root_cause, k.canonical_solution, k.tags, k.confidence, k.review_state,
           rank
    FROM entries_fts f
    JOIN knowledge_entries k ON k.rowid = f.rowid
    WHERE entries_fts MATCH ?
  `;
  const params: unknown[] = [options.query];

  if (options.entity_type) {
    sql += " AND k.entity_type = ?";
    params.push(options.entity_type);
  }
  if (options.kind) {
    sql += " AND k.kind = ?";
    params.push(options.kind);
  }
  if (options.confidence_min !== undefined) {
    sql += " AND k.confidence >= ?";
    params.push(options.confidence_min);
  }
  if (options.review_state) {
    sql += " AND k.review_state = ?";
    params.push(options.review_state);
  }

  sql += " ORDER BY rank";

  if (options.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }
  if (options.offset !== undefined) {
    sql += " OFFSET ?";
    params.push(options.offset);
  }

  try {
    return db.query<KbSearchResult, unknown[]>(sql).all(...params);
  } catch {
    return [];
  }
}
