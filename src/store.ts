import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Budget, DecompositionResult, FractionString } from "./fraction.js";
import type { CandidateVerification } from "./verify.js";

export type RunRecord = {
  id: string;
  input: FractionString;
  budget: Budget;
  algorithmVersion: string;
  status: "pending" | DecompositionResult["status"];
  result: DecompositionResult | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredVerification = CandidateVerification & {
  id: string;
  runId: string;
  createdAt: string;
};

function migrate(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      raw_numerator TEXT NOT NULL,
      raw_denominator TEXT NOT NULL,
      max_terms INTEGER NOT NULL,
      max_digits INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      status TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      remainder_numerator TEXT,
      remainder_denominator TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS steps (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      before_numerator TEXT NOT NULL,
      before_denominator TEXT NOT NULL,
      denominator TEXT NOT NULL,
      raw_numerator TEXT NOT NULL,
      raw_denominator TEXT NOT NULL,
      reduce_factor TEXT NOT NULL,
      after_numerator TEXT,
      after_denominator TEXT,
      PRIMARY KEY (run_id, sequence),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
  `);
}

export class RunStore {
  private readonly database: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.database = new DatabaseSync(dbPath);
    migrate(this.database);
  }

  close(): void {
    this.database.close();
  }

  create(input: FractionString, budget: Budget): RunRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO runs (
          id, raw_numerator, raw_denominator, max_terms, max_digits,
          algorithm_version, status, terms_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.numerator,
        input.denominator,
        budget.maxTerms,
        budget.maxDigits,
        "greedy-ceil-v1",
        "pending",
        "[]",
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): RunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.toRunRecord(row) : null;
  }

  list(): RunRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM runs ORDER BY created_at DESC, id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.toRunRecord(row));
  }

  publishResult(id: string, result: DecompositionResult): RunRecord {
    const existing = this.get(id);
    if (!existing) {
      throw new Error("RUN_NOT_FOUND");
    }
    if (existing.result) {
      throw new Error("REPORT_ALREADY_EXISTS");
    }

    const now = new Date().toISOString();
    const insertStep = this.database.prepare(
      `INSERT INTO steps (
        run_id, sequence, before_numerator, before_denominator, denominator,
        raw_numerator, raw_denominator, reduce_factor, after_numerator, after_denominator
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateRun = this.database.prepare(
      `UPDATE runs SET
        status = ?, terms_json = ?, remainder_numerator = ?,
        remainder_denominator = ?, result_json = ?, updated_at = ?
       WHERE id = ? AND result_json IS NULL`,
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const step of result.steps) {
        insertStep.run(
          id,
          step.sequence,
          step.before.numerator,
          step.before.denominator,
          step.denominator,
          step.rawRemainder.numerator,
          step.rawRemainder.denominator,
          step.reduceFactor,
          step.after?.numerator ?? null,
          step.after?.denominator ?? null,
        );
      }
      const changed = updateRun.run(
        result.status,
        JSON.stringify(result.terms),
        result.remainder.numerator,
        result.remainder.denominator,
        JSON.stringify(result),
        now,
        id,
      );
      if (Number(changed.changes) !== 1) {
        throw new Error("REPORT_ALREADY_EXISTS");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.get(id)!;
  }

  getSteps(id: string) {
    const run = this.get(id);
    if (!run) {
      return null;
    }
    if (run.result) {
      return run.result.steps;
    }
    return [];
  }

  compare(ids: string[]): RunRecord[] {
    return ids
      .map((id) => this.get(id))
      .filter((run): run is RunRecord => run !== null);
  }

  saveVerification(runId: string, verification: CandidateVerification): StoredVerification {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO verifications (id, run_id, verdict, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, runId, verification.verdict, JSON.stringify(verification), now);
    return { ...verification, id, runId, createdAt: now };
  }

  listVerifications(runId: string): StoredVerification[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM verifications WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      ...(JSON.parse(String(row.payload_json)) as CandidateVerification),
      id: String(row.id),
      runId: String(row.run_id),
      createdAt: String(row.created_at),
    }));
  }

  private toRunRecord(row: Record<string, unknown>): RunRecord {
    const result = row.result_json
      ? (JSON.parse(String(row.result_json)) as DecompositionResult)
      : null;
    return {
      id: String(row.id),
      input: {
        numerator: String(row.raw_numerator),
        denominator: String(row.raw_denominator),
      },
      budget: {
        maxTerms: Number(row.max_terms),
        maxDigits: Number(row.max_digits),
      },
      algorithmVersion: String(row.algorithm_version),
      status: result?.status ?? ("pending" as const),
      result,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export function defaultDatabasePath(): string {
  return "data/egyptian.sqlite";
}
