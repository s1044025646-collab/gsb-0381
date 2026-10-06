export type FractionString = {
  numerator: string;
  denominator: string;
};

export type Fraction = {
  p: bigint;
  q: bigint;
};

export type StepReport = {
  sequence: number;
  before: FractionString;
  denominator: string;
  rawRemainder: FractionString;
  reduceFactor: string;
  after: FractionString | null;
};

export type DecompositionStatus =
  | "complete"
  | "incomplete_max_terms"
  | "incomplete_digit_limit";

export type Budget = {
  maxTerms: number;
  maxDigits: number;
};

export type DecompositionResult = {
  input: FractionString;
  normalizedInput: FractionString;
  algorithmVersion: "greedy-ceil-v1";
  status: DecompositionStatus;
  terms: string[];
  steps: StepReport[];
  remainder: FractionString;
  independentCheck:
    | {
        ok: true;
        sum: FractionString;
      }
    | {
        ok: false;
        sum: FractionString;
        error: string;
      };
  budget: Budget;
};

export class FractionError extends Error {
  constructor(
    public readonly code:
      | "INVALID_INTEGER"
      | "ZERO_DENOMINATOR"
      | "NON_POSITIVE"
      | "NOT_PROPER_FRACTION"
      | "INVALID_BUDGET",
    message: string,
  ) {
    super(message);
    this.name = "FractionError";
  }
}

const INTEGER_RE = /^[+-]?\d+$/;

export function parseNonNegativeInteger(value: string): bigint {
  if (typeof value !== "string" || !INTEGER_RE.test(value.trim())) {
    throw new FractionError("INVALID_INTEGER", "必须是十进制整数字符串");
  }
  return BigInt(value.trim());
}

export function parsePositiveInteger(value: string): bigint {
  const parsed = parseNonNegativeInteger(value);
  if (parsed <= 0n) {
    throw new FractionError("NON_POSITIVE", "必须为正整数");
  }
  return parsed;
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export function normalize(p: bigint, q: bigint): Fraction {
  if (q === 0n) {
    throw new FractionError("ZERO_DENOMINATOR", "分母不能为零");
  }
  if (p <= 0n || q <= 0n) {
    throw new FractionError("NON_POSITIVE", "只接受正的分子和分母");
  }
  if (p >= q) {
    throw new FractionError("NOT_PROPER_FRACTION", "只处理小于 1 的正真分数");
  }
  const factor = gcd(p, q);
  return { p: p / factor, q: q / factor };
}

export function parseFraction(input: FractionString): Fraction {
  const p = parseNonNegativeInteger(input.numerator);
  const q = parseNonNegativeInteger(input.denominator);
  return normalize(p, q);
}

export function fractionToString(value: Fraction): FractionString {
  return {
    numerator: value.p.toString(),
    denominator: value.q.toString(),
  };
}

export function validateBudget(maxTerms: unknown, maxDigits: unknown): Budget {
  const terms = Number(maxTerms);
  const digits = Number(maxDigits);
  if (
    !Number.isSafeInteger(terms) ||
    terms <= 0 ||
    !Number.isSafeInteger(digits) ||
    digits <= 0
  ) {
    throw new FractionError(
      "INVALID_BUDGET",
      "maxTerms 和 maxDigits 必须是正安全整数",
    );
  }
  return { maxTerms: terms, maxDigits: digits };
}

export function decimalDigits(value: bigint): number {
  return value.toString().length;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return 1n + ((a - 1n) / b);
}

function withinDigitBudget(values: bigint[], maxDigits: number): boolean {
  return values.every((value) => decimalDigits(value) <= maxDigits);
}

export function sumUnitFractions(terms: bigint[]): Fraction {
  if (terms.length === 0) {
    return { p: 0n, q: 1n };
  }
  let p = 1n;
  let q = terms[0]!;
  for (const denominator of terms.slice(1)) {
    const nextP = p * denominator + q;
    const nextQ = q * denominator;
    const factor = nextP === 0n ? nextQ : gcd(nextP, nextQ);
    p = nextP / factor;
    q = nextQ / factor;
  }
  return { p, q };
}

export function subtractFraction(left: Fraction, right: Fraction): Fraction {
  const p = left.p * right.q - right.p * left.q;
  const q = left.q * right.q;
  if (p < 0n) {
    throw new Error("内部错误：出现负余数");
  }
  if (p === 0n) {
    return { p: 0n, q: 1n };
  }
  const factor = gcd(p, q);
  return { p: p / factor, q: q / factor };
}

export function greedyDecompose(
  rawInput: FractionString,
  requestedBudget?: Partial<Budget>,
): DecompositionResult {
  const originalP = parseNonNegativeInteger(rawInput.numerator);
  const originalQ = parseNonNegativeInteger(rawInput.denominator);
  const start = normalize(originalP, originalQ);
  const budget = validateBudget(
    requestedBudget?.maxTerms ?? 50,
    requestedBudget?.maxDigits ?? 1000,
  );

  let current = start;
  let previousDenominator = 0n;
  const terms: bigint[] = [];
  const steps: StepReport[] = [];
  let status: DecompositionStatus;

  while (current.p !== 0n) {
    if (terms.length >= budget.maxTerms) {
      status = "incomplete_max_terms";
      break;
    }

    const d = ceilDiv(current.q, current.p);
    if (d <= previousDenominator) {
      throw new Error("内部错误：分母未严格递增");
    }

    const rawP = d * current.p - current.q;
    const rawQ = d * current.q;
    if (!withinDigitBudget([d, rawP, rawQ], budget.maxDigits)) {
      status = "incomplete_digit_limit";
      break;
    }
    if (rawP < 0n) {
      throw new Error("内部错误：余数为负");
    }

    let after: FractionString | null = null;
    let factor = 1n;
    let next: Fraction;
    if (rawP === 0n) {
      next = { p: 0n, q: 1n };
      after = fractionToString(next);
    } else {
      factor = gcd(rawP, rawQ);
      next = { p: rawP / factor, q: rawQ / factor };
      after = fractionToString(next);
    }

    if (next.p !== 0n && next.p * current.q >= current.p * next.q) {
      throw new Error("内部错误：余数未严格减小");
    }

    steps.push({
      sequence: steps.length + 1,
      before: fractionToString(current),
      denominator: d.toString(),
      rawRemainder: { numerator: rawP.toString(), denominator: rawQ.toString() },
      reduceFactor: factor.toString(),
      after,
    });
    terms.push(d);
    previousDenominator = d;
    current = next;
  }

  status = current.p === 0n ? "complete" : status!;
  const sum = sumUnitFractions(terms);
  const remainder = current;
  const identityLeft = sum.p * remainder.q + remainder.p * sum.q;
  const identityRight = start.p * (sum.q * remainder.q);
  const check =
    identityLeft * start.q === identityRight
      ? { ok: true as const, sum: fractionToString(sum) }
      : {
          ok: false as const,
          sum: fractionToString(sum),
          error: "已生成项求和不等于原输入",
        };

  if (!check.ok) {
    throw new Error(check.error);
  }
  if (remainder.p !== 0n) {
    const prefixPlusRemainder = subtractFraction(start, sum);
    if (
      prefixPlusRemainder.p * remainder.q !==
      remainder.p * prefixPlusRemainder.q
    ) {
      throw new Error("内部错误：部分和加余数恒等式不成立");
    }
  }

  return {
    input: {
      numerator: originalP.toString(),
      denominator: originalQ.toString(),
    },
    normalizedInput: fractionToString(start),
    algorithmVersion: "greedy-ceil-v1",
    status,
    terms: terms.map((term) => term.toString()),
    steps,
    remainder: fractionToString(remainder),
    independentCheck: check,
    budget,
  };
}

export function decimalApproximation(value: FractionString, digits = 12): string {
  const p = BigInt(value.numerator);
  const q = BigInt(value.denominator);
  const scale = 10n ** BigInt(digits);
  const whole = p / q;
  const fraction = ((p % q) * scale) / q;
  return `${whole}.${fraction.toString().padStart(digits, "0")}`;
}
