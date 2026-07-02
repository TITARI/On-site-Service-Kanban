# 主场看板 - 测试阶段文档与 Codex 测试提示词

> 适用阶段：MVP 功能与已知 Bug 修复基本完成，进入系统性测试阶段。
> 目标读者：负责测试的工程师，以及被指派执行测试的 Codex 代理。

---

## 1. 项目背景速览

主场看板是面向展会主场服务团队的现场工单协同系统。核心目标：把展会现场的报修、催单、处理进度、验收闭环和消息回执放进同一条工单流，减少微信群、电话和人工表格之间的反复确认。

技术栈：
- Next.js App Router + React 19 + TypeScript
- Vitest 4 + Testing Library + jsdom（测试）
- MariaDB（`mysql2`），本地开发回退到 JSON 文件（`data/app-state.json`）
- `xlsx` 导入导出、`zod` 入参校验、MCP SDK（内置 wxauto 服务）、BullMQ + ioredis（外发队列）

关键入口：
- 移动端 `/`：手机号登录、提交工单、查看/处理/验收工单
- 后台 `/admin`：工单看板、消息接入、AI 模型、展商主数据、用户与权限、系统配置
- 短链 `/t/[code]`：跳转到对应工单

---

## 2. 当前测试现状

- 测试目录：`tests/`，已有约 97 个测试文件。
- 运行命令：
  - `npm run test:run`（完整跑一次，CI 用）
  - `npm run test`（watch 模式，开发用）
- 覆盖分布：`tests/domain`、`tests/services`、`tests/api`、`tests/components`、`tests/app`、`tests/db`、`tests/repositories`、`tests/queue`、`tests/integrations`、`tests/lib`、`tests/scripts`、`tests/styles`。
- 测试风格约定（务必沿用）：
  - 使用 `describe/it/expect`，从 `vitest` 导入。
  - 服务层用内存 `state()` 工厂构造依赖，直接调用 `createXxxService(...)`。
  - API 路由测试用 `vi.hoisted` + `vi.mock("@/lib/repositories/app-repository")` 注入仓储桩，再 `await import` 路由的 `GET/POST` 等。
  - 组件测试用 `@testing-library/react` 的 `render/screen/within/waitFor` + `userEvent`。
  - 路径别名 `@` 指向 `src/`。

---

## 3. 测试目标与优先级

按业务风险从高到低：

1. 工单核心流程（domain/workflow + services/ticket-service）：创建、催单去重、状态流转、验收闭环、乐观锁。
2. 鉴权与权限（services/auth、session、access-control、API 授权）：移动端与后台会话隔离、RBAC、越权防护。
3. 消息接入与值守（message-intake、wechat-watchtower、wxauto 集成）：现场诉求识别、缺失身份追问、建单/催单。
4. 自动化能力（auto-acceptance、escalation、priority）：超时自动关闭、优先级与催办计算。
5. 主数据与导入（master-data、user-import、exhibitor-workbook-parser、字段映射）：Excel/CSV 解析、筛选分页、批量操作。
6. AI 分类与配置（ai-config、config-service、keyword-service）：自动分类、fallback、提示词预设、关键词规则。
7. 数据存储与迁移（db、repositories、dbmate checksum/cutover）：JSON/MariaDB 双存储一致性。

---

## 4. 测试类型与范围

- 单元测试（domain/services）：纯逻辑分支、边界值、错误路径。这是主战场，优先补齐。
- 集成/契约测试（api/integrations）：路由入参校验、鉴权、错误码、仓储调用契约。
- 组件测试（components/app）：渲染、交互、可访问性（按钮/标签/角色）、加载与错误态。
- 数据层测试（db/repositories）：状态读写、迁移校验脚本。
- 手动/端到端验证（不在 Vitest 内）：见第 7 节的手动冒烟清单。

---

## 5. 重点测试场景清单（用于查漏补缺）

### 5.1 工单流程
- 提交工单：展位号匹配主数据后生成标题（`展位号 简称 问题类型`）、默认状态「待受理」。
- 问题类型选「自动」时调用 AI 分类；AI 不可用时的 fallback 行为。
- 同展位相似问题按置信度自动催单 / 进入人工审核 / 新建工单三种分支。
- 状态流转白名单：待受理→处理中→挂起/已解决→已关闭；非法跳转被拒绝。
- 乐观锁：并发更新时版本冲突的处理。
- 已解决工单超过自动验收时效后自动关闭，并向反馈人和处理组发通知。
- 催单、处理进度、验收动作写入工单时间线。

### 5.2 鉴权与权限
- 移动端 HttpOnly 会话与后台会话相互隔离（session-kind）。
- RBAC：不同分组/权限对工单、用户管理、配置的可见与可操作范围。
- 越权访问返回 401/403，不泄露数据。
- 首次进入后台的管理员 bootstrap 流程与限流（rate-limiter、bootstrap-rate-limits）。
- 密码 argon2id 校验与透明 rehash。

### 5.3 消息接入与微信值守
- wxauto/微信值守识别现场诉求、追问缺失身份（展位/问题类型）。
- 企微/微信消息分析、建单、催单匹配与待确认记录。
- 外发消息队列（outbound）投递、重试、状态回执。
- MCP 路由入参校验与鉴权（wxauto-mcp）。

### 5.4 主数据与导入
- 展商/展位 Excel/CSV 解析、字段映射、异常行报告。
- 用户批量导入预览、提交、报告、行级校验。
- 展商数据筛选、分页、详情、批量操作、搭建成员分配。

### 5.5 AI 与配置
- AI 接口配置、提示词预设、Vercel AI SDK provider。
- 关键词规则集匹配、优先权重、派单分组。
- 自动验收时效、配置读写。

---

## 6. 给 Codex 的测试提示词

> 以下提示词可直接复制发给 Codex。按需选用「全面模式」或「聚焦模式」。

### 6.1 提示词 A：先跑基线，报告现状
```
请在当前仓库执行测试基线评估：
1. 运行 `npm run test:run`，完整跑一次全部 Vitest 测试。
2. 汇总结果：通过/失败/跳过数量，列出所有失败用例的文件、用例名和失败原因摘要。
3. 对失败用例判断是「测试本身过时」还是「代码真实缺陷」，分别标注。
4. 不要修改任何源码或测试，只输出一份现状报告和修复建议清单（按风险排序）。
```

### 6.2 提示词 B：查漏补缺（新增测试）
```
目标：为「主场看板」补齐测试覆盖，重点是工单流程、鉴权权限、消息值守。

要求：
1. 先阅读 docs/TEST-PLAN.md 第 5 节的场景清单，与现有 tests/ 目录逐项比对，列出「已覆盖 / 未覆盖 / 覆盖不足」的清单。
2. 针对未覆盖或不足的高优先级场景，新增测试文件，放在对应的 tests/ 子目录。
3. 严格沿用现有测试风格：
   - 从 `vitest` 导入 `describe/it/expect`（必要时 `vi`、`beforeEach`）。
   - 服务层用内存 state 工厂 + `createXxxService(...)`，不连真实数据库。
   - API 路由用 `vi.hoisted` + `vi.mock("@/lib/repositories/app-repository")` 注入桩，再 `await import` 路由。
   - 组件用 @testing-library/react + userEvent。
   - 路径别名 `@` 指向 src/。
4. 每写完一批就运行 `npm run test:run` 确认全绿，不要留下失败或跳过。
5. 不修改业务源码逻辑；若发现疑似 Bug，单独在最终报告里列出，不擅自「顺手改」。
6. 最终输出：新增了哪些测试文件、覆盖了哪些场景、发现的疑似缺陷清单。
```

### 6.3 提示词 C：聚焦单个模块
```
请聚焦测试 <模块名，例如 ticket-service / auth-service / message-intake-service>：
1. 阅读 src/lib/services/<模块>.ts 及其相关 domain 文件，梳理所有公开函数、分支和错误路径。
2. 检查 tests/ 下现有对应测试，列出已覆盖与未覆盖的分支。
3. 补充缺失的单元测试，覆盖：正常路径、边界值、错误/异常路径、并发或状态冲突（如适用）。
4. 运行 `npx vitest run tests/services/<模块>.test.ts` 确认通过。
5. 输出覆盖前后的对比说明。
```

### 6.4 提示词 D：回归验证（Bug 修复后）
```
本次修复了 <描述 Bug>。请执行回归验证：
1. 定位与该 Bug 相关的源码与测试文件。
2. 新增一个能复现原 Bug 的测试（应先失败于旧逻辑、通过于新逻辑），确认修复有效且防止回归。
3. 运行受影响模块的测试，再运行 `npm run test:run` 确认整体无回归。
4. 输出：新增/修改的测试、验证结论。
```

---

## 7. 手动冒烟测试清单（Vitest 之外）

在真实/本地环境跑一遍，验证端到端体验：

1. 启动：`npm run dev`，访问 `http://localhost:3000`。
2. 首次进后台 `/admin`，完成管理员 bootstrap（生产需 `ADMIN_BOOTSTRAP_PASSWORD`）。
3. 移动端手机号登录，提交一条带展位号的工单，确认标题与状态正确。
4. 后台看到新工单，走一遍受理→处理→解决→关闭流程，检查时间线。
5. 提交同展位相似工单，验证催单/去重行为。
6. 导入一份展商 Excel，检查解析、筛选、分页。
7. 批量导入用户，走预览→提交→报告流程。
8. 触发一次自动验收超时（可调配置时效），确认自动关闭与通知。
9. 短链 `/t/<code>` 跳转到对应工单。
10. 构建验证：`npm run build` 通过。

---

## 8. 环境与注意事项

- Node.js ≥ 22。首次准备：`npm ci`。
- 未配置 `DATABASE_URL` 时使用本地 JSON（`data/app-state.json`），适合测试与离线演示。
- 数据库迁移相关命令依赖 `db/migrations/checksums.json`，改动迁移文件需 `npm run db:migrate:seal`。
- 测试默认使用 jsdom 环境、内存桩，不应连接真实 MariaDB / Redis / 微信。
- 提交测试时保持全绿：不遗留 `.only`、`skip` 或失败用例。
