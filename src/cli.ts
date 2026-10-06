#!/usr/bin/env node
import { join } from "node:path";
import { AppError } from "./errors.js";
import { checkCandidate, decompose, ALGORITHM_VERSION } from "./greedy.js";
import { getRun, getSteps, listRuns, openDatabase, publishResult } from "./db.js";
import { decimalApprox } from "./fraction.js";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const rest = argv.slice(1);
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const key = body;
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, "true");
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

const HELP = [
  `埃及单位分数贪心分解 CLI（${ALGORITHM_VERSION}）`,
  "",
  "用法:",
  "  npm run cli -- decompose <分子> <分母> [--max-terms N] [--max-digits N] [--save]",
  "  npm run cli -- steps <runId>",
  "  npm run cli -- get <runId>",
  "  npm run cli -- list",
  '  npm run cli -- compare <分子> <分母> --budgets "N:M,N:M"   (每项为 maxTerms:maxDigits，可省略一侧)',
  '  npm run cli -- verify <分子> <分母> --denominators "4,18,468"',
  "  npm run cli -- export <runId> [--file out.json]",
  "  npm run cli -- help",
  "",
  "说明:",
  "  - 全部数值以精确十进制字符串输出“分数”，另附仅供展示的十进制近似（不参与计算）。",
  "  - 状态 status: completed（完整分解）| term_budget（项数预算不足）| digit_budget（位数预算不足）。",
  "  - 未完成时恒等式仍成立: 原输入 = 已生成单位分数之和 + 精确余数。",
].join("\n");

function printResult(result: ReturnType<typeof decompose>, id?: number): void {
  const lines: string[] = [];
  lines.push(`算例${id !== undefined ? ` #${id}` : ""}  原始输入: ${result.originalInput.numerator}/${result.originalInput.denominator}`);
  lines.push(`约分后: ${result.normalized.num.toString()}/${result.normalized.den.toString()}  （十进制近似 ${decimalApprox(result.normalized)}，仅展示）`);
  lines.push(`预算: maxTerms=${result.budget.maxTerms}, maxDigits=${result.budget.maxDigits}  算法: ${result.algorithmVersion}`);
  lines.push(`状态: ${result.status}`);
  lines.push("");
  for (const s of result.steps) {
    lines.push(
      `步骤 ${String(s.step).padStart(2, " ")}: 余数 ${s.before.num.toString()}/${s.before.den.toString()}` +
        ` -> 选 1/${s.denominator}；未约分余数 ${s.rawRemainder.num.toString()}/${s.rawRemainder.den.toString()}` +
        `；约分因子 ${s.reduceFactor}；下一轮余数 ${s.after.num.toString()}/${s.after.den.toString()}` +
        `（≈${decimalApprox(s.after)}，仅展示）`,
    );
  }
  lines.push("");
  lines.push(`单位分数: ${result.terms.length ? result.terms.map((d) => `1/${d}`).join(" + ") : "（无）"}`);
  lines.push(`精确余数: ${result.remainder.num.toString()}/${result.remainder.den.toString()}`);
  lines.push(
    `恒等式核验(原值=已生成和+余数): ${result.identityVerified ? "通过" : "失败"}` +
      (result.status === "completed" ? `；完整分解独立求和核验: ${result.completedVerified ? "通过" : "失败"}` : ""),
  );
  if (result.status !== "completed") {
    lines.push("注意：结果未完成，部分列表不是完整分解；可用更大预算创建独立运行并对照此前缀。");
  }
  console.log(lines.join("\n"));
}

function getDbPath(): string {
  return process.env.EGYPTIAN_DB ?? join(process.cwd(), "data", "egyptian.db");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    console.log(HELP);
    return;
  }

  if (args.command === "decompose") {
    const [num, den] = args.positional;
    if (!num || !den) throw new AppError("VALIDATION_ERROR", "用法: decompose <分子> <分母>");
    const result = decompose({
      rawNumerator: num,
      rawDenominator: den,
      budget: {
        maxTerms: args.flags.get("max-terms") ? Number(args.flags.get("max-terms")) : undefined,
        maxDigits: args.flags.get("max-digits") ? Number(args.flags.get("max-digits")) : undefined,
      },
    });
    let id: number | undefined;
    if (args.flags.has("save")) {
      const db = openDatabase(getDbPath());
      id = publishResult(db, result);
    }
    printResult(result, id);
    return;
  }

  if (args.command === "compare") {
    const [num, den] = args.positional;
    if (!num || !den) throw new AppError("VALIDATION_ERROR", '用法: compare <分子> <分母> --budgets "3:1000,1:1000"');
    const spec = args.flags.get("budgets") ?? "";
    for (const part of spec.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      const [t, d] = part.split(":").map((s) => s.trim());
      const result = decompose({
        rawNumerator: num,
        rawDenominator: den,
        budget: {
          maxTerms: t && t !== "" ? Number(t) : undefined,
          maxDigits: d && d !== "" ? Number(d) : undefined,
        },
      });
      console.log(
        `预算 maxTerms=${result.budget.maxTerms} maxDigits=${result.budget.maxDigits} => ` +
          `状态=${result.status} 项数=${result.terms.length} 余数=${result.remainder.num.toString()}/${result.remainder.den.toString()} ` +
          `恒等式核验=${result.identityVerified ? "通过" : "失败"}`,
      );
      console.log(`  单位分数: ${result.terms.map((x) => `1/${x}`).join(" + ") || "（无）"}`);
    }
    return;
  }

  if (args.command === "verify") {
    const [num, den] = args.positional;
    if (!num || !den) throw new AppError("VALIDATION_ERROR", '用法: verify <分子> <分母> --denominators "4,18,468"');
    const denominators = (args.flags.get("denominators") ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const verdict = checkCandidate(num, den, denominators);
    console.log(`结论: ${verdict.message}`);
    console.log(`verdict=${verdict.verdict}`);
    console.log(
      `目标(约分)=${verdict.normalizedTarget.num.toString()}/${verdict.normalizedTarget.den.toString()}；` +
        `候选求和=${verdict.candidateSum ? `${verdict.candidateSum.num.toString()}/${verdict.candidateSum.den.toString()}` : "无法求和"}`,
    );
    console.log(`本贪心算法结果: ${verdict.algorithmTerms.map((d) => `1/${d}`).join(" + ")}`);
    return;
  }

  const db = openDatabase(getDbPath());

  if (args.command === "get") {
    const id = Number(args.positional[0]);
    const record = getRun(db, id);
    if (!record) throw new AppError("RUN_NOT_FOUND", `未找到算例 #${id}`);
    const steps = getSteps(db, id).map((s) => ({
      step: s.step,
      before: { num: BigInt(s.beforeNum), den: BigInt(s.beforeDen) },
      denominator: s.denominator,
      rawRemainder: { num: BigInt(s.rawNum), den: BigInt(s.rawDen) },
      reduceFactor: s.reduceFactor,
      after: { num: BigInt(s.afterNum), den: BigInt(s.afterDen) },
    }));
    printResult({
      originalInput: { numerator: record.rawNumerator, denominator: record.rawDenominator },
      normalized: { num: BigInt(record.normalizedNum), den: BigInt(record.normalizedDen) },
      budget: { maxTerms: record.maxTerms, maxDigits: record.maxDigits },
      algorithmVersion: record.algorithmVersion,
      status: record.status,
      steps,
      terms: JSON.parse(record.termsJson) as string[],
      remainder: { num: BigInt(record.remainderNum), den: BigInt(record.remainderDen) },
      identityVerified: record.identityVerified === 1,
      completedVerified: record.completedVerified === 1,
    }, id);
    return;
  }

  if (args.command === "steps") {
    const id = Number(args.positional[0]);
    if (!getRun(db, id)) throw new AppError("RUN_NOT_FOUND", `未找到算例 #${id}`);
    for (const s of getSteps(db, id)) {
      console.log(
        `步骤 ${s.step}: ${s.beforeNum}/${s.beforeDen} -> 1/${s.denominator}；` +
          `未约分 ${s.rawNum}/${s.rawDen}；因子 ${s.reduceFactor}；下一轮 ${s.afterNum}/${s.afterDen}`,
      );
    }
    return;
  }

  if (args.command === "list") {
    const runs = listRuns(db, 100);
    if (runs.length === 0) {
      console.log("（暂无已保存算例；decompose --save 可保存）");
      return;
    }
    for (const r of runs) {
      console.log(
        `#${r.id}  ${r.rawNumerator}/${r.rawDenominator} = ${r.normalizedNum}/${r.normalizedDen}  ` +
          `status=${r.status}  terms=${r.termsJson}  remainder=${r.remainderNum}/${r.remainderDen}  ${r.createdAt}`,
      );
    }
    return;
  }

  if (args.command === "export") {
    const id = Number(args.positional[0]);
    const record = getRun(db, id);
    if (!record) throw new AppError("RUN_NOT_FOUND", `未找到算例 #${id}`);
    const payload = JSON.stringify({ run: record, steps: getSteps(db, id) }, null, 2);
    const file = args.flags.get("file");
    if (file) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, payload, "utf8");
      console.log(`已导出到 ${file}`);
    } else {
      console.log(payload);
    }
    return;
  }

  console.log(HELP);
}

main().catch((err: unknown) => {
  if (err instanceof AppError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
  } else {
    console.error("错误:", err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
