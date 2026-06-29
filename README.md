# 主场看板

主场看板是一个面向展会主场服务团队的现场工单协同系统。项目用 Next.js、React 和 TypeScript 构建，覆盖移动端提报与处理、电脑端后台管理、展商主数据导入、用户与权限管理、微信/wxauto 消息值守、AI 分类判重和 MariaDB/JSON 双存储。

系统的核心目标是把展会现场的报修、催单、处理进度、验收闭环和消息回执放进同一条工单流里，减少微信群、电话和人工表格之间的反复确认。

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [快速启动](#快速启动)
- [运行脚本](#运行脚本)
- [环境变量](#环境变量)
- [登录与权限](#登录与权限)
- [核心业务流程](#核心业务流程)
- [数据导入](#数据导入)
- [AI 与关键词](#ai-与关键词)
- [微信与 wxauto 集成](#微信与-wxauto-集成)
- [API 速览](#api-速览)
- [数据存储与迁移](#数据存储与迁移)
- [测试与构建](#测试与构建)
- [Windows 部署](#windows-部署)
- [项目结构](#项目结构)

## 功能概览

### 移动端

- 入口：`/`
- 手机号、姓名、分组登录，服务端签发 HttpOnly 移动端会话。
- 提交现场工单，支持展位号、问题类型、描述和图片 URL。
- 问题类型可选择“自动”，系统会调用快速智能模型做分类。
- 工单列表按优先级展示，支持查看全部工单和“我的工单”。
- 工单详情展示状态、责任人、反馈人数、催单次数、优先级、回复和时间线。
- 处理组可认领、提交处理进度、挂起、标记已解决。
- 验收组可验收通过关闭工单，或退回到“待再次处理”。
- 回复、处理进度和验收动作都会写入工单时间线。
- 短链入口 `/t/[code]` 会跳转到 `/?ticketCode=...` 并打开对应工单。

### 电脑端后台

- 入口：`/admin`
- 后台工作台：查看开放工单、风险、消息接入、AI 模型、展商和人员概况。
- 微信下单日志：查看微信/企微消息分析、建单、催单匹配和待确认记录。
- 用户与权限：维护人员、账号、分组、启停状态、密码和微信/企微身份绑定。
- 工单设置：维护用户分组、权限、问题类型、优先权重和派单分组。
- 展览数据：导入并管理展商/展位主数据，支持筛选、分页、详情、批量操作和搭建成员分配。
- 系统配置：维护 AI 接口、AI 提示词预设、关键词规则、自动验收和 wxauto 桌面服务。

### 自动化能力

- 同展位相似问题会按置信度自动催单、进入人工复核或创建新工单。
- 工单优先级综合问题权重、风险词、催单次数、受理时长和催办级别计算。
- 已解决工单超过自动验收时效后可自动关闭，并向反馈人和处理组排队发送通知。
- 微信/wxauto 值守可自动识别现场诉求、追问缺失身份/展位/问题类型、创建工单或催单。
- 客服场景下，高阶智能模型可结合历史消息和候选工单判断是否自动加急。

## 技术栈

- Next.js App Router，React，TypeScript
- Vitest，Testing Library，jsdom
- MariaDB，通过 `mysql2` 访问
- 本地 JSON 文件存储，适合开发和离线演示
- `xlsx` 用于 Excel/CSV 导入与导出
- `zod` 用于 API 和 MCP 入参校验
- Model Context Protocol SDK，用于内置 wxauto 标准 MCP 服务
- `lucide-react` 图标

## 快速启动

建议使用 Node.js 22 LTS 或更新版本。

```bash
npm ci
npm run dev
```

访问：

```text
http://localhost:3000
```

后台入口：

```text
http://localhost:3000/admin
```

如果没有配置 `DATABASE_URL`，开发环境会使用本地 JSON 文件：

```text
data/app-state.json
```

首次进入后台时需要创建第一个管理员。生产环境必须先设置 `ADMIN_BOOTSTRAP_PASSWORD`；未设置时仅非生产环境会兼容旧口令 `admin123`，用于本地开发。

## 运行脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run dev:external` | 用 PowerShell 启动外部可访问开发服务，可配合 Cloudflare 临时隧道 |
| `npm run build` | 构建生产包，Next.js 配置为 standalone 输出 |
| `npm run start` | 启动 Next.js 生产服务 |
| `npm run start:external` | 启动 standalone 生产服务并暴露局域网/可选隧道 |
| `npm run restart:external` | 重启外部生产服务 |
| `npm run test` | 运行 Vitest 监听模式 |
| `npm run test:run` | 运行完整测试 |
| `npm run db:migrate` | 校验 checksum、转换旧版本记录并用 dbmate 执行 MariaDB 迁移 |
| `npm run db:migrate:new -- <name>` | 创建带 up/down 分段的新迁移 |
| `npm run db:migrate:seal` | 为全部迁移重新生成 SHA-256 清单 |
| `npm run db:migrate:verify` | 校验迁移名称、dbmate 指令和 SHA-256 清单 |
| `npm run db:migrate:status` | 查看 dbmate 迁移状态 |
| `npm run db:migrate:rollback` | 回滚最近一个实现了 down 分段的新迁移 |
| `npm run db:import-state` | 将 `data/app-state.json` 导入 MariaDB |
| `npm run bridge:wxauto` | 启动 wxauto REST 桥接进程 |

## 环境变量

### 应用服务

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `PORT` | 否 | 服务端口，默认 `3000` |
| `HOSTNAME` | 否 | 监听地址，外部访问通常设为 `0.0.0.0` |
| `APP_STORAGE` | 否 | `mariadb`/`database` 使用 MariaDB，`file`/`json` 使用本地 JSON |
| `DATABASE_URL` | 生产建议必填 | MariaDB 连接串，例如 `mysql://user:password@127.0.0.1:3306/collaboration_board` |
| `APP_ALLOW_JSON_FALLBACK` | 否 | 生产环境默认禁止 MariaDB 异常时自动 JSON 降级；确需临时降级时显式设为 `true` |
| `ADMIN_BOOTSTRAP_PASSWORD` | 生产必填 | 首个管理员初始化旧口令 |
| `APP_PUBLIC_BASE_URL` | 否 | 固定公网地址；微信工单回执短链会优先使用它 |

### AI 接口

后台可保存模型配置和密钥环境变量名，也可直接保存密钥。返回给前端时密钥会被脱敏。

| 变量 | 对应预设 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `OPENAI_API_KEY` | OpenAI |
| `DASHSCOPE_API_KEY` | 通义千问 |
| `MOONSHOT_API_KEY` | Kimi |
| `ZHIPU_API_KEY` | 智谱 GLM |
| `ARK_API_KEY` | 火山方舟 |

### wxauto / 微信桥接

| 变量 | 说明 |
| --- | --- |
| `WXAUTO_MCP_TOKEN` | 标准 MCP 服务访问令牌；未保存后台令牌时可作为服务端兜底 |
| `WECHAT_MCP_SECRET` | 旧版微信 REST 接入密钥，也作为 MCP 迁移期兼容兜底 |
| `WECOM_MCP_SECRET` | 企业微信 REST 接入密钥 |
| `WXAUTO_REST_BASE_URL` | wxauto REST 服务地址，默认 `http://127.0.0.1:8001` |
| `WXAUTO_REST_TOKEN` | wxauto REST 服务 Bearer Token |
| `WXAUTO_NAME` | 可选 wxauto 实例名称 |
| `WXAUTO_FILTER_MUTE` | 是否过滤免打扰会话，默认 `false` |
| `INTAKE_URL` | 入站消息接口，默认 `http://127.0.0.1:3000/api/integrations/wechat/messages` |
| `OUTBOUND_URL` | 出站消息领取接口，默认 `http://127.0.0.1:3000/api/integrations/wechat/outbound` |
| `INTAKE_SECRET` | 桥接脚本推送到看板时使用的密钥 |
| `BRIDGE_POLL_INTERVAL_MS` | 入站轮询间隔，默认 `1200` |
| `BRIDGE_OUTBOUND_POLL_INTERVAL_MS` | 出站轮询间隔，默认 `1500` |
| `BRIDGE_REQUEST_TIMEOUT_MS` | 桥接请求超时，默认 `10000` |
| `BRIDGE_DEDUPE_WINDOW_SIZE` | 桥接进程内去重窗口，默认 `1000` |
| `BRIDGE_DRY_RUN` | `true` 时只打印解析结果，不写入看板 |

Windows 部署包的环境变量模板在 `deploy/windows/app.env.sample.ps1`。

## 登录与权限

### 移动端账号

移动端登录提交姓名、手机号和分组。服务端会创建或更新人员账号，并发放 7 天有效的移动端会话。

手机号必须是 11 位中国大陆手机号。分组必须是后台启用状态。

### 后台管理员

首次后台访问会要求初始化首个管理员。初始化成功后入口关闭，后续通过手机号和密码登录。

后台会话有效期为 1 天。管理员密码连续 5 次失败会锁定 15 分钟，并返回统一的“手机号或密码不正确”提示。

### 权限模型

分组权限由后台“工单设置”维护，并同步到角色权限：

| 分组能力 | 权限码 | 作用 |
| --- | --- | --- |
| 可认领 | `ticket.claim` | 认领待处理工单 |
| 可处理 | `ticket.process` | 提交处理进度、挂起、标记已解决 |
| 可验收 | `ticket.accept` | 验收通过或退回 |
| 可管理 | `admin.access` | 访问后台管理接口 |

默认分组包含业务组、主场组、搭建组。后台可新增、停用、调整权限。

## 核心业务流程

### 工单状态流

```text
待受理 -> 处理中 -> 挂起 -> 处理中
处理中 -> 已解决 -> 已关闭
已解决 -> 待再次处理 -> 已解决
待再次处理 -> 挂起 -> 处理中
```

约束：

- 挂起必须填写原因。
- 处理进度必须填写处理内容并上传处理照片。
- 验收未通过必须填写原因，并退回到 `待再次处理`。
- 认领会写入处理人、处理组和受理时间。
- 处理到 `已解决`、验收到 `已关闭`、退回处理都会生成出站通知。

### 提单与判重

1. 根据展位号匹配展商主数据。
2. 问题类型为“自动”时，快速智能模型尝试分类。
3. 找出同展位未关闭工单。
4. 高阶智能模型做相似度判重。
5. 高置信相似问题按催单处理；中等置信度返回人工复核；否则创建新工单。
6. 根据展位号前缀和问题类型匹配派单规则，或使用问题类型的默认责任组。
7. 计算优先级并写入时间线。

### 优先级

优先级综合以下因素：

- 问题类型权重
- 描述中的风险词
- 催单次数
- 已受理后经过时间
- 催办级别

### 自动验收

后台“系统配置”可启用自动验收。默认启用，默认超时时效为 30 分钟，允许范围为 1 到 10080 分钟。

当工单处于 `已解决` 且超出时效，系统会自动改为 `已关闭`，写入时间线，并给反馈人和处理组排队出站通知。

## 数据导入

### 展商/展位主数据

后台入口：`/admin/exhibition-data`

支持两种请求形式：

- 上传 Excel/CSV 文件，字段由服务端解析。
- 直接提交 JSON 行数据，适合脚本或测试。

支持字段：

| 系统字段 | 常见表头 |
| --- | --- |
| 展位号 | `展位号`、`展位`、`boothNumber` |
| 公司名称 | `公司名称`、`企业名称`、`展商名称`、`companyName` |
| 公司简称 | `公司简称`、`companyShortName` |
| 业务员 | `业务员`、`销售人员`、`销售`、`salesOwner` |
| 搭建商 | `搭建商`、`搭建公司`、`builder` |
| 位置 | `位置`、`location`，也可由楼层和展馆合成 |
| 面积 | `面积`、`area` |
| 类型 | `类型`、`方案类型`、`展位类别`、`boothType` |

工作簿解析能力：

- 默认识别 `普通绿色搭建汇总`、`标展楣牌`、`标摊楣牌` 等工作表。
- 可在导入向导里选择工作表。
- 可先 inspect/dry-run 查看映射、可导入行和错误，不立即写库。
- 字段映射优先使用规则；规则无法可靠识别时调用高阶智能模型补充建议。
- 同一展位号和公司名称的多行会合并，重复字段以 ` / ` 拼接。

### 用户批量导入

后台入口：`/admin/users`

支持列：

- `姓名`
- `手机号`
- `分组`
- `分组锁定`
- `启用状态`
- `微信账号标识`
- `企微账号标识`

导入流程：

1. 预览文件，生成导入任务。
2. 检查手机号、分组、启用状态、文件内重复、既有用户和微信/企微身份占用。
3. 操作员为每行选择新增、覆盖或跳过。
4. 如涉及身份换绑，必须显式确认。
5. 提交前再次校验数据是否已变化，避免覆盖过期预览。
6. 可导出 Excel 导入报告。

## AI 与关键词

系统有两个模型位：

- 快速智能模型：用于问题类型自动分类。
- 高阶智能模型：用于相似工单判重、超时/客服加急研判、展商导入字段映射。

支持供应商预设：

- DeepSeek
- OpenAI
- 通义千问
- Kimi
- 智谱 GLM
- 自定义 OpenAI-compatible 接口

后台可维护 AI 提示词预设，内置场景包括：

- `classify`：问题类型分类
- `dedupe`：同展位相似判重
- `escalation`：超时升级建议
- `customer-service`：客服加急研判和回复
- `exhibitor-import`：展商导入字段映射

关键词配置优先于 AI 分类。系统会先用关键词判断消息是否是现场诉求，以及是否能映射到问题类型；未命中问题类型时才调用智能分类。

## 微信与 wxauto 集成

### 标准 wxauto MCP

后台入口：`/admin/system#admin-message`

启用后，桌面 App 使用以下入口：

```text
http://<看板地址>/api/mcp
```

认证方式：

- 首选后台保存的 wxauto 访问令牌。
- 未保存令牌时，服务端可读取 `WXAUTO_MCP_TOKEN`。
- 迁移期兼容 `WECHAT_MCP_SECRET`。

MCP 工具：

| 工具 | 作用 |
| --- | --- |
| `register_wxauto_agent` | 注册或刷新桌面代理状态 |
| `submit_wechat_events` | 批量提交入站微信事件 |
| `claim_outbound_messages` | 领取待发送出站消息 |
| `complete_outbound_message` | 标记出站消息已发送、失败或被安全策略阻止 |

### REST 桥接模式

如果使用 `wxauto-restful-api` 或本仓库的本地 shim，可运行：

```powershell
$env:WXAUTO_REST_BASE_URL = "http://127.0.0.1:8001"
$env:WXAUTO_REST_TOKEN = "replace-with-token"
$env:INTAKE_URL = "http://127.0.0.1:3000/api/integrations/wechat/messages"
$env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
$env:INTAKE_SECRET = "replace-with-secret"
npm run bridge:wxauto
```

本地 wxauto REST shim：

```bash
python scripts/wxauto-local-rest.py
```

详细步骤见 `docs/wxauto-rest-bridge-trial.md`。

### 值守逻辑

- 普通聊天会被忽略。
- 陌生用户发送现场诉求时，系统会追问身份组、姓名和手机号。
- 注册格式示例：

```text
注册 搭建组 张三 13800138000
```

- 注册后会立即绑定微信身份，并继续处理注册前的原始诉求。
- 缺展位号时追问展位号。
- 缺问题类型时提示可选类型。
- 能识别完整诉求时自动建单或关联已有工单催单。
- 客户对已有工单强烈催办时，系统可使用高阶智能模型自动加急并通知处理组和管理员。

## API 速览

### 页面路由

| 路由 | 说明 |
| --- | --- |
| `/` | 移动端工作台 |
| `/t/[code]` | 工单短链跳转 |
| `/admin` | 后台工作台 |
| `/admin/logs` | 微信下单日志 |
| `/admin/users` | 用户与权限 |
| `/admin/work-order-settings` | 工单设置 |
| `/admin/exhibition-data` | 展览数据 |
| `/admin/system` | 系统配置 |

### 业务 API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/bootstrap?scope=login` | 获取登录页配置 |
| `GET /api/bootstrap?scope=mobile` | 获取移动端工单摘要和配置 |
| `GET /api/bootstrap` | 获取后台完整初始化数据 |
| `POST /api/auth/mobile/login` | 移动端登录 |
| `POST /api/auth/mobile/logout` | 移动端退出 |
| `GET /api/auth/session?type=admin` | 检查后台会话 |
| `POST /api/admin/auth/bootstrap` | 初始化首个管理员 |
| `POST /api/admin/auth/login` | 后台登录 |
| `POST /api/admin/auth/logout` | 后台退出 |
| `GET /api/tickets` | 工单列表 |
| `POST /api/tickets` | 创建工单或触发相似催单 |
| `GET /api/tickets/[ticketId]` | 工单详情 |
| `PATCH /api/tickets/[ticketId]` | 状态流转、认领、处理、验收 |
| `POST /api/tickets/[ticketId]/replies` | 追加回复 |

### 后台 API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/admin/config` | 获取配置 |
| `PUT /api/admin/config` | 保存配置 |
| `POST /api/admin/master-data` | 导入或检查展商主数据 |
| `POST /api/admin/ai-models` | 拉取模型列表 |
| `GET /api/admin/keywords` | 获取关键词配置 |
| `PUT /api/admin/keywords` | 保存关键词配置 |
| `GET /api/admin/wxauto-mcp` | 初始化并读取 wxauto MCP 配置 |
| `PUT /api/admin/wxauto-mcp` | 保存 wxauto MCP 配置 |
| `GET /api/admin/wechat-order-logs` | 微信/企微消息处理日志 |
| `GET /api/admin/users` | 用户列表 |
| `POST /api/admin/users` | 新建用户 |
| `PATCH /api/admin/users/[userId]` | 更新用户 |
| `DELETE /api/admin/users/[userId]` | 删除用户 |
| `POST /api/admin/users/[userId]/enable` | 启用用户 |
| `POST /api/admin/users/[userId]/disable` | 停用用户 |
| `POST /api/admin/users/[userId]/password` | 设置用户密码 |
| `GET /api/admin/chat-identities` | 查询微信/企微身份 |
| `PUT /api/admin/users/[userId]/chat-identities/[platform]` | 绑定身份 |
| `DELETE /api/admin/users/[userId]/chat-identities/[platform]` | 解绑身份 |
| `POST /api/admin/user-imports/preview` | 预览用户导入 |
| `GET /api/admin/user-imports/[jobId]` | 获取用户导入行 |
| `GET /api/admin/user-imports/[jobId]/rows` | 获取用户导入行 |
| `PATCH /api/admin/user-imports/[jobId]/rows` | 保存行决策 |
| `POST /api/admin/user-imports/[jobId]/commit` | 提交用户导入 |
| `GET /api/admin/user-imports/[jobId]/report` | 导出导入报告 |

### 集成 API

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST/DELETE /api/mcp` | 标准 wxauto MCP Streamable HTTP 入口 |
| `POST /api/integrations/wechat/messages` | 微信/企微 REST 入站消息 |
| `POST /api/integrations/wechat/outbound` | REST 桥接领取出站消息 |
| `PATCH /api/integrations/wechat/outbound/[messageId]` | REST 桥接回写发送结果 |

## 数据存储与迁移

### 存储模式

| 场景 | 行为 |
| --- | --- |
| 设置 `APP_STORAGE=file` 或 `APP_STORAGE=json` | 使用 `data/app-state.json` |
| 设置 `APP_STORAGE=mariadb` 或 `APP_STORAGE=database` | 使用 MariaDB，必须配置 `DATABASE_URL` |
| 未设置 `APP_STORAGE` 且有 `DATABASE_URL` | 使用 MariaDB |
| 开发环境未配置 `DATABASE_URL` | 回退到 JSON 文件 |
| 生产环境未配置 `DATABASE_URL` | 启动失败 |

非生产环境下，部分 bootstrap 接口在 MariaDB 暂时不可用时会尝试 JSON fallback，让页面能给出降级提示。生产环境默认禁止自动 JSON 降级，避免 MariaDB 与本地 JSON 出现数据分裂；如确需临时应急降级，必须显式设置 `APP_ALLOW_JSON_FALLBACK=true` 并做好数据合并预案。

### MariaDB 初始化

项目使用官方 npm 版 `dbmate` 管理迁移。dbmate 直接读取 `DATABASE_URL`，不使用 `.dbmate` 配置文件。首次从旧迁移器切换时，`db:migrate` 会幂等地把已存在的旧版本名转换为时间戳版本；未知的历史记录会原样保留。

```bash
npm run db:migrate:verify
npm run db:migrate
npm run db:migrate:status
```

迁移文件：

```text
db/migrations/20260101000001_initial_schema.sql
db/migrations/20260101000002_keyword_rule_sets.sql
db/migrations/20260101000003_user_rbac_management.sql
db/migrations/20260101000004_exhibitor_booth_identity.sql
db/migrations/20260101000005_ticket_optimistic_lock.sql
db/migrations/20260101000006_bootstrap_rate_limits.sql
db/migrations/20260101000008_session_kind.sql
db/migrations/20260101000009_user_version_column.sql
```

创建新迁移后先完成 up/down SQL，再封存 checksum：

```bash
npm run db:migrate:new -- add_exhibitor_phone_column
# 编辑生成的 db/migrations/<timestamp>_add_exhibitor_phone_column.sql
npm run db:migrate:seal
npm run db:migrate
```

MariaDB DDL 会隐式提交，包含 DDL 的迁移应在 up/down 指令上使用 `transaction:false`。历史迁移保留原 SQL，但 down 分段会主动报错，防止只删除版本记录却没有撤销已隐式提交的 DDL。dbmate 本身只记录版本号，因此 `db/migrations/checksums.json` 必须与迁移文件一起提交，任何已封存文件被修改都会在连接数据库前失败。

从 JSON 状态导入 MariaDB：

```bash
npm run db:import-state
```

默认导入源：

```text
data/app-state.json
```

也可传入指定文件；npm 命令仍会先执行迁移：

```bash
npm run db:import-state -- data/app-state.json
```

## 测试与构建

运行测试：

```bash
npm run test:run
```

生产构建：

```bash
npm ci
npm run build
```

生产启动：

```bash
npm run start
```

当前测试覆盖主要分布在：

- `tests/domain`
- `tests/services`
- `tests/api`
- `tests/components`
- `tests/db`
- `tests/integrations`
- `tests/scripts`

## Windows 部署

构建 Windows standalone 部署包：

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows-package.ps1
```

部署包会包含：

- `.next/standalone`
- `.next/static`
- `data`
- `deploy/windows` 启停脚本
- `tools/wxauto-rest-bridge.mjs`
- 当前项目 README 副本

服务器部署：

1. 解压部署包。
2. 编辑 `app.env.ps1`，至少设置 `DATABASE_URL` 和 `ADMIN_BOOTSTRAP_PASSWORD`。
3. 以管理员身份运行 `install-and-start.cmd`。
4. 浏览器访问 `http://服务器IP:3000`。

更多说明见 `deploy/windows/README-WINDOWS-DEPLOY.md`。

本地外部访问辅助脚本：

```powershell
npm run dev:external
npm run start:external
npm run restart:external
```

默认会尝试局域网地址和 Cloudflare 临时隧道。只需要局域网访问时可直接调用：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-external.ps1 -NoTunnel
```

## 项目结构

```text
src/app
  页面路由和 API 路由
src/components
  移动端、后台、展商数据和导入 UI
src/lib/ai
  AI 路由、HTTP provider 和 mock provider
src/lib/api
  API 错误处理和后台鉴权
src/lib/client
  浏览器端会话和图片工具
src/lib/db
  MariaDB 连接、迁移、状态存储和存储模式解析
src/lib/domain
  工单、权限、主数据、关键词、优先级、导入等领域逻辑
src/lib/integrations/wxauto
  wxauto MCP 合约、鉴权、服务和配置同步
src/lib/repositories
  文件存储与 MariaDB 统一仓储接口
src/lib/services
  工单、认证、配置、微信值守、用户导入、自动验收等服务
src/lib/storage
  JSON 文件状态读写
tests
  单元测试、组件测试、API 测试、数据库测试和集成测试
scripts
  数据库迁移、状态导入、wxauto 桥接、部署打包脚本
deploy/windows
  Windows 一键部署、启动、停止和环境变量模板
docs
  设计规格、实施计划、预览图和 wxauto 试跑说明
db/migrations
  MariaDB SQL 迁移
```

## 参考文档

- `docs/wxauto-rest-bridge-trial.md`
- `deploy/windows/README-WINDOWS-DEPLOY.md`
- `docs/superpowers/specs`
- `docs/superpowers/plans`
