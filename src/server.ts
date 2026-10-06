import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { AppError } from "./errors.js";
import { checkCandidate, decompose } from "./greedy.js";
import {
  getRun,
  getSteps,
  listRuns,
  openDatabase,
  publishResult,
  resultToSerializable,
  runToSerializable,
} from "./db.js";
import { decimalApprox } from "./fraction.js";

export interface ServerOptions {
  port?: number;
  dbPath?: string;
}

interface JsonEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

function sendJson(res: ServerResponse, status: number, body: JsonEnvelope<unknown>): void {
  const payload = JSON.stringify(body, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        rejectPromise(new AppError("VALIDATION_ERROR", "请求体过大（上限 1MB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        rejectPromise(new AppError("VALIDATION_ERROR", "请求体不是合法 JSON"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError("VALIDATION_ERROR", `${field} 必须是非空字符串（十进制整数）`);
  }
  return value;
}

export function createApp(opts: ServerOptions = {}): { server: Server; dbPath: string } {
  const dbPath = opts.dbPath ?? join(process.cwd(), "data", "egyptian.db");
  const db = openDatabase(resolve(dbPath));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, data: { status: "up" } });
        return;
      }

      // 创建算例并执行分解：POST /api/runs
      if (method === "POST" && path === "/api/runs") {
        const body = requireObject(await readJson(req));
        const numerator = requireString(body.numerator, "numerator");
        const denominator = requireString(body.denominator, "denominator");
        // 预算非法会抛出 INVALID_BUDGET，请求失败且不写入、不覆盖任何旧报告。
        const result = decompose({
          rawNumerator: numerator,
          rawDenominator: denominator,
          budget: {
            maxTerms: body.maxTerms as number | undefined,
            maxDigits: body.maxDigits as number | undefined,
          },
        });
        const id = publishResult(db, result);
        sendJson(res, 201, { ok: true, data: resultToSerializable(id, result) });
        return;
      }

      // 读取算例：GET /api/runs/:id
      const runMatch = /^\/api\/runs\/(\d+)$/.exec(path);
      if (method === "GET" && runMatch) {
        const id = Number(runMatch[1]);
        const record = getRun(db, id);
        if (!record) throw new AppError("RUN_NOT_FOUND", `未找到算例 #${id}`);
        const steps = getSteps(db, id);
        sendJson(res, 200, { ok: true, data: runToSerializable(record, steps) });
        return;
      }

      // 读取步骤（分页）：GET /api/runs/:id/steps?from=&to=
      const stepsMatch = /^\/api\/runs\/(\d+)\/steps$/.exec(path);
      if (method === "GET" && stepsMatch) {
        const id = Number(stepsMatch[1]);
        const record = getRun(db, id);
        if (!record) throw new AppError("RUN_NOT_FOUND", `未找到算例 #${id}`);
        const all = getSteps(db, id);
        const from = Number(url.searchParams.get("from") ?? "1");
        const toRaw = url.searchParams.get("to");
        const to = toRaw === null ? all.length : Number(toRaw);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
          throw new AppError("VALIDATION_ERROR", "分页参数非法：需要 1 <= from <= to");
        }
        sendJson(res, 200, {
          ok: true,
          data: {
            runId: id,
            totalSteps: all.length,
            steps: all.slice(from - 1, to).map((s) => ({
              step: s.step,
              before: `${s.beforeNum}/${s.beforeDen}`,
              denominator: s.denominator,
              rawRemainder: `${s.rawNum}/${s.rawDen}`,
              reduceFactor: s.reduceFactor,
              after: `${s.afterNum}/${s.afterDen}`,
              afterDecimalApprox: decimalApprox({ num: BigInt(s.afterNum), den: BigInt(s.afterDen) }),
            })),
          },
        });
        return;
      }

      // 列表：GET /api/runs
      if (method === "GET" && path === "/api/runs") {
        const runs = listRuns(db, 100);
        sendJson(res, 200, {
          ok: true,
          data: runs.map((r) => ({
            id: r.id,
            originalInput: { numerator: r.rawNumerator, denominator: r.rawDenominator },
            normalized: `${r.normalizedNum}/${r.normalizedDen}`,
            budget: { maxTerms: r.maxTerms, maxDigits: r.maxDigits },
            status: r.status,
            terms: JSON.parse(r.termsJson) as string[],
            remainder: `${r.remainderNum}/${r.remainderDen}`,
            identityVerified: r.identityVerified === 1,
            createdAt: r.createdAt,
          })),
        });
        return;
      }

      // 比较不同预算：POST /api/compare
      if (method === "POST" && path === "/api/compare") {
        const body = requireObject(await readJson(req));
        const numerator = requireString(body.numerator, "numerator");
        const denominator = requireString(body.denominator, "denominator");
        if (!Array.isArray(body.budgets) || body.budgets.length === 0) {
          throw new AppError("VALIDATION_ERROR", "budgets 必须是非空数组，元素形如 {maxTerms?, maxDigits?}");
        }
        const compared = body.budgets.map((b, index) => {
          if (typeof b !== "object" || b === null) {
            throw new AppError("VALIDATION_ERROR", `budgets[${index}] 必须是对象`);
          }
          const bo = b as Record<string, unknown>;
          const result = decompose({
            rawNumerator: numerator,
            rawDenominator: denominator,
            budget: { maxTerms: bo.maxTerms as number, maxDigits: bo.maxDigits as number },
          });
          return {
            budget: result.budget,
            status: result.status,
            termCount: result.terms.length,
            terms: result.terms,
            remainder: `${result.remainder.num.toString()}/${result.remainder.den.toString()}`,
            identityVerified: result.identityVerified,
          };
        });
        sendJson(res, 200, { ok: true, data: { numerator, denominator, results: compared } });
        return;
      }

      // 候选核验：POST /api/verify
      if (method === "POST" && path === "/api/verify") {
        const body = requireObject(await readJson(req));
        const numerator = requireString(body.numerator, "numerator");
        const denominator = requireString(body.denominator, "denominator");
        if (!Array.isArray(body.denominators)) {
          throw new AppError("INVALID_CANDIDATE", "denominators 必须是分母数组");
        }
        const verdict = checkCandidate(numerator, denominator, body.denominators as unknown[]);
        sendJson(res, 200, {
          ok: true,
          data: {
            verdict: verdict.verdict,
            message: verdict.message,
            normalizedTarget: `${verdict.normalizedTarget.num.toString()}/${verdict.normalizedTarget.den.toString()}`,
            candidateSum: verdict.candidateSum
              ? `${verdict.candidateSum.num.toString()}/${verdict.candidateSum.den.toString()}`
              : null,
            algorithmTerms: verdict.algorithmTerms,
          },
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `无此路由: ${method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === "RUN_NOT_FOUND"
            ? 404
            : err.code === "INTERNAL_ERROR"
              ? 500
              : 400;
        sendJson(res, status, { ok: false, error: { code: err.code, message: err.message, details: err.details } });
        return;
      }
      sendJson(res, 500, {
        ok: false,
        error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "未知错误" },
      });
    }
  });

  return { server, dbPath };
}

/** 请求系统分配一个空闲端口（传 0 由操作系统选择）。 */
export async function listenOnFreePort(server: Server, preferred?: number): Promise<number> {
  const port = preferred ?? 0;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address && typeof address === "object") return address.port;
  throw new AppError("INTERNAL_ERROR", "无法获取监听端口");
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (
  entry.endsWith(resolve("dist", "src", "server.js")) ||
  entry.endsWith(resolve("dist", "server.js")) ||
  entry.endsWith(resolve("src", "server.ts"))
) {
  const preferredPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const { server, dbPath } = createApp({ port: preferredPort });
  const port = await listenOnFreePort(server, preferredPort);
  console.log(`埃及分数后端已启动: http://127.0.0.1:${port}`);
  console.log(`数据文件: ${dbPath}`);
  console.log(`算法版本: greedy-bigint-v1（默认空闲端口；PORT 环境变量可指定端口）`);
}
