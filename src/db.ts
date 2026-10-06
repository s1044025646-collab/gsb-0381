import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DecomposeResult, RunStatus } from "./greedy.js";
import { ALGORITHM_VERSION } from "./greedy.js";
import type { StepReport } from "./greedy.js";

export interface RunRecord {
  id: number;
  rawNumerator: string;
  rawDenominator: string;
  normalizedNum: string;
  normalizedDen: string;
  maxTerms: number;
  maxDigits: number;
  algorithmVersion: string;
  status: RunStatus;
  termsJson: string;
  remainderNum: string;
  remainderDen: string;
  identityVerified: number;
  completedVerified: number;
  createdAt: string;
}

export interface StepRow {
  runId: number;
  step: number;
  beforeNum: string;
  beforeDen: string;
  denominator: string;
  rawNum: string;
  rawDen: string;
  reduceFactor: string;
  afterNum: string;
  afterDen: string;
}

let dbInstance: DatabaseSync | null = null;

/** 仅供测试：重置单例（例如关闭连接后需要重开时）。 */
export function _resetDbInstance(): void {
  dbInstance = null;
}

export function openDatabase(dbPath: string): DatabaseSync {
  if (dbInstance) return dbInstance;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_numerator TEXT NOT NULL,
      raw_denominator TEXT NOT NULL,
      normalized_num TEXT NOT NULL,
      normalized_den TEXT NOT NULL,
      max_terms INTEGER NOT NULL,
      max_digits INTEGER NOT NULL,
      algorithm_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed','term_budget','digit_budget')),
      terms_json TEXT NOT NULL,
      remainder_num TEXT NOT NULL,
      remainder_den TEXT NOT NULL,
      identity_verified INTEGER NOT NULL,
      completed_verified INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS steps (
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      before_num TEXT NOT NULL,
      before_den TEXT NOT NULL,
      denominator TEXT NOT NULL,
      raw_num TEXT NOT NULL,
      raw_den TEXT NOT NULL,
      reduce_factor TEXT NOT NULL,
      after_num TEXT NOT NULL,
      after_den TEXT NOT NULL,
      PRIMARY KEY (run_id, step)
    );
  `);
  dbInstance = db;
  return db;
}

/**
 * 原子发布一次完整报告：在单个事务里写入 run 与全部 steps。
 * 事务失败（含预算非法等在算法层已抛出的情形）不会写入任何内容，
 * 因此绝不会覆盖旧报告。
 */
export function publishResult(db: DatabaseSync, result: DecomposeResult): number {
  const insertRun = db.prepare(`
    INSERT INTO runs (
      raw_numerator, raw_denominator, normalized_num, normalized_den,
      max_terms, max_digits, algorithm_version, status,
      terms_json, remainder_num, remainder_den,
      identity_verified, completed_verified
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertStep = db.prepare(`
    INSERT INTO steps (
      run_id, step, before_num, before_den, denominator,
      raw_num, raw_den, reduce_factor, after_num, after_den
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let runId = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const info = insertRun.run(
      result.originalInput.numerator,
      result.originalInput.denominator,
      result.normalized.num.toString(),
      result.normalized.den.toString(),
      result.budget.maxTerms,
      result.budget.maxDigits,
      result.algorithmVersion,
      result.status,
      JSON.stringify(result.terms),
      result.remainder.num.toString(),
      result.remainder.den.toString(),
      result.identityVerified ? 1 : 0,
      result.completedVerified ? 1 : 0,
    );
    runId = Number(info.lastInsertRowid);
    for (const s of result.steps) {
      insertStep.run(
        runId,
        s.step,
        s.before.num.toString(),
        s.before.den.toString(),
        s.denominator,
        s.rawRemainder.num.toString(),
        s.rawRemainder.den.toString(),
        s.reduceFactor,
        s.after.num.toString(),
        s.after.den.toString(),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return runId;
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: Number(row.id),
    rawNumerator: String(row.raw_numerator),
    rawDenominator: String(row.raw_denominator),
    normalizedNum: String(row.normalized_num),
    normalizedDen: String(row.normalized_den),
    maxTerms: Number(row.max_terms),
    maxDigits: Number(row.max_digits),
    algorithmVersion: String(row.algorithm_version),
    status: String(row.status) as RunStatus,
    termsJson: String(row.terms_json),
    remainderNum: String(row.remainder_num),
    remainderDen: String(row.remainder_den),
    identityVerified: Number(row.identity_verified),
    completedVerified: Number(row.completed_verified),
    createdAt: String(row.created_at),
  };
}

export function getRun(db: DatabaseSync, id: number): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapRun(row) : null;
}

export function listRuns(db: DatabaseSync, limit = 50): RunRecord[] {
  const rows = db
    .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(mapRun);
}

export function getSteps(db: DatabaseSync, runId: number): StepRow[] {
  const rows = db
    .prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step ASC")
    .all(runId) as Record<string, unknown>[];
  return rows.map((row) => ({
    runId,
    step: Number(row.step),
    beforeNum: String(row.before_num),
    beforeDen: String(row.before_den),
    denominator: String(row.denominator),
    rawNum: String(row.raw_num),
    rawDen: String(row.raw_den),
    reduceFactor: String(row.reduce_factor),
    afterNum: String(row.after_num),
    afterDen: String(row.after_den),
  }));
}

export function runToSerializable(record: RunRecord, steps: StepRow[]) {
  return {
    id: record.id,
    originalInput: { numerator: record.rawNumerator, denominator: record.rawDenominator },
    normalized: { num: record.normalizedNum, den: record.normalizedDen },
    budget: { maxTerms: record.maxTerms, maxDigits: record.maxDigits },
    algorithmVersion: record.algorithmVersion === ALGORITHM_VERSION ? record.algorithmVersion : record.algorithmVersion,
    status: record.status,
    terms: JSON.parse(record.termsJson) as string[],
    remainder: { num: record.remainderNum, den: record.remainderDen },
    identityVerified: record.identityVerified === 1,
    completedVerified: record.completedVerified === 1,
    createdAt: record.createdAt,
    steps: steps.map((s): StepReport => ({
      step: s.step,
      before: { num: BigInt(s.beforeNum), den: BigInt(s.beforeDen) },
      denominator: s.denominator,
      rawRemainder: { num: BigInt(s.rawNum), den: BigInt(s.rawDen) },
      reduceFactor: s.reduceFactor,
      after: { num: BigInt(s.afterNum), den: BigInt(s.afterDen) },
    })),
  };
}

/** 将含 BigInt 的完整结果转为可 JSON 序列化结构。 */
export function resultToSerializable(id: number, result: DecomposeResult) {
  return {
    id,
    originalInput: result.originalInput,
    normalized: { num: result.normalized.num.toString(), den: result.normalized.den.toString() },
    budget: result.budget,
    algorithmVersion: result.algorithmVersion,
    status: result.status,
    terms: result.terms,
    remainder: { num: result.remainder.num.toString(), den: result.remainder.den.toString() },
    identityVerified: result.identityVerified,
    completedVerified: result.completedVerified,
    steps: result.steps.map((s) => ({
      step: s.step,
      before: { num: s.before.num.toString(), den: s.before.den.toString() },
      denominator: s.denominator,
      rawRemainder: { num: s.rawRemainder.num.toString(), den: s.rawRemainder.den.toString() },
      reduceFactor: s.reduceFactor,
      after: { num: s.after.num.toString(), den: s.after.den.toString() },
    })),
  };
}
