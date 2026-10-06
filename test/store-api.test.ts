import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunStore } from "../src/store.js";
import { createApp, startServer } from "../src/server.js";
import { createServer } from "node:http";

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "egyptian-"));
  const databasePath = join(directory, "test.sqlite");
  return {
    directory,
    store: new RunStore(databasePath),
    reopen: () => new RunStore(databasePath),
  };
}

test("SQLite 持久化输入、预算、算法版本和每一步精确分数", async () => {
  const fixture = await temporaryStore();
  try {
    const created = fixture.store.create(
      { numerator: "4", denominator: "13" },
      { maxTerms: 1, maxDigits: 100 },
    );
    const { greedyDecompose } = await import("../src/fraction.js");
    fixture.store.publishResult(created.id, greedyDecompose(created.input, created.budget));

    const reopened = fixture.reopen();
    const run = reopened.get(created.id);
    assert.ok(run?.result);
    assert.equal(run.algorithmVersion, "greedy-ceil-v1");
    assert.equal(run.status, "incomplete_max_terms");
    assert.deepEqual(run.result.remainder, { numerator: "3", denominator: "52" });
    assert.equal(reopened.getSteps(created.id)?.[0]?.denominator, "4");
    reopened.close();
  } finally {
    fixture.store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("失败执行不覆盖已有原子报告", async () => {
  const fixture = await temporaryStore();
  try {
    const run = fixture.store.create(
      { numerator: "2", denominator: "3" },
      { maxTerms: 10, maxDigits: 100 },
    );
    const { greedyDecompose } = await import("../src/fraction.js");
    fixture.store.publishResult(run.id, greedyDecompose(run.input, run.budget));
    const first = fixture.store.get(run.id)!;
    assert.equal(first.status, "complete");

    const tampered = greedyDecompose(
      { numerator: "4", denominator: "13" },
      { maxTerms: 1, maxDigits: 100 },
    );
    assert.throws(() => fixture.store.publishResult(run.id, tampered));
    assert.deepEqual(fixture.store.get(run.id)!.result, first.result);
  } finally {
    fixture.store.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("HTTP API 创建、执行、读取步骤、核验候选和导出", async () => {
  const started = await startServer({
    databasePath: join(
      await mkdtemp(join(tmpdir(), "egyptian-api-")),
      "api.sqlite",
    ),
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    const createResponse = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numerator: "2", denominator: "3", maxTerms: 10 }),
    });
    assert.equal(createResponse.status, 201);
    const created = (await createResponse.json()) as { id: string };

    const executeResponse = await fetch(`${base}/api/runs/${created.id}/execute`, {
      method: "POST",
    });
    assert.equal(executeResponse.status, 200);
    const executed = (await executeResponse.json()) as {
      result: { terms: string[]; status: string };
    };
    assert.deepEqual(executed.result.terms, ["2", "6"]);
    assert.equal(executed.result.status, "complete");

    const stepsResponse = await fetch(`${base}/api/runs/${created.id}/steps`);
    const stepsBody = (await stepsResponse.json()) as {
      steps: Array<{ rawRemainder: { numerator: string } }>;
    };
    assert.equal(stepsBody.steps[0]?.rawRemainder.numerator, "1");

    const verifyResponse = await fetch(`${base}/api/runs/${created.id}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ denominators: ["2", "7", "42"] }),
    });
    const verification = (await verifyResponse.json()) as { verdict: string };
    assert.equal(verification.verdict, "valid_alternative");

    const exportResponse = await fetch(`${base}/api/runs/${created.id}/export`);
    assert.equal(exportResponse.status, 200);
    assert.ok((await exportResponse.json()) != null);
  } finally {
    started.close();
  }
});

test("HTTP API 返回明确错误码", async () => {
  const server = createServer(
    createApp(
      new RunStore(
        join(await mkdtemp(join(tmpdir(), "egyptian-err-")), "err.sqlite"),
      ),
    ),
  );
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ numerator: "2", denominator: "2" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "NOT_PROPER_FRACTION");
  } finally {
    server.close();
  }
});
