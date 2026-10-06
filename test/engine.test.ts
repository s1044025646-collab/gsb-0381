import assert from "node:assert/strict";
import { test } from "node:test";
import { greedyDecompose, type FractionString } from "../src/fraction.js";
import { verifyCandidate } from "../src/verify.js";

test("4/13 贪心分解为 1/4 + 1/18 + 1/468", () => {
  const result = greedyDecompose({ numerator: "4", denominator: "13" });
  assert.deepEqual(result.terms, ["4", "18", "468"]);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.remainder, { numerator: "0", denominator: "1" });
  assert.deepEqual(result.steps.map((step) => step.rawRemainder), [
    { numerator: "3", denominator: "52" },
    { numerator: "2", denominator: "936" },
    { numerator: "0", denominator: "219024" },
  ]);
  assert.deepEqual(result.steps.map((step) => step.reduceFactor), ["1", "2", "1"]);
});

test("2/3 贪心分解为 1/2 + 1/6", () => {
  const result = greedyDecompose({ numerator: "2", denominator: "3" });
  assert.deepEqual(result.terms, ["2", "6"]);
  assert.equal(result.independentCheck.ok, true);
});

test("2/6 与 1/3 保留原始输入但得到相同结果", () => {
  const reduced = greedyDecompose({ numerator: "1", denominator: "3" });
  const nonReduced = greedyDecompose({ numerator: "2", denominator: "6" });
  assert.deepEqual(nonReduced.input, { numerator: "2", denominator: "6" });
  assert.deepEqual(nonReduced.normalizedInput, { numerator: "1", denominator: "3" });
  assert.deepEqual(nonReduced.terms, reduced.terms);
});

test("本身是单位分数时只输出一项", () => {
  const result = greedyDecompose({ numerator: "7", denominator: "21" });
  assert.deepEqual(result.terms, ["3"]);
  assert.equal(result.status, "complete");
});

test("maxTerms 为 1 时保持未完成状态并返回精确余数", () => {
  const result = greedyDecompose(
    { numerator: "4", denominator: "13" },
    { maxTerms: 1, maxDigits: 1000 },
  );
  assert.equal(result.status, "incomplete_max_terms");
  assert.deepEqual(result.terms, ["4"]);
  assert.deepEqual(result.remainder, { numerator: "3", denominator: "52" });
});

test("位数预算会在提交超限步骤前停止", () => {
  const result = greedyDecompose(
    { numerator: "5", denominator: "121" },
    { maxTerms: 10, maxDigits: 5 },
  );
  assert.equal(result.status, "incomplete_digit_limit");
  assert.deepEqual(result.terms, ["25"]);
  assert.deepEqual(result.remainder, { numerator: "4", denominator: "3025" });
  for (const term of result.terms) {
    assert.ok(term.length <= 4);
  }
});

test("大整数全程使用精确 BigInt 并独立求和", () => {
  const result = greedyDecompose(
    {
      numerator: "123456789012345678901234567891",
      denominator: "987654321098765432109876543210",
    },
    { maxTerms: 10, maxDigits: 1000 },
  );
  assert.ok(result.terms.length >= 2);
  if (result.status === "complete") {
    assert.deepEqual(result.remainder, { numerator: "0", denominator: "1" });
  }
  assert.equal(result.independentCheck.ok, true);
});

test("拒绝零、负数、零分母、大于等于一和非法预算", () => {
  assert.throws(
    () => greedyDecompose({ numerator: "0", denominator: "3" }),
    (error: unknown) => error instanceof Error && error.message === "只接受正的分子和分母",
  );
  assert.throws(
    () => greedyDecompose({ numerator: "-1", denominator: "3" }),
    (error: unknown) => error instanceof Error && error.message === "只接受正的分子和分母",
  );
  assert.throws(() => greedyDecompose({ numerator: "1", denominator: "0" }), /分母不能为零/);
  assert.throws(() => greedyDecompose({ numerator: "3", denominator: "3" }), /小于 1/);
  assert.throws(
    () =>
      greedyDecompose(
        { numerator: "1", denominator: "3" },
        { maxTerms: 0, maxDigits: 10 },
      ),
    /正安全整数/,
  );
});

test("候选核验区分贪心结果、合法替代、求和不等和非法格式", () => {
  const input: FractionString = { numerator: "5", denominator: "121" };
  const result = greedyDecompose(input);
  assert.equal(verifyCandidate(input, result.terms, result.terms).verdict, "greedy_match");
  const last = BigInt(result.terms.at(-1)!);
  const alternative = [
    ...result.terms.slice(0, -1),
    (last + 1n).toString(),
    (last * (last + 1n)).toString(),
  ];
  assert.equal(
    verifyCandidate(input, alternative, result.terms).verdict,
    "valid_alternative",
  );
  assert.equal(verifyCandidate(input, ["25", "700"], result.terms).verdict, "sum_mismatch");
  assert.equal(verifyCandidate(input, ["25", "20"], result.terms).verdict, "invalid_format");
  assert.equal(verifyCandidate(input, ["25", "0"], result.terms).verdict, "invalid_format");
});

test("随机小真分数逐项验证贪心上下界、分母次序和恒等式", () => {
  let seed = 0x1234abcd;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  for (let caseIndex = 0; caseIndex < 100; caseIndex += 1) {
    const q = BigInt(2 + Math.floor(random() * 80));
    const p = BigInt(1 + Math.floor(random() * Number(q - 1n)));
    const result = greedyDecompose(
      { numerator: p.toString(), denominator: q.toString() },
      { maxTerms: 30, maxDigits: 1000 },
    );
    assert.equal(result.status, "complete");

    let remainderP = p;
    let remainderQ = q;
    let previous = 0n;
    for (const denominatorString of result.terms) {
      const d = BigInt(denominatorString);
      assert.ok(d > previous);
      assert.ok(d * remainderP >= remainderQ, "1/d 不超过当前余数");
      assert.ok((d - 1n) * remainderP < remainderQ, "d-1 会超过当前余数");
      remainderP = d * remainderP - remainderQ;
      remainderQ *= d;
      previous = d;
    }
    assert.equal(remainderP, 0n);
    assert.equal(result.independentCheck.ok, true);
  }
});
