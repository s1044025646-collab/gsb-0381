import { AppError } from "./errors.js";

/** 不可变真分数（或过程分数），分子分母均为 BigInt，分母恒正。 */
export interface Fraction {
  readonly num: bigint;
  readonly den: bigint;
}

/** 解析十进制整数字符串；拒绝空串、符号之外的字符、前导符号非法等。 */
export function parseBigInt(raw: string, fieldName: string): bigint {
  if (typeof raw !== "string") {
    throw new AppError("INVALID_INTEGER", `${fieldName} 必须是十进制整数字符串`);
  }
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    throw new AppError("INVALID_INTEGER", `${fieldName} 不是合法的十进制整数: ${raw}`);
  }
  try {
    return BigInt(text);
  } catch {
    throw new AppError("INVALID_INTEGER", `${fieldName} 不是合法的十进制整数: ${raw}`);
  }
}

export function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export function reduce(num: bigint, den: bigint): { fraction: Fraction; factor: bigint } {
  if (den === 0n) {
    throw new AppError("ZERO_DENOMINATOR", "分母不能为零");
  }
  let n = num;
  let d = den;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { fraction: { num: 0n, den: 1n }, factor: d };
  const g = gcd(n, d);
  return { fraction: { num: n / g, den: d / g }, factor: g };
}

/**
 * 规范化输入：解析、校验范围（正的真分数，0 < p < q）、约分。
 * 保留原始输入由调用方负责。
 */
export function normalizeInput(rawNum: string, rawDen: string): {
  fraction: Fraction;
  factor: bigint;
} {
  const p = parseBigInt(rawNum, "numerator");
  const q = parseBigInt(rawDen, "denominator");
  if (q === 0n) throw new AppError("ZERO_DENOMINATOR", "分母不能为零");
  if (p === 0n) throw new AppError("ZERO_NUMERATOR", "分子不能为零（本服务只处理正真分数）");
  if (p < 0n || q < 0n) {
    throw new AppError("NEGATIVE_VALUE", "分子与分母都必须为正整数，不支持负数或带符号表达式");
  }
  if (p >= q) {
    throw new AppError("NOT_PROPER_FRACTION", "仅处理严格小于 1 的正真分数（需 0 < numerator < denominator）");
  }
  return reduce(p, q);
}

export function subUnit(rem: Fraction, d: bigint): { raw: Fraction; factor: bigint; reduced: Fraction } {
  // p/q - 1/d = (p*d - q) / (q*d)
  const rawNum = rem.num * d - rem.den;
  const rawDen = rem.den * d;
  const { fraction, factor } = reduce(rawNum, rawDen);
  return { raw: { num: rawNum, den: rawDen }, factor, reduced: fraction };
}
/** 精确求和 ∑ 1/d_i，返回约分分数。空列表约定为 0/1。 */
export function sumUnitFractions(denominators: bigint[]): Fraction {
  let num = 0n;
  let den = 1n;
  for (const d of denominators) {
    // num/den + 1/d
    num = num * d + den;
    den = den * d;
    const g = gcd(num, den);
    num /= g;
    den /= g;
  }
  return { num, den };
}

export function fractionsEqual(a: Fraction, b: Fraction): boolean {
  return a.num * b.den === b.num * a.den;
}

/** 大整数的十进制位数。 */
export function digitCount(x: bigint): number {
  if (x === 0n) return 1;
  const abs = x < 0n ? -x : x;
  return abs.toString().length;
}

export function fractionDigits(f: Fraction): number {
  return Math.max(digitCount(f.num), digitCount(f.den));
}

/**
 * 仅用于展示的十进制近似，绝不参与算法决策。
 * 返回保留 scale 位十进制的截断近似字符串。
 */
export function decimalApprox(f: Fraction, scale = 12): string {
  if (f.num === 0n) return "0";
  const negative = f.num < 0n;
  const n = negative ? -f.num : f.num;
  const scaled = n * 10n ** BigInt(scale + 2);
  let q = scaled / f.den;
  // 四舍五入到 scale 位
  const rounded = (q + 50n) / 100n;
  const intPart = rounded / 10n ** BigInt(scale);
  let fracPart = (rounded % 10n ** BigInt(scale)).toString();
  fracPart = fracPart.padStart(scale, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}
