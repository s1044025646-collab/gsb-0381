import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, listenOnFreePort } from "../src/server.js";
import type { Server } from "node:http";

const dbPath = join(tmpdir(), `egyptian-api-${process.pid}-${Date.now()}.db`);
const { server } = createApp({ dbPath });
const port = await listenOnFreePort(server);
after(() => server.close());

const base = `http://127.0.0.1:${port}`;

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("POST /api/runs 创建并分解 4/13", async () => {
  const { status, json } = await post("/api/runs", { numerator: "4", denominator: "13" });
  assert.equal(status, 201);
  assert.equal(json.ok, true);
  assert.deepEqual(json.data.terms, ["4", "18", "468"]);
  assert.equal(json.data.status, "completed");
  assert.equal(json.data.identityVerified, true);
});

test("2/6 与 1/3 约分后结果一致", async () => {
  const a = await post("/api/runs", { numerator: "2", denominator: "6" });
  const b = await post("/api/runs", { numerator: "1", denominator: "3" });
  assert.deepEqual(a.json.data.terms, b.json.data.terms);
  assert.equal(a.json.data.normalized.num, "1");
});

test("非法预算返回 400 且不产生新记录", async () => {
  const listBefore = await (await fetch(base + "/api/runs")).json();
  const { status, json } = await post("/api/runs", { numerator: "4", denominator: "13", maxTerms: -1 });
  assert.equal(status, 400);
  assert.equal(json.error.code, "INVALID_BUDGET");
  const listAfter = await (await fetch(base + "/api/runs")).json();
  assert.equal(listAfter.data.length, listBefore.data.length);
});

test("非法分数返回对应错误码", async () => {
  const cases: Array<[unknown, string]> = [
    [{ numerator: "0", denominator: "3" }, "ZERO_NUMERATOR"],
    [{ numerator: "1", denominator: "0" }, "ZERO_DENOMINATOR"],
    [{ numerator: "-1", denominator: "3" }, "NEGATIVE_VALUE"],
    [{ numerator: "3", denominator: "2" }, "NOT_PROPER_FRACTION"],
  ];
  for (const [body, code] of cases) {
    const { status, json } = await post("/api/runs", body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error.code, code);
  }
});

test("预算 1 返回未完成与精确余数；步骤可分页读取；重启数据可读", async () => {
  const created = await post("/api/runs", { numerator: "4", denominator: "13", maxTerms: 1 });
  assert.equal(created.json.data.status, "term_budget");
  assert.deepEqual(created.json.data.terms, ["4"]);
  assert.equal(created.json.data.remainder.num, "3");
  assert.equal(created.json.data.remainder.den, "52");
  const id = created.json.data.id;

  const steps = await (await fetch(`${base}/api/runs/${id}/steps`)).json();
  assert.equal(steps.data.totalSteps, 1);
  assert.equal(steps.data.steps[0].after, "3/52");

  const notFound = await fetch(`${base}/api/runs/99999`);
  assert.equal(notFound.status, 404);
});

test("compare 与 verify 端点", async () => {
  const cmp = await post("/api/compare", {
    numerator: "4",
    denominator: "13",
    budgets: [{ maxTerms: 1 }, { maxTerms: 10 }],
  });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.json.data.results[0].status, "term_budget");
  assert.equal(cmp.json.data.results[1].status, "completed");

  const alt = await post("/api/verify", { numerator: "2", denominator: "15", denominators: ["10", "30"] });
  assert.equal(alt.json.data.verdict, "valid_alternative");
  const bad = await post("/api/verify", { numerator: "4", denominator: "13", denominators: ["4", "4"] });
  assert.equal(bad.json.data.verdict, "invalid_format");
});

test("health", async () => {
  const res = await fetch(base + "/health");
  assert.equal(res.status, 200);
});
