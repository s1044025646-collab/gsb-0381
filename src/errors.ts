/** 统一错误码，API 与 CLI 共用。 */
export type ErrorCode =
  | "INVALID_INTEGER"
  | "ZERO_DENOMINATOR"
  | "ZERO_NUMERATOR"
  | "NEGATIVE_VALUE"
  | "NOT_PROPER_FRACTION"
  | "INVALID_BUDGET"
  | "DIGIT_BUDGET_EXCEEDED"
  | "RUN_NOT_FOUND"
  | "INVALID_CANDIDATE"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
