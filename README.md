# 内部协同看板

移动端优先的现场工单协同中心，用于展会主场服务团队收集、合并、派发、跟进和闭环处理现场问题。

## 启动

```bash
npm install
npm run dev
```

访问 `http://localhost:3000`。

## 验证

```bash
npm run test:run
npm run build
```

生产部署前还需要执行数据库迁移：

```powershell
npm.cmd run db:migrate
```

## 当前功能

- 移动端底部导航：提交、工单、我的、管理。
- 成员提交工单：反馈人、展位号、问题类型、问题描述，问题类型默认“自动”。
- 工单列表：按问题类型分组，并按轻重缓急排序。
- 工单详情：显示状态、处理人、催单次数、反馈人数、优先级和时间线。
- 跟帖回复：成员可在工单详情页追加现场信息或处理回复。
- 重复问题处理：同一展位号的高相似问题按催单合并，中等相似度进入人工复核语义。
- 自动派单：优先按展位号和问题类型匹配责任人；无法匹配时保留待受理，便于管理员派单或处理组认领。
- 管理页：展示问题类型、催单允许时间、AI 接口配置，并支持上传展位主数据表。

## 主数据导入

管理页可上传 `.xlsx`、`.xls` 或 `.csv` 文件。第一张表至少包含：

- `展位号`
- `公司名称`
- `业务员`
- `搭建商`

可选列：

- `公司简称`

导入后，工单标题会按 `展位号 公司简称 问题类型` 自动生成。

## 工单状态流

```text
待受理 -> 处理中 -> 挂起 -> 已解决 -> 已关闭
```

挂起工单可以回到 `处理中`。

## AI 接口

系统内置两类 AI 接口配置：

- 快速AI：用于问题类型自动归类。
- 高智商AI：用于语义判重、超时分析和处理建议。

默认使用本地 mock provider，便于离线演示和开发验证。管理员可在管理页把 provider 切换为 `HTTP接口`，填写 OpenAI-compatible `endpoint`、`modelName`、`timeoutMs` 和密钥环境变量名（例如 `OPENAI_API_KEY`）。

密钥不在页面或 `data/app-state.json` 中保存，运行前请在服务端环境变量中设置。HTTP 接口异常、超时或未配置密钥时，系统会自动降级到本地 mock provider，避免现场提单中断。

## 数据存储

当前版本使用文件存储，运行时数据会写入：

```text
data/app-state.json
```

这是为了先快速跑通现场流程。后续接微信/企业微信、多端并发和正式生产时，建议替换为数据库或云端 KV/文档存储。

## 后续集成方向

- 接入 wxauto 桌面客户端：通过标准 MCP Streamable HTTP 把微信消息、出站租约和发送完成回执统一进入工单流。
- 接入真实向量检索/相似度服务：用于超时后的深度判重和人工复核建议。
- 增加管理员配置界面：维护问题类型、责任组、派单规则和 AI 模型参数。

## wxauto 桌面 MCP 接入

推荐的新接入方式是独立 wxauto 桌面 App 作为 MCP client 连接看板：

```text
https://<board-host>/api/mcp
```

生产环境至少配置：

```text
WXAUTO_MCP_TOKEN
WXAUTO_UPDATE_PUBLISH_TOKEN
WXAUTO_UPDATE_SIGNING_PRIVATE_KEY
WXAUTO_UPDATE_SIGNING_PUBLIC_KEY
```

桌面更新包保存在运行时持久目录 `data/wxauto-updates`，不要放进不可变构建产物。更新公钥 `WXAUTO_UPDATE_SIGNING_PUBLIC_KEY` 也必须嵌入桌面端构建，用于校验 Ed25519 manifest 签名。完整部署步骤见：[docs/wxauto-desktop-board-deployment.md](docs/wxauto-desktop-board-deployment.md)。

## wxauto REST 兼容桥试跑

- 已提供 REST 网关桥接脚本：`npm run bridge:wxauto`
- 详细步骤见：[docs/wxauto-rest-bridge-trial.md](docs/wxauto-rest-bridge-trial.md)
- 该方式仅保留为试跑和兼容旧部署使用；新桌面端请走标准 MCP `/api/mcp`。

完整值守模式会监听所有微信新消息，由系统过滤普通聊天；陌生用户发送现场诉求时会自动追问身份组、真实姓名、手机号，注册格式为：

```text
注册 搭建组 张三 13800138000
```

系统会自动注册并立即绑定微信身份，之后继续处理注册前的原始诉求；缺展位号或问题类型时会继续追问。出站通知通过 `/api/integrations/wechat/outbound` 由桥接脚本拉取，再调用 wxauto `/v1/wechat/send` 回发微信。
