import { AppError } from "./errors.js";
import {
  type Fraction,
  digitCount,
  fractionsEqual,
  fractionDigits,
  normalizeInput,
  subUnit,
  sumUnitFractions,
} from "./fraction.js";

export const ALGORITHM_VERSION = "greedy-bigint-v1";

/** 默认预算：最多 100 项；中间整数最多 1000 位十进制数字。 */
export const DEFAULT_MAX_TERMS = 100;
export const DEFAULT_MAX_DIGITS = 1000;

export interface Budget {
  maxTerms: number;
  maxDigits: number;
}

export interface StepReport {
  /** 从 1 开始的步骤序号。 */
  step: number;
  before: Fraction;
  /** 贪心选择分母 d = ceil(q/p)。 */
  denominator: string;
  /** 未约分余数 (p*d - q)/(q*d)。 */
  rawRemainder: Fraction;
  /** 约分因子 gcd。 */
  reduceFactor: string;
  /** 下一轮余数（约分后），最后一步完成时为 0/1。 */
  after: Fraction;
}

export type RunStatus = "completed" | "term_budget" | "digit_budget";

export interface DecomposeResult {
  originalInput: { numerator: string; denominator: string };
  normalized: Fraction;
  budget: Budget;
  algorithmVersion: string;
  status: RunStatus;
  steps: StepReport[];
  terms: string[];
  /** 最终精确余数（约分后）；completed 时为 0/1。 */
  remainder: Fraction;
  /** 独立求和核验：已生成项之和 + 余数 == 原输入。 */
  identityVerified: boolean;
  /** completed 时独立求和核验原输入 == ∑ 1/d_i。 */
  completedVerified: boolean;
}

export function parseBudget(rawMaxTerms: unknown, rawMaxDigits: unknown): Budget {
  const toPositiveInt = (value: unknown, field: string, fallback: number): number => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(n) || n <= 0) {
      throw new AppError("INVALID_BUDGET", `${field} 必须是正整数（十进制），收到: ${String(value)}`);
    }
    if (!Number.isSafeInteger(n)) {
      throw new AppError("INVALID_BUDGET", `${field} 超出安全整数范围`);
    }
    return n;
  };
  return {
    maxTerms: toPositiveInt(rawMaxTerms, "maxTerms", DEFAULT_MAX_TERMS),
    maxDigits: toPositiveInt(rawMaxDigits, "maxDigits", DEFAULT_MAX_DIGITS),
  };
}

/** d = ceil(q/p)，纯 BigInt 运算，不使用浮点。 */
function ceilDiv(q: bigint, p: bigint): bigint {
  return (q + p - 1n) / p;
}

export interface DecomposeOptions {
  rawNumerator: string;
  rawDenominator: string;
  budget?: Partial<Budget>;
}

export function decompose(opts: DecomposeOptions): DecomposeResult {
  const budget = parseBudget(opts.budget?.maxTerms, opts.budget?.maxDigits);
  const { fraction: normalized } = normalizeInput(opts.rawNumerator, opts.rawDenominator);

  const steps: StepReport[] = [];
  const terms: bigint[] = [];
  let rem: Fraction = normalized;
  let status: RunStatus = "term_budget";

  while (rem.num > 0n) {
    if (terms.length >= budget.maxTerms) {
      status = "term_budget";
      break;
    }
    const d = ceilDiv(rem.den, rem.num);

    // 提交该步前先预测中间整数位数，超预算则在提交前停止，保留最后一个有效状态。
    const predictedNum = rem.num * d - rem.den;
    const predictedDen = rem.den * d;
    if (
      digitCount(predictedNum) > budget.maxDigits ||
      digitCount(predictedDen) > budget.maxDigits ||
      digitCount(d) > budget.maxDigits
    ) {
      status = "digit_budget";
      break;
    }

    const { raw, factor, reduced } = subUnit(rem, d);

    // 每步不变量检查：
    // 1) 1/d 是不超过当前余数的最大单位分数：1/d <= p/q < 1/(d-1)（d>1）
    // 2) 余数非负且严格减小
    // 3) 分母严格递增
    if (raw.num < 0n) throw new AppError("INTERNAL_ERROR", "内部校验失败：余数为负");
    if (reduced.num !== 0n && rem.num * reduced.den <= reduced.num * rem.den) {
      throw new AppError("INTERNAL_ERROR", "内部校验失败：余数未严格减小");
    }
    if (terms.length > 0 && d <= terms[terms.length - 1]!) {
      throw new AppError("INTERNAL_ERROR", "内部校验失败：分母未严格递增");
    }
    // 1/d <= p/q 等价于 q <= p*d；若 p*d < q 则 1/d 反而大于当前余数
    if (rem.num * d < rem.den) {
      throw new AppError("INTERNAL_ERROR", "内部校验失败：1/d 超过当前余数");
    }
    if (d > 1n && rem.num * (d - 1n) >= rem.den) {
      throw new AppError("INTERNAL_ERROR", "内部校验失败：d 不是不超过余数的最大单位分数分母");
    }

    terms.push(d);
    steps.push({
      step: steps.length + 1,
      before: rem,
      denominator: d.toString(),
      rawRemainder: raw,
      reduceFactor: factor.toString(),
      after: reduced,
    });
    rem = reduced;
  }

  if (rem.num === 0n) status = "completed";

  // 独立核验（不使用 rem 的自报）：原值 == 已生成和 + 余数
  const sumSoFar = sumUnitFractions(terms);
  const lhsNum = sumSoFar.num * rem.den + rem.num * sumSoFar.den;
  const lhsDen = sumSoFar.den * rem.den;
  const identityVerified = lhsNum * normalized.den === normalized.num * lhsDen;
  if (!identityVerified) {
    throw new AppError("INTERNAL_ERROR", "内部校验失败：恒等式 original = sum(terms) + remainder 不成立");
  }

  let completedVerified = false;
  if (status === "completed") {
    completedVerified = fractionsEqual(sumUnitFractions(terms), normalized);
    if (!completedVerified) {
      throw new AppError("INTERNAL_ERROR", "内部校验失败：完成状态下独立求和不等于原值");
    }
  }

  return {
    originalInput: { numerator: opts.rawNumerator.trim(), denominator: opts.rawDenominator.trim() },
    normalized,
    budget,
    algorithmVersion: ALGORITHM_VERSION,
    status,
    steps,
    terms: terms.map((d) => d.toString()),
    remainder: rem,
    identityVerified,
    completedVerified,
  };
}

export type CandidateVerdict =
  | "valid_algorithm_match"
  | "valid_alternative"
  | "sum_mismatch"
  | "invalid_format";

export interface CandidateCheckResult {
  verdict: CandidateVerdict;
  normalizedTarget: Fraction;
  candidateSum: Fraction | null;
  algorithmTerms: string[];
  message: string;
}

/**
 * 核验用户提交的候选单位分数列表。
 * 区分：格式非法 / 精确求和不等 / 合法但非本算法结果 / 合法且与本算法一致。
 * 另一种正确的埃及分数表示判为 valid_alternative，不判错。
 */
export function checkCandidate(
  rawNumerator: string,
  rawDenominator: string,
  rawDenominators: unknown[],
): CandidateCheckResult {
  const { fraction: target } = normalizeInput(rawNumerator, rawDenominator);
  const algorithm = decompose({ rawNumerator, rawDenominator });

  if (!Array.isArray(rawDenominators) || rawDenominators.length === 0) {
    return verdict("invalid_format", target, null, algorithm.terms, "候选必须是非空的分母数组");
  }

  const denominators: bigint[] = [];
  for (const item of rawDenominators) {
    if (typeof item !== "string" && typeof item !== "number") {
      return verdict("invalid_format", target, null, algorithm.terms, "每个分母必须是十进制整数");
    }
    const text = String(item).trim();
    if (!/^\d+$/.test(text)) {
      return verdict("invalid_format", target, null, algorithm.terms, `分母必须是正整数，收到: ${String(item)}`);
    }
    let d: bigint;
    try {
      d = BigInt(text);
    } catch {
      return verdict("invalid_format", target, null, algorithm.terms, `分母无法解析: ${String(item)}`);
    }
    if (d <= 0n) {
      return verdict("invalid_format", target, null, algorithm.terms, "分母必须为正整数");
    }
    if (denominators.length > 0 && d <= denominators[denominators.length - 1]!) {
      return verdict("invalid_format", target, null, algorithm.terms, "分母必须严格递增");
    }
    denominators.push(d);
  }

  const sum = sumUnitFractions(denominators);
  if (!fractionsEqual(sum, target)) {
    return verdict(
      "sum_mismatch",
      target,
      sum,
      algorithm.terms,
      "格式合法且严格递增，但精确求和不等于目标分数",
    );
  }

  const candidateStrings = denominators.map((d) => d.toString());
  const matches =
    candidateStrings.length === algorithm.terms.length &&
    candidateStrings.every((d, i) => d === algorithm.terms[i]);
  return matches
    ? verdict("valid_algorithm_match", target, sum, algorithm.terms, "正确，且与本贪心算法结果一致")
    : verdict("valid_alternative", target, sum, algorithm.terms, "正确的埃及分数表示，但不是本贪心算法的结果（同样合法）");
}

function verdict(
  v: CandidateVerdict,
  target: Fraction,
  sum: Fraction | null,
  algorithmTerms: string[],
  message: string,
): CandidateCheckResult {
  return { verdict: v, normalizedTarget: target, candidateSum: sum, algorithmTerms, message };
}
