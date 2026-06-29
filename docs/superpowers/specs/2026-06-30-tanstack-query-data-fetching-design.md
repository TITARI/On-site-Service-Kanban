# TanStack Query v5 数据获取迁移设计

## 背景

当前前端在多个客户端组件中重复维护服务器数据的 `loading`、`error`、`data` 状态，并在 mutation 成功后手动调用刷新函数。`admin-users-panel.tsx` 还使用递增 request ID 防止旧请求覆盖新请求。这些实现缺少统一的请求取消、去重、缓存、失效刷新和错误语义。

代码审计确认，任务原始清单中的八个文件并非都拥有服务器请求：`ticket-list.tsx` 是纯展示组件，`exhibitor-dashboard.tsx` 只管理由 props 初始化的本地交互状态。机械迁移这两个文件会把本地 UI state 错误地放入服务器状态缓存，因此本任务只迁移六个真实请求组件。

## 目标

- 引入 `@tanstack/react-query` v5 管理浏览器端服务器状态。
- 用 Query 的请求取消和 query key 隔离替代递增 request ID。
- 为相同 query key 提供请求去重和短期内存缓存。
- 用 mutation 状态和精确 query invalidation 替代手写写入状态与刷新链路。
- 统一 HTTP 错误解析、401 会话失效和重试策略。
- 保持现有 API endpoint、请求 payload、用户可见行为和权限逻辑不变。

## 非目标

- 不迁移 `ticket-list.tsx` 或 `exhibitor-dashboard.tsx` 的本地 UI state。
- 不引入 React Query Devtools、SSR hydration、持久化缓存或离线 mutation。
- 不做乐观更新；工单状态机、权限和服务端 AI 决策必须以服务器响应为准。
- 不建立额外的业务 hooks/API repository 层。
- 不修改后端 API 合约。

## 架构

### Provider 边界

根 `src/app/layout.tsx` 继续作为 Server Component，并保留 `metadata` 导出。新增独立的客户端 `QueryProvider` 包裹 `children`，使用惰性 state 初始化确保每个浏览器应用实例只创建一个 `QueryClient`。这样不会为了 Provider 而把整棵根布局标记为 `"use client"`。

### QueryClient 配置

新增 `src/lib/client/query-client.ts`，生产配置为：

- query `staleTime: 0`；数据立即视为 stale，重新挂载时允许后台刷新。
- query 默认仅对网络错误和 5xx 重试一次。
- 401、403 和其他 4xx 不重试。
- `refetchOnWindowFocus: false`，保持现有页面聚焦行为。
- mutation `retry: 0`，防止重复写入。

HTTP 请求继续使用 `cache: "no-store"`，避免浏览器/Next HTTP 缓存改变现有语义。TanStack Query 的内存缓存与 `cache: "no-store"` 不冲突：已有数据可在后台刷新期间继续显示，并在默认垃圾回收时间后释放。

### Query keys

新增集中式 query key factory，覆盖以下资源：

- 管理员 session、后台 bootstrap、微信下单日志和 wxauto 状态。
- 用户列表（key 包含已应用筛选条件）和各平台聊天身份。
- 移动端 session、登录配置、移动 bootstrap 和单个工单详情。

所有 mutation 使用同一组 key 执行精确 invalidation，避免字符串 key 在父子组件间漂移。

### API 请求助手

新增轻量客户端请求助手：

- 保留 response HTTP status。
- 失败信息按 JSON `message`、JSON `error`、响应文本、调用方默认文案的顺序解析。
- 抛出 `ApiRequestError`，让 query retry predicate 和组件的 401 处理共享同一语义。
- 接收并透传 `AbortSignal`，使 TanStack Query 可以真正终止已过时的 fetch。

## 组件数据流

### `admin-shell.tsx`

- 管理员 session、后台 bootstrap 和日志分别使用 query。
- bootstrap 与日志在认证成功后并行执行，消除原来的串行等待。
- 登录、首个管理员初始化和退出使用 mutation。
- 登录或初始化成功后更新 session cache，再启用后台数据 query。
- 退出无论网络是否成功都清理管理员 session 与后台资源 cache，保持现有本地退出保证。
- 移除无结果处理的 wxauto 预热 fetch；wxauto 由 `admin-panel.tsx` 的条件 query 负责。

### `admin-users-panel.tsx`

- 用户列表 query key 包含规范化后的已应用筛选条件。
- query function 使用 TanStack 提供的 signal；快速切换筛选会取消旧请求，不再维护递增 request ID。
- 微信和企微身份使用各自的 query key，仅在打开现有用户编辑器时启用，与原有请求时机一致。
- 用户保存、启停、删除、密码修改以及身份绑定/解绑使用 mutation。
- 成功后失效用户列表、对应身份和后台 bootstrap；表单/弹窗状态仍为本地 state。

### `admin-panel.tsx`

- wxauto 状态仅在 `view="system"` 的系统配置页启用 query，与原有请求时机一致。
- 配置保存、主数据导入、关键词保存、wxauto 保存/令牌轮换和 AI 模型列表 POST 使用 mutation。
- AI 模型列表属于用户触发且使用 POST 的一次性服务器操作，使用 mutation 而不是自动 query。
- 成功后失效后台 bootstrap 或 wxauto key；状态队列、编辑草稿和导入预览继续由组件本地管理。

### `src/app/page.tsx`

- 移动 session、登录配置、移动 bootstrap 和当前工单详情分别使用 query。
- 登录配置只在未登录时启用；移动 bootstrap 只在已有用户时启用；详情只在选中有效工单时启用。
- tab、选中工单 ID 和导航状态仍为本地 state。
- 退出使用 mutation，并清理移动 session、bootstrap 和详情 cache，再启用登录配置 query。
- URL ticket code/id 的解析和页面导航行为保持不变。

### `ticket-detail.tsx`

- 工单 PATCH 与回复 POST 使用 mutation。
- `isPending` 驱动操作/回复按钮；服务端错误映射回现有用户提示。
- 成功后失效移动 bootstrap 和当前工单详情。
- 图片、表单、画廊和触摸交互仍为本地 state；只有成功后才重置表单和图片。

### `ticket-submit-form.tsx`

- 创建工单使用 mutation，`isPending` 替代手写 `isSubmitting`。
- 成功后失效移动 bootstrap，再执行现有 `onSubmitted` 导航回调。
- 失败时保留表单及图片；401 继续调用现有未授权回调。

## 错误、重试与加载状态

- 初次无数据加载使用 `isPending`。
- 已有数据的后台刷新使用 `isFetching`，不清空当前列表或页面。
- query 仅对无 HTTP status 的网络错误和 5xx 重试一次；4xx 不重试。
- mutation 不自动重试。
- 401 会清理对应会话和资源 cache，并进入现有未授权流程。
- query 取消由 TanStack Query 管理，取消的旧请求不显示为用户错误。
- 保留当前重试按钮和用户可见成功/失败文案，不增加全局 Error Boundary。

## 测试策略

### 基础设施测试

- 验证生产 QueryClient 的 staleTime、focus、query retry 和 mutation retry 配置。
- 验证 API 请求助手对 JSON message/error、文本和默认错误的解析顺序。
- 验证 `ApiRequestError.status` 与 AbortSignal 透传。
- 提供测试专用 QueryClient wrapper：关闭重试、每个测试独立 client、测试结束后清 cache。

### 组件回归测试

- `admin-users-panel`：快速筛选取消旧请求，最终只展示最新结果；mutation 成功后精确刷新。
- `admin-shell`：认证 gating、bootstrap/日志并行加载、登录/退出 cache 生命周期。
- `admin-panel`：wxauto 条件查询、配置类 mutation 的 pending/error/success 与 invalidation。
- 移动主页：登录配置/mobile bootstrap/detail query gating，401 清会话，刷新保留旧数据。
- `ticket-detail`：PATCH/回复成功失效列表和详情；失败不重置表单。
- `ticket-submit-form`：提交 pending、成功失效与导航、失败保留输入和图片。
- 验证同一 query key 的重复订阅只产生一次请求。

### 交付门禁

基线来自合并 PR #38 后的 `main`：

- 92 个测试文件、757 个测试通过。
- `npm run build` 成功。
- `npm audit` 为 3 个漏洞（2 moderate、1 high）。

完成后必须运行重点组件测试、全量测试、build 和 audit；测试不得回归，audit 漏洞数不得增加。

## 文件范围

预计新增：

- `src/components/query-provider.tsx`
- `src/lib/client/query-client.ts`
- `src/lib/client/query-keys.ts`
- `src/lib/client/api-request.ts`
- 对应基础设施测试与测试 QueryClient helper

预计修改：

- `package.json`
- `package-lock.json`
- `src/app/layout.tsx`
- `src/app/page.tsx`
- `src/components/admin-shell.tsx`
- `src/components/admin-users-panel.tsx`
- `src/components/admin-panel.tsx`
- `src/components/ticket-detail.tsx`
- `src/components/ticket-submit-form.tsx`
- 上述组件的现有测试

明确不修改：

- `src/components/ticket-list.tsx`
- `src/components/exhibitor-dashboard.tsx`

## 提交策略

遵循项目工作流：P1-03 的设计、计划、依赖、实现和测试组成一个 commit，并创建一个 PR。最终使用任务指定的中文 commit message。
