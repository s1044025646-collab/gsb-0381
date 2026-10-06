# 埃及单位分数贪心分解后端（Windows / TypeScript / Node.js / SQLite）

本项目是一个只包含 API 与 CLI 的本地后端，用 BigInt 精确实现正真分数的埃及分数贪心分解、余数记录、预算截断、候选表示核验和 SQLite 持久化。

## 明确范围

- 只接受十进制整数形式的正分子和正分母，输入必须满足 `0 < p/q < 1`。
- 拒绝零、负数、零分母、大于等于一的分数、带整数部分的混合数、负单位分数和任意符号表达式。
- 输入先约分；`2/6` 与 `1/3` 会得到相同单位分数列表，同时保留原始输入。
- 算法固定为贪心算法：当前余数为 `p/q` 时选择 `d = ceil(q/p)`，输出 `1/d`。
- 所选 `1/d` 是不超过当前余数的最大单位分数，而不是任意可继续计算的单位分数。
- 贪心结果确定，但不保证单位分数数量最少，也不保证最大分母最小。
- 所有分母选择、余数和终止判断均使用 BigInt 整数运算；十进制小数只用于展示。

## 精确算法

当前余数为 `p/q`，选择：

```text
d = ceil(q/p)
p/q - 1/d = (d*p - q)/(d*q)
```

程序记录每一步：

- 本轮输入的精确分数；
- 所选分母 `d`；
- 未约分余数 `(d*p-q)/(d*q)`；
- 约分因子；
- 下一轮余数；
- 分母严格递增和余数非负、严格减小的内部检查。

完成或预算停止后，程序不用“余数对象为零”作为唯一完成证据，而是重新对已生成单位分数做整数交叉相乘求和。未完成时还检查：

```text
原输入 = 已生成单位分数之和 + 精确余数
```

## 预算与状态

可配置：

- `maxTerms`：最大项数，正整数，默认 `50`。
- `maxDigits`：中间整数十进制位数统一上限，正整数，默认 `1000`。

状态：

- `complete`：完整贪心分解。
- `incomplete_max_terms`：达到最大项数，结果不是完整分解。
- `incomplete_digit_limit`：下一步的分母、未约分分子或分母会超过位数预算；在提交该步骤前停止。

未完成状态会返回已生成项和精确余数，绝不能把部分列表标成完整分解。项目不做自动断点续算；可以用新预算创建独立运行，再对照已有前缀。

## 环境要求

- Windows 本地 PowerShell。
- Node.js 25（当前使用内置 `node:sqlite`）。
- npm。
- 不需要 Docker、WSL、付费服务或外部在线 API。

## 安装、构建、测试、启动

```powershell
npm install
npm run build
npm test
npm start
```

默认监听 `127.0.0.1` 上的空闲端口（端口 `0`）。启动后控制台会打印实际地址。

指定端口：

```powershell
npm start -- --port 5180
$env:EGYPTIAN_PORT="5180"; npm start
```

指定 SQLite 文件：

```powershell
$env:EGYPTIAN_DB="E:\GSB\0381\A\data\custom.sqlite"; npm start
```

默认数据目录和数据库在项目内：

```text
data/egyptian.sqlite
```

## CLI

先构建：

```powershell
npm run build
```

演示：

```powershell
npm run demo
```

直接运行：

```powershell
node dist/src/cli.js run 4 13
node dist/src/cli.js run 2 3
node dist/src/cli.js run 2 6
node dist/src/cli.js run 4 13 --max-terms 1
node dist/src/cli.js run 5 121 --max-digits 5
```

开发模式也可以使用：

```powershell
npm run cli -- run 4 13
```

持久化工作流：

```powershell
node dist/src/cli.js create 4 13
node dist/src/cli.js execute <runId>
node dist/src/cli.js get <runId>
node dist/src/cli.js steps <runId>
node dist/src/cli.js compare <runId1> <runId2>
node dist/src/cli.js verify <runId> 4 18 468
node dist/src/cli.js export <runId>
```

CLI 同时显示精确分数和状态，形如 `≈ 0.307...` 的十进制值仅用于阅读。

## HTTP API

### 健康检查

```http
GET /health
```

### 创建算例

```http
POST /api/runs
Content-Type: application/json

{
  "numerator": "4",
  "denominator": "13",
  "maxTerms": 50,
  "maxDigits": 1000
}
```

### 执行分解

```http
POST /api/runs/{id}/execute
```

该接口幂等：已有报告时返回旧结果；非法执行不会覆盖旧报告。结果和全部步骤在 SQLite 事务中原子发布。

### 读取算例和步骤

```http
GET /api/runs
GET /api/runs/{id}
GET /api/runs/{id}/steps
```

### 比较不同预算

先创建不同 `maxTerms` 或 `maxDigits` 的算例，再执行：

```http
POST /api/runs/compare
Content-Type: application/json

{ "ids": ["run-id-1", "run-id-2"] }
```

### 核验用户候选

```http
POST /api/runs/{id}/verify
Content-Type: application/json

{ "denominators": ["4", "18", "468"] }
```

结论：

- `greedy_match`：合法、求和相等，并且与本贪心算法结果一致。
- `valid_alternative`：合法且求和相等，但不是本贪心算法结果；不会把另一种正确表示判错。
- `sum_mismatch`：分母为正整数且严格递增，但精确求和不等于输入。
- `invalid_format`：不是非空数组、分母不是正整数，或分母不严格递增。

### 历史核验与导出

```http
GET /api/runs/{id}/verifications
GET /api/runs/{id}/export
```

## 错误码

- `INVALID_JSON`：请求体不是 JSON 对象。
- `INVALID_INTEGER`：不是十进制整数字符串。
- `ZERO_DENOMINATOR`：分母为零。
- `NON_POSITIVE`：分子或分母非正。
- `NOT_PROPER_FRACTION`：分数不小于一。
- `INVALID_BUDGET`：预算不是正安全整数。
- `RUN_NOT_FOUND`：算例不存在。
- `RUN_NOT_EXECUTED`：候选核验前尚未执行分解。
- `INVALID_IDS`：比较请求的 `ids` 不是数组。
- `ROUTE_NOT_FOUND`：接口不存在。
- `INTERNAL_ERROR`：服务端内部错误。

## 手算案例

```text
4/13
  d=4:  4/13 - 1/4 = 3/52
  d=18: 3/52 - 1/18 = (54-52)/936 = 2/936 = 1/468
  d=468: 1/468 - 1/468 = 0

所以 4/13 = 1/4 + 1/18 + 1/468

2/3 = 1/2 + 1/6
```

当 `maxTerms=1`：

```text
4/13 = 1/4 + 3/52
```

此时状态必须是 `incomplete_max_terms`，而不是完整分解。

## 测试内容

```powershell
npm test
```

测试覆盖：

- `4/13` 与 `2/3` 手算案例；
- 本身就是单位分数；
- 可约分输入；
- 大整数；
- 非法预算和非法分数；
- 项数预算与中间位数预算；
- 不同但合法的单位分数表示；
- 候选格式非法和求和不等；
- 100 个随机小真分数的贪心上下界、分母严格递增和完整恒等式；
- SQLite 重启后的精确步骤读取；
- HTTP API 全流程。

## 限制

- 本项目只做后端，不提供网页界面。
- Node.js 的 BigInt 和 JSON 字段可保存很大的十进制字符串，但实际受运行进程内存和 `maxDigits` 预算限制。
- 贪心算法的大分母可能快速增长；位数预算是保护机制，不承诺在预算内完成。
- 未完成运行不自动续算。
- 数据库为单机本地 SQLite，不包含多用户权限、认证或网络访问控制；服务只绑定 `127.0.0.1`。

