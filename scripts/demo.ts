/** 演示脚本：手算核对案例 + 预算对比 + 候选核验。运行: npm run demo */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompose, checkCandidate } from "../src/greedy.js";
import { openDatabase, publishResult, getRun, getSteps } from "../src/db.js";

function show(title: string, result: ReturnType<typeof decompose>): void {
  console.log("=".repeat(72));
  console.log(title);
  console.log("-".repeat(72));
  console.log(
    `输入 ${result.originalInput.numerator}/${result.originalInput.denominator}，约分 ` +
      `${result.normalized.num.toString()}/${result.normalized.den.toString()}，状态 ${result.status}`,
  );
  for (const s of result.steps) {
    console.log(
      `  步骤${s.step}: ${s.before.num.toString()}/${s.before.den.toString()} 选 1/${s.denominator}；` +
        `未约分余数 ${s.rawRemainder.num.toString()}/${s.rawRemainder.den.toString()}；` +
        `约分因子 ${s.reduceFactor}；下一轮 ${s.after.num.toString()}/${s.after.den.toString()}`,
    );
  }
  console.log(`  单位分数: ${result.terms.map((d) => `1/${d}`).join(" + ")}`);
  console.log(`  精确余数: ${result.remainder.num.toString()}/${result.remainder.den.toString()}`);
  console.log(
    `  恒等式核验: ${result.identityVerified ? "通过" : "失败"}` +
      (result.status === "completed" ? `；完整求和核验: ${result.completedVerified ? "通过" : "失败"}` : ""),
  );
}

// 1) 手算核对案例
show("案例 A: 4/13 = 1/4 + 1/18 + 1/468", decompose({ rawNumerator: "4", rawDenominator: "13" }));
show("案例 B: 2/3 = 1/2 + 1/6", decompose({ rawNumerator: "2", rawDenominator: "3" }));
show("案例 C: 2/6 约分后与 1/3 同结果", decompose({ rawNumerator: "2", rawDenominator: "6" }));

// 2) 项数预算 = 1：未完成 + 精确剩余量
show("案例 D: 4/13 预算 maxTerms=1（未完成，保留余数 3/52）",
  decompose({ rawNumerator: "4", rawDenominator: "13", budget: { maxTerms: 1 } }));

// 3) 位数预算极小：提交超限步骤之前停止
show("案例 E: 5/121 预算 maxDigits=3（位数预算不足）",
  decompose({ rawNumerator: "5", rawDenominator: "121", budget: { maxDigits: 3 } }));

// 4) 候选核验：另一种正确表示不判错（用脚本精确求出一个非贪心的合法备选）
console.log("=".repeat(72));
console.log("候选核验");
console.log("-".repeat(72));
// 2/15: 贪心 = 1/8 + 1/120；另一种正确表示 1/10 + 1/30（手算: 3/30+1/30=4/30=2/15）
for (const [num, den, candidate] of [
  ["4", "13", ["4", "18", "468"]], // 与贪心一致
  ["4", "13", ["2", "12"]], // 1/2+1/12=7/12 != 4/13 -> 和不相等
  ["4", "13", ["4", "4", "18"]], // 未严格递增 -> 格式非法
  ["2", "15", ["10", "30"]], // 正确但非贪心 -> valid_alternative
] as [string, string, string[]][]) {
  const v = checkCandidate(num, den, candidate);
  console.log(`  对 ${num}/${den} 候选 [${candidate.join(", ")}] -> ${v.verdict}：${v.message}`);
}

// 5) SQLite 持久化与重启后读取（临时文件）
console.log("=".repeat(72));
const dbPath = join(tmpdir(), `egyptian-demo-${process.pid}.db`);
const db = openDatabase(dbPath);
const id = publishResult(db, decompose({ rawNumerator: "4", rawDenominator: "13" }));
const run = getRun(db, id)!;
const steps = getSteps(db, id);
console.log(`持久化: 写入 ${dbPath}，读回 #${run.id} status=${run.status}，${steps.length} 个步骤仍可逐行查看精确分数`);
console.log("=".repeat(72));
console.log("演示完成。");
