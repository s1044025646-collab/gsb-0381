import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decimalApproximation,
  parseFraction,
  validateBudget,
  type DecompositionResult,
  type FractionString,
} from "./fraction.js";
import { defaultDatabasePath, RunStore, type RunRecord } from "./store.js";
import { verifyCandidate } from "./verify.js";

function usage(): never {
  console.error(`用法:
  npm run cli -- run <numerator> <denominator> [--max-terms N] [--max-digits N]
  npm run cli -- create <numerator> <denominator> [--max-terms N] [--max-digits N]
  npm run cli -- execute <runId>
  npm run cli -- get <runId>
  npm run cli -- steps <runId>
  npm run cli -- compare <runId> <runId> [...]
  npm run cli -- verify <runId> <denominator> [denominator ...]
  npm run cli -- export <runId>`);
  process.exit(2);
}

function parseArgs(args: string[]) {
  const positional: string[] = [];
  let maxTerms = 50;
  let maxDigits = 1000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--max-terms" || arg === "--maxTerms") {
      maxTerms = Number(args[++index]);
    } else if (arg === "--max-digits" || arg === "--maxDigits") {
      maxDigits = Number(args[++index]);
    } else {
      positional.push(arg);
    }
  }
  return { positional, budget: { maxTerms, maxDigits } };
}

function printFraction(label: string, fraction: FractionString): void {
  console.log(
    `${label}: ${fraction.numerator}/${fraction.denominator} ≈ ${decimalApproximation(fraction)}（十进制仅展示）`,
  );
}

function printResult(result: DecompositionResult): void {
  printFraction("原始输入", result.input);
  printFraction("约分输入", result.normalizedInput);
  console.log(`状态: ${result.status}`);
  console.log(`算法版本: ${result.algorithmVersion}`);
  console.log(`预算: maxTerms=${result.budget.maxTerms}, maxDigits=${result.budget.maxDigits}`);
  console.log(`单位分数: ${result.terms.length === 0 ? "无" : result.terms.map((d) => `1/${d}`).join(" + ")}`);
  printFraction("精确余数", result.remainder);
  console.log(
    `独立求和核验: ${result.independentCheck.ok ? "通过" : "失败"} (${result.independentCheck.sum.numerator}/${result.independentCheck.sum.denominator})`,
  );
}

function printRun(run: RunRecord): void {
  if (run.result) {
    printResult(run.result);
    return;
  }
  printFraction("输入", run.input);
  console.log("状态: pending");
  console.log(`预算: maxTerms=${run.budget.maxTerms}, maxDigits=${run.budget.maxDigits}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) {
    usage();
  }
  const parsed = parseArgs(rest);
  const dbPath = resolve(process.env.EGYPTIAN_DB ?? defaultDatabasePath());
  const store = new RunStore(dbPath);

  try {
    if (command === "run" || command === "create") {
      const [numerator, denominator] = parsed.positional;
      if (!numerator || !denominator) {
        usage();
      }
      const input = { numerator, denominator };
      parseFraction(input);
      validateBudget(parsed.budget.maxTerms, parsed.budget.maxDigits);
      const run = store.create(
        input,
        parsed.budget,
      );
      if (command === "create") {
        console.log(JSON.stringify(run, null, 2));
        return;
      }
      const { greedyDecompose } = await import("./fraction.js");
      const completed = store.publishResult(
        run.id,
        greedyDecompose(run.input, run.budget),
      );
      printRun(completed);
      console.log(`runId: ${run.id}`);
      return;
    }

    const [id, ...values] = parsed.positional;
    if (!id) {
      usage();
    }

    if (command === "execute") {
      const run = store.get(id);
      if (!run) {
        throw new Error("RUN_NOT_FOUND");
      }
      const { greedyDecompose } = await import("./fraction.js");
      const completed = run.result
        ? run
        : store.publishResult(run.id, greedyDecompose(run.input, run.budget));
      printRun(completed);
      return;
    }

    if (command === "get") {
      const run = store.get(id);
      if (!run) {
        throw new Error("RUN_NOT_FOUND");
      }
      printRun(run);
      console.log(`runId: ${run.id}`);
      return;
    }

    if (command === "steps") {
      const steps = store.getSteps(id);
      if (steps === null) {
        throw new Error("RUN_NOT_FOUND");
      }
      for (const step of steps) {
        console.log(
          `#${step.sequence}: ${step.before.numerator}/${step.before.denominator} -> 1/${step.denominator}; ` +
            `未约分余数=${step.rawRemainder.numerator}/${step.rawRemainder.denominator}; ` +
            `约分因子=${step.reduceFactor}; ` +
            `下一余数=${step.after ? `${step.after.numerator}/${step.after.denominator}` : "无"}`,
        );
      }
      return;
    }

    if (command === "compare") {
      if (parsed.positional.length < 2) {
        usage();
      }
      for (const runId of parsed.positional) {
        const run = store.get(runId);
        if (!run) {
          console.log(`${runId}: NOT_FOUND`);
          continue;
        }
        console.log(
          `${run.id}: status=${run.status} terms=${run.result?.terms.length ?? 0} remainder=${run.result?.remainder.numerator ?? "?"}/${run.result?.remainder.denominator ?? "?"}`,
        );
      }
      return;
    }

    if (command === "verify") {
      const run = store.get(id);
      if (!run?.result) {
        throw new Error("RUN_NOT_FOUND_OR_NOT_EXECUTED");
      }
      const verification = store.saveVerification(
        id,
        verifyCandidate(run.input, values, run.result.terms),
      );
      console.log(`结论: ${verification.verdict}`);
      console.log(verification.message);
      if (verification.sum) {
        printFraction("候选求和", verification.sum);
      }
      return;
    }

    if (command === "export") {
      const run = store.get(id);
      if (!run) {
        throw new Error("RUN_NOT_FOUND");
      }
      console.log(
        JSON.stringify(
          {
            run,
            steps: store.getSteps(id),
            verifications: store.listVerifications(id),
            exportedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      return;
    }

    usage();
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

void fileURLToPath;
