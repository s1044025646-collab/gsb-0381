import {
  FractionError,
  type FractionString,
  gcd,
  normalize,
  parseNonNegativeInteger,
  sumUnitFractions,
} from "./fraction.js";

export type CandidateVerdict =
  | "greedy_match"
  | "valid_alternative"
  | "sum_mismatch"
  | "invalid_format";

export type CandidateVerification = {
  verdict: CandidateVerdict;
  valid: boolean;
  equalsGreedy: boolean;
  message: string;
  sum: FractionString | null;
  denominators: string[];
};

export function verifyCandidate(
  input: FractionString,
  candidate: unknown,
  greedyTerms: string[],
): CandidateVerification {
  const denominators = Array.isArray(candidate)
    ? candidate.map((value) => String(value).trim())
    : [];

  if (denominators.length === 0) {
    return {
      verdict: "invalid_format",
      valid: false,
      equalsGreedy: false,
      message: "候选必须是非空分母数组",
      sum: null,
      denominators,
    };
  }

  const parsed: bigint[] = [];
  let last = 0n;
  for (const item of denominators) {
    let denominator: bigint;
    try {
      denominator = parseNonNegativeInteger(item);
    } catch (error) {
      const code = error instanceof FractionError ? error.code : "";
      void code;
      return {
        verdict: "invalid_format",
        valid: false,
        equalsGreedy: false,
        message: `分母 ${item} 不是十进制正整数`,
        sum: null,
        denominators,
      };
    }
    if (denominator <= 0n) {
      return {
        verdict: "invalid_format",
        valid: false,
        equalsGreedy: false,
        message: `分母 ${item} 必须为正整数`,
        sum: null,
        denominators,
      };
    }
    if (denominator <= last) {
      return {
        verdict: "invalid_format",
        valid: false,
        equalsGreedy: false,
        message: "分母必须严格递增",
        sum: null,
        denominators,
      };
    }
    parsed.push(denominator);
    last = denominator;
  }

  const target = normalize(
    parseNonNegativeInteger(input.numerator),
    parseNonNegativeInteger(input.denominator),
  );
  const sum = sumUnitFractions(parsed);
  const equal = sum.p * target.q === target.p * sum.q;
  const sumString = { numerator: sum.p.toString(), denominator: sum.q.toString() };

  if (!equal) {
    return {
      verdict: "sum_mismatch",
      valid: false,
      equalsGreedy: false,
      message: "候选格式合法且严格递增，但精确求和不等于输入分数",
      sum: sumString,
      denominators,
    };
  }

  const equalsGreedy =
    denominators.length === greedyTerms.length &&
    denominators.every((denominator, index) => denominator === greedyTerms[index]);

  return {
    verdict: equalsGreedy ? "greedy_match" : "valid_alternative",
    valid: true,
    equalsGreedy,
    message: equalsGreedy
      ? "候选正确，并且与贪心算法结果一致"
      : "候选是另一种合法埃及分数表示，但不是本贪心算法结果",
    sum: sumString,
    denominators,
  };
}

export function reducedFraction(p: bigint, q: bigint): FractionString {
  const factor = gcd(p, q);
  return { numerator: (p / factor).toString(), denominator: (q / factor).toString() };
}
