import { test } from "node:test";
import assert from "node:assert/strict";
import { decompose, checkCandidate, parseBudget } from "../src/greedy.js";
import { AppError } from "../src/errors.js";
import { fractionsEqual, sumUnitFractions } from "../src/fraction.js";

test("4/13 = 1/4 + 1/18 + 1/468（手算核对案例）", () => {
  const r = decompose({ rawNumerator: "4", rawDenominator: "13" });
  assert.equal(r.status, "completed");
  assert.deepEqual(r.terms, ["4", "18", "468"]);
  assert.equal(r.completedVerified, true);
  // 手算: 1/4+1/18+1/468 = (117+26+1)/468 = 144/468 = 4/13
  assert.ok(fractionsEqual(sumUnitFractions(r.terms.map(BigInt)), { num: 4n, den: 13n }));
});

test("2/3 = 1/2 + 1/6", () => {
  const r = decompose({ rawNumerator: "2", rawDenominator: "3" });
  assert.deepEqual(r.terms, ["2", "6"]);
  assert.equal(r.status, "completed");
});

test("本身就是单位分数 1/7", () => {
  const r = decompose({ rawNumerator: "1", rawDenominator: "7" });
  assert.deepEqual(r.terms, ["7"]);
  assert.equal(r.steps[0]!.rawRemainder.num.toString(), "0");
});

test("可约分输入 2/6 与 1/3 得到相同列表，且保留原始输入", () => {
  const a = decompose({ rawNumerator: "2", rawDenominator: "6" });
  const b = decompose({ rawNumerator: "1", rawDenominator: "3" });
  assert.deepEqual(a.terms, b.terms);
  // 1/3 本身就是单位分数
  assert.deepEqual(a.terms, ["3"]);
  assert.equal(a.originalInput.numerator, "2");
  assert.equal(a.normalized.num.toString(), "1");
});

test("项数预算为 1 时未完成并给出精确余数，恒等式仍成立", () => {
  const r = decompose({ rawNumerator: "4", rawDenominator: "13", budget: { maxTerms: 1 } });
  assert.equal(r.status, "term_budget");
  assert.deepEqual(r.terms, ["4"]);
  // 4/13 - 1/4 = (16-13)/52 = 3/52
  assert.equal(r.remainder.num.toString(), "3");
  assert.equal(r.remainder.den.toString(), "52");
  assert.equal(r.identityVerified, true);
  assert.equal(r.completedVerified, false);
});

test("中间位数超限：在提交超限步骤之前停止，保留有效状态", () => {
  // 11/999: d=91, 未约分余数 (11*91-999)/(999*91) = 2/90909，分母 5 位；maxDigits=3 在第一步提交前停止
  const r = decompose({ rawNumerator: "11", rawDenominator: "999", budget: { maxDigits: 3 } });
  assert.equal(r.status, "digit_budget");
  assert.equal(r.steps.length, 0);
  // 已提交的全部步骤与余数仍满足恒等式
  assert.equal(r.identityVerified, true);
  // 余数保持为原始约分输入（最后一个有效状态）
  assert.equal(r.remainder.num.toString(), "11");
  assert.equal(r.remainder.den.toString(), "999");
  for (const s of r.steps) {
    assert.ok(BigInt(s.denominator).toString().length <= 2);
    assert.ok(s.rawRemainder.den.toString().length <= 2);
  }
});

test("非法输入：零、负数、零分母、大于等于一、非数字", () => {
  assert.throws(() => decompose({ rawNumerator: "0", rawDenominator: "3" }), (e: unknown) =>
    e instanceof AppError && e.code === "ZERO_NUMERATOR",
  );
  assert.throws(() => decompose({ rawNumerator: "1", rawDenominator: "0" }), (e: unknown) =>
    e instanceof AppError && e.code === "ZERO_DENOMINATOR",
  );
  assert.throws(() => decompose({ rawNumerator: "-1", rawDenominator: "3" }), (e: unknown) =>
    e instanceof AppError && e.code === "NEGATIVE_VALUE",
  );
  assert.throws(() => decompose({ rawNumerator: "3", rawDenominator: "3" }), (e: unknown) =>
    e instanceof AppError && e.code === "NOT_PROPER_FRACTION",
  );
  assert.throws(() => decompose({ rawNumerator: "abc", rawDenominator: "3" }), (e: unknown) =>
    e instanceof AppError && e.code === "INVALID_INTEGER",
  );
});

test("非法预算：0、负数、小数、非数字", () => {
  for (const bad of [0, -1, 1.5, "abc"] as unknown[]) {
    assert.throws(
      () => parseBudget(bad, 10),
      (e: unknown) => e instanceof AppError && e.code === "INVALID_BUDGET",
    );
  }
});

test("大整数精确运算（远超出安全整数范围）", () => {
  const big = "1234567890123456789012345678901234567890";
  const r = decompose({
    rawNumerator: big,
    rawDenominator: (BigInt(big) * 7n + 1n).toString(),
    budget: { maxTerms: 2, maxDigits: 5000 },
  });
  assert.equal(r.identityVerified, true);
  for (const d of r.terms.map(BigInt)) assert.ok(d > 0n);
  let prev = 0n;
  for (const d of r.terms.map(BigInt)) {
    assert.ok(d > prev);
    prev = d;
  }
});

test("候选核验：区分一致、备选正确、和不等、格式非法", () => {
  assert.equal(checkCandidate("4", "13", ["4", "18", "468"]).verdict, "valid_algorithm_match");
  // 2/15 的非贪心正确表示 1/10+1/30
  assert.equal(checkCandidate("2", "15", ["10", "30"]).verdict, "valid_alternative");
  assert.equal(checkCandidate("4", "13", ["2", "12"]).verdict, "sum_mismatch");
  assert.equal(checkCandidate("4", "13", ["4", "4", "18"]).verdict, "invalid_format");
  assert.equal(checkCandidate("4", "13", ["0"]).verdict, "invalid_format");
  assert.equal(checkCandidate("4", "13", ["-4"]).verdict, "invalid_format");
});

test("随机较小真分数：逐项验证贪心上下界、分母次序与完整恒等式", () => {
  let seed = 20261005;
  const rand = (): number => {
    // 确定性 LCG，保证测试可复现
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let trial = 0; trial < 200; trial++) {
    const den = BigInt(2 + (rand() % 998));
    const num = BigInt(1 + (rand() % Number(den - 1n)));
    const r = decompose({ rawNumerator: num.toString(), rawDenominator: den.toString() });
    assert.equal(r.status, "completed", `${num}/${den} 应在默认预算内完成`);
    let prev = 0n;
    for (const s of r.steps) {
      const p = s.before.num;
      const q = s.before.den;
      const d = BigInt(s.denominator);
      assert.ok(d > prev, "分母严格递增");
      prev = d;
      // 贪心上下界: 1/d <= p/q < 1/(d-1)，即 p*d >= q 且 p*(d-1) < q
      assert.ok(p * d >= q, "1/d 不超过当前余数");
      if (d > 1n) assert.ok(p * (d - 1n) < q, "1/(d-1) 严格大于当前余数");
      // 未约分余数与约分报告一致: rawNum/rawDen = afterNum/afterDen，且约分因子正确
      assert.equal(s.rawRemainder.num * s.after.den, s.after.num * s.rawRemainder.den);
      assert.equal(s.rawRemainder.num, s.after.num * BigInt(s.reduceFactor));
      assert.equal(s.rawRemainder.den, s.after.den * BigInt(s.reduceFactor));
    }
    assert.ok(
      fractionsEqual(sumUnitFractions(r.terms.map(BigInt)), { num, den: den }),
      `独立求和必须等于原输入 ${num}/${den}`,
    );
  }
});
