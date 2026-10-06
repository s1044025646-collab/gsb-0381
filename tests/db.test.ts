import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { decompose } from "../src/greedy.js";
import { _resetDbInstance, getRun, getSteps, openDatabase, publishResult } from "../src/db.js";

test("SQLite 原子发布：重启后逐步骤精确分数可读", async () => {
  const dbPath = join(tmpdir(), `egyptian-test-${process.pid}-${Date.now()}.db`);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  }

  {
    const db = openDatabase(dbPath);
    const id = publishResult(db, decompose({ rawNumerator: "2", rawDenominator: "6" }));
    assert.equal(id, 1);
    db.close();
    _resetDbInstance();
  }

  // 重新打开同一文件（模拟重启）
  const { DatabaseSync } = await import("node:sqlite");
  const reopened = new DatabaseSync(dbPath);
  const row = reopened.prepare("SELECT * FROM runs WHERE id = 1").get() as Record<string, unknown>;
  assert.equal(row.raw_numerator, "2");
  assert.equal(row.normalized_num, "1");
  assert.equal(row.status, "completed");
  assert.equal(row.algorithm_version, "greedy-bigint-v1");
  const stepRows = reopened.prepare("SELECT * FROM steps ORDER BY step").all() as Record<string, unknown>[];
  // 2/6 约分后为 1/3，本身就是单位分数，只有 1 步
  assert.equal(stepRows.length, 1);
  assert.equal(stepRows[0]!.denominator, "3");
  assert.equal(stepRows[0]!.after_num, "0");
  reopened.close();
});

test("失败请求不覆盖旧报告", () => {
  const dbPath = join(tmpdir(), `egyptian-test2-${process.pid}-${Date.now()}.db`);
  _resetDbInstance();
  const db = openDatabase(dbPath);
  const id = publishResult(db, decompose({ rawNumerator: "4", rawDenominator: "13" }));
  const before = getRun(db, id)!;
  assert.throws(() =>
    publishResult(db, decompose({ rawNumerator: "4", rawDenominator: "13", budget: { maxTerms: 0 } })),
  );
  const after = getRun(db, id)!;
  assert.equal(after.status, before.status);
  assert.equal(after.termsJson, before.termsJson);
  assert.equal(getSteps(db, id).length, 3); // 4/13 确实是 3 步
});
