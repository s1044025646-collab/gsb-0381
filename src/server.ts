import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FractionError,
  greedyDecompose,
  parseFraction,
  validateBudget,
  type FractionString,
} from "./fraction.js";
import { defaultDatabasePath, RunStore } from "./store.js";
import { verifyCandidate } from "./verify.js";

type HttpError = {
  status: number;
  code: string;
  message: string;
};

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return {};
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw {
      status: 400,
      code: "INVALID_JSON",
      message: "请求体必须是 JSON 对象",
    } satisfies HttpError;
  }
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw {
      status: 400,
      code: "INVALID_INTEGER",
      message: `${key} 必须是非空十进制整数字符串`,
    } satisfies HttpError;
  }
  return value;
}

function mapKnownError(error: unknown): HttpError {
  if (error && typeof error === "object" && "status" in error) {
    return error as HttpError;
  }
  if (error instanceof FractionError) {
    return {
      status: 400,
      code: error.code,
      message: error.message,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "未知错误",
  };
}

export function createApp(store: RunStore) {
  return async function app(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const pathParts = url.pathname.split("/").filter(Boolean);
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "egyptian-fraction-backend" });
        return;
      }

      if (method === "POST" && url.pathname === "/api/runs") {
        const body = await readJson(request);
        const input: FractionString = {
          numerator: requireString(body, "numerator"),
          denominator: requireString(body, "denominator"),
        };
        const budget = validateBudget(body.maxTerms ?? 50, body.maxDigits ?? 1000);
        parseFraction(input);
        const run = store.create(input, budget);
        sendJson(response, 201, run);
        return;
      }

      if (method === "GET" && url.pathname === "/api/runs") {
        sendJson(response, 200, { runs: store.list() });
        return;
      }

      const resource = pathParts[1];
      const resourceId = pathParts[2];
      const resourceAction = pathParts[3];
      if (pathParts[0] === "api" && resource === "runs" && resourceId && method === "GET" && !resourceAction) {
        const run = store.get(resourceId);
        if (!run) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        sendJson(response, 200, run);
        return;
      }

      if (
        pathParts[0] === "api" &&
        resource === "runs" &&
        resourceId &&
        resourceAction === "execute" &&
        method === "POST"
      ) {
        const run = store.get(resourceId);
        if (!run) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        if (run.result) {
          sendJson(response, 200, run);
          return;
        }
        const result = greedyDecompose(run.input, run.budget);
          sendJson(response, 200, store.publishResult(resourceId, result));
        return;
      }

      if (pathParts[0] === "api" && resource === "runs" && resourceId && resourceAction === "steps" && method === "GET") {
        const steps = store.getSteps(resourceId);
        if (steps === null) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        sendJson(response, 200, { runId: resourceId, steps });
        return;
      }

      if (pathParts[0] === "api" && resource === "runs" && resourceId && resourceAction === "verify" && method === "POST") {
        const run = store.get(resourceId);
        if (!run) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        if (!run.result) {
          sendError(response, {
            status: 409,
            code: "RUN_NOT_EXECUTED",
            message: "请先执行贪心分解，再核验候选",
          });
          return;
        }
        const body = await readJson(request);
        const verification = verifyCandidate(run.input, body.denominators, run.result.terms);
        sendJson(response, 200, store.saveVerification(resourceId, verification));
        return;
      }

      if (pathParts[0] === "api" && resource === "runs" && resourceId && resourceAction === "verifications" && method === "GET") {
        if (!store.get(resourceId)) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        sendJson(response, 200, { verifications: store.listVerifications(resourceId) });
        return;
      }

      if (pathParts[0] === "api" && resource === "runs" && resourceId && resourceAction === "export" && method === "GET") {
        const run = store.get(resourceId);
        if (!run) {
          sendError(response, { status: 404, code: "RUN_NOT_FOUND", message: "算例不存在" });
          return;
        }
        const steps = store.getSteps(resourceId)!;
        sendJson(response, 200, {
          run,
          steps,
          verifications: store.listVerifications(resourceId),
          exportedAt: new Date().toISOString(),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/runs/compare") {
        const body = await readJson(request);
        if (!Array.isArray(body.ids)) {
          sendError(response, { status: 400, code: "INVALID_IDS", message: "ids 必须是数组" });
          return;
        }
        const ids = body.ids.map((id) => String(id));
        sendJson(response, 200, { runs: store.compare(ids) });
        return;
      }

      sendError(response, { status: 404, code: "ROUTE_NOT_FOUND", message: "接口不存在" });
    } catch (error) {
      sendError(response, mapKnownError(error));
    }
  };
}

export async function startServer(options?: {
  port?: number | undefined;
  databasePath?: string | undefined;
}): Promise<{ server: Server; port: number; close: () => void }> {
  const databasePath = resolve(options?.databasePath ?? defaultDatabasePath());
  const store = new RunStore(databasePath);
  const server = createServer(createApp(store));
  await new Promise<void>((resolveListen) => {
    server.listen(options?.port ?? 0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("无法确定监听端口");
  }
  return {
    server,
    port: address.port,
    close: () => {
      server.close();
      store.close();
    },
  };
}

function readCliPort(): number | undefined {
  const args = process.argv.slice(2);
  const index = args.findIndex((arg) => arg === "--port");
  if (index === -1 || !args[index + 1]) {
    return undefined;
  }
  const port = Number(args[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port 必须是 0 到 65535 的整数");
  }
  return port;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedPort = process.env.EGYPTIAN_PORT
    ? Number(process.env.EGYPTIAN_PORT)
    : readCliPort();
  if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535)) {
    throw new Error("EGYPTIAN_PORT 必须是 0 到 65535 的整数");
  }
  const databasePath = process.env.EGYPTIAN_DB
    ? resolve(process.env.EGYPTIAN_DB)
    : resolve(defaultDatabasePath());
  const started = await startServer({ port: requestedPort, databasePath });
  console.log(`服务已启动: http://127.0.0.1:${started.port}`);
  console.log(`SQLite 数据文件: ${databasePath}`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => started.close());
  }
}

export const __testJoin = join;
