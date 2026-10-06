# 埃及单位分数贪心分解与余数核验后端

使用 **TypeScript + Node.js（内置 `node:sqlite`）** 实现的本地后端，只提供 **HTTP API 与 CLI**（无前端、无 Docker、无 WSL、无外部在线服务）。

将严格小于 1 的正有理数 `p/q` 用**贪心算法（Fibonacci–Sylvester）**分解为分子恒为 1、分母严格递增的单位分数之和，并在每一步给出精确剩余分数。

> 算法版本：`greedy-bigint-v1`

## 明确范围与限制（务必阅读）

- **只处理正的真分数**：输入为十进制整数的分子、分文字符串，要求 `0 < numerator < denominator`。
- **拒绝**：零分子、零分母、负数、大于等于 1 的值、非十进制整数。输入先规范化约分。
- **不支持**整数部分（如 1+…）、负单位分数、任意符号/代数表达式。
- 贪心算法给出的是**一种确定**表示，**不保证单位分数项数最少，也不保证最大分母最小**。
- 全程使用 **BigInt 精确整数运算**：分母选择 `d = ceil(q/p)`、终止判断、约分、求和核验均不经过浮点数；十进制小数仅用于展示。
- 分母可能增长极快。可用 `maxTerms`（最大项数，默认 100）与 `maxDigits`（中间整数十进制位数统一上限，默认 1000）限制运行。
- 预算不足时返回**未完成**状态（`term_budget` / `digit_budget`）、已生成项与**精确剩余分数**，恒等式
  `原输入 = 已生成单位分数之和 + 精确余数` 仍然成立；部分列表**绝不会**被标记为完整分解。
- 若下一步会让任一中间整数（含候选分母 `d`、未约分余数分子分母）超过 `maxDigits`，则在**提交该步之前**停止，保留最后一个有效状态。
- 不提供自动断点续算；可用新预算创建独立运行并对照已有前缀。

## 算法（精确步骤）

对当前余数 `p/q`（已约分，`p > 0`）：

1. 选 `d = ceil(q/p) = (q + p - 1) / p`（纯 BigInt）。此时 `1/d ≤ p/q < 1/(d-1)`，即 `1/d` 是**不超过当前余数的最大单位分数**。
2. 计算未约分余数：`p/q - 1/d = (p·d - q) / (q·d)`。
3. 报告约分因子 `g = gcd(p·d - q, q·d)` 与约分后的下一轮余数。
4. 当余数分子为 0 时结束。

每步在代码内强制检查：余数非负且严格减小、分母严格递增、`1/d` 的贪心上下界成立。
完成后还会用**独立的单位分数求和**重新核对原值，不仅以余数对象自报为零作为证据。

手算核对案例：

- `4/13 = 1/4 + 1/18 + 1/468`
  - `4/13 − 1/4 = 3/52`；`3/52 − 1/18 = (54−52)/936 = 2/936 = 1/468`；`1/468 − 1/468 = 0`。
  - 独立求和：`(117 + 26 + 1)/468 = 144/468 = 4/13`。
- `2/3 = 1/2 + 1/6`。
- 项数预算为 1 时，`4/13` 仅得 `1/4`，状态 `term_budget`，余数 `3/52`。

## 环境要求

- Windows 本地 Node.js **≥ 22.5**（开发与验证环境为 Node v25.5.0 / npm 11.8.0）。使用内置 SQLite，无需编译原生模块。

## 安装与全部常用命令（PowerShell）

```powershell
cd E:\GSB\0381\B
npm install          # 安装 typescript / tsx / @types/node
npm run build        # 类型检查 + 编译到 dist/
npm test             # 运行 node:test 全部测试（引擎、持久化、HTTP API，共 20 个）
npm run demo         # 手算案例、预算对比、候选核验、持久化演示
npm start            # 启动编译后的 HTTP 服务（默认自动选择空闲端口）
npm run dev          # 用 tsx 直接运行 TypeScript 源码
```

指定端口：`$env:PORT="8080"; npm start`（不指定则由操作系统分配空闲端口，启动日志会打印实际端口）。

数据目录固定在项目内 `data/`，SQLite 文件默认 `data/egyptian.db`（CLI 可用环境变量 `EGYPTIAN_DB` 覆盖）。

## CLI

```powershell
# 分解（同时输出精确分数与状态；十进制近似仅展示）
npm run cli -- decompose 4 13
npm run cli -- decompose 4 13 --max-terms 1
npm run cli -- decompose 7 99999 --max-digits 100 --save   # --save 写入 SQLite

# 比较不同预算（每项 maxTerms:maxDigits，任一侧可省略）
npm run cli -- compare 4 13 --budgets "1:1000,10:1000,10:6"

# 核验用户提交的候选单位分数
npm run cli -- verify 4 13 --denominators "4,18,468"
npm run cli -- verify 2 15 --denominators "10,30"

# 读取与导出（重启后仍可逐行查看精确分数）
npm run cli -- list
npm run cli -- get 1
npm run cli -- steps 1
npm run cli -- export 1 --file data/run-1.json
```

候选核验结论（不会把另一种正确表示判错）：

- `valid_algorithm_match`：正整数、严格递增、精确求和等于目标，且与本贪心算法结果一致；
- `valid_alternative`：是另一种**合法且正确**的埃及分数表示，但不是本算法结果；
- `sum_mismatch`：格式合法、严格递增，但精确求和不等于目标；
- `invalid_format`：分母不是正整数、未严格递增或列表为空。

状态枚举：`completed`（完整分解）、`term_budget`（项数预算不足）、`digit_budget`（中间位数预算不足）。

## HTTP API

所有响应为 `{ ok: true, data }` 或 `{ ok: false, error: { code, message } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/runs` | 创建算例并执行分解，原子写入 SQLite |
| GET | `/api/runs` | 列出最近算例 |
| GET | `/api/runs/:id` | 读取算例完整结果（含全部步骤精确分数） |
| GET | `/api/runs/:id/steps?from=&to=` | 分页读取步骤 |
| POST | `/api/compare` | 同一输入在多组预算下的结果对比（不落库） |
| POST | `/api/verify` | 核验候选单位分数列表 |

`POST /api/runs` 请求体：

```json
{ "numerator": "4", "denominator": "13", "maxTerms": 100, "maxDigits": 1000 }
```

`POST /api/verify` 请求体：

```json
{ "numerator": "2", "denominator": "15", "denominators": ["10", "30"] }
```

curl 示例（PowerShell 下可用 `curl.exe`）：

```powershell
curl.exe -s -X POST http://127.0.0.1:<端口>/api/runs -H "content-type: application/json" -d '{\"numerator\":\"4\",\"denominator\":\"13\"}'
```

## 错误码

| code | 含义 |
| --- | --- |
| `INVALID_INTEGER` | 分子或分母不是十进制整数字符串 |
| `ZERO_DENOMINATOR` | 分母为零 |
| `ZERO_NUMERATOR` | 分子为零（只处理正真分数） |
| `NEGATIVE_VALUE` | 出现负数（不支持） |
| `NOT_PROPER_FRACTION` | 分子 ≥ 分母，不在处理范围 |
| `INVALID_BUDGET` | `maxTerms` / `maxDigits` 不是正整数 |
| `RUN_NOT_FOUND` | 算例不存在（HTTP 404） |
| `INVALID_CANDIDATE` / `VALIDATION_ERROR` | 请求体或候选结构非法 |
| `INTERNAL_ERROR` | 内部不变量/恒等式核验失败（HTTP 500） |

## 精确性与数据可靠性

- 选择、终止、求和全部为 BigInt 整数运算；`src/fraction.ts` 中的 `decimalApprox` 只用于展示。
- 每次报告在**单个 SQLite 事务**里原子发布 run 与全部 steps；预算非法等失败请求在算法层即抛错，**不写入、不覆盖旧报告**。
- 表结构记录原始输入、约分结果、预算（`max_terms`、`max_digits`）、算法版本、状态、已生成项与精确余数；重启后可逐行查看每一步的精确分数。

## 测试覆盖

- 手算等式核对：`4/13`、`2/3`、单位分数 `1/7`、可约分输入 `2/6 ≡ 1/3`；
- 大整数（40 位，远超安全整数范围）；
- 非法输入与非法预算；
- 项数预算为 1 的未完成状态与精确余数；
- 中间位数超限时在提交步骤前停止；
- 候选核验四分类（含另一种正确表示不判错）；
- 200 个可复现随机小真分数：逐项验证贪心上下界、分母严格递增、未约分/约分一致性与完整恒等式；
- SQLite 原子发布、失败不覆盖、重启后逐步骤读取；HTTP API 端到端。

## 项目结构

```
src/errors.ts    错误码与统一异常
src/fraction.ts  BigInt 分数：解析、约分、单位分数求和、展示用十进制近似
src/greedy.ts    贪心分解引擎、预算解析、候选核验
src/db.ts        node:sqlite 建表、事务原子发布、读取与序列化
src/server.ts    HTTP API（仅内置 http），默认空闲端口，PORT 可配置
src/cli.ts       命令行
scripts/demo.ts  演示
tests/           node:test 测试
data/            项目内 SQLite 数据目录
```
