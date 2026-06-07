# wxauto 桌面端看板部署说明

本文用于部署“看板 MCP server + wxauto 桌面 App MCP client”的正式链路。旧 REST bridge 只作为试跑和兼容接口保留。

## 1. 必需环境变量

看板服务端必须配置：

```text
DATABASE_URL
WXAUTO_MCP_TOKEN
WXAUTO_UPDATE_PUBLISH_TOKEN
WXAUTO_UPDATE_SIGNING_PRIVATE_KEY
WXAUTO_UPDATE_SIGNING_PUBLIC_KEY
```

- `WXAUTO_MCP_TOKEN`：桌面端连接 `/api/mcp` 的 Bearer token。
- `WXAUTO_UPDATE_PUBLISH_TOKEN`：后台发布桌面安装包时填写的专用发布令牌。
- `WXAUTO_UPDATE_SIGNING_PRIVATE_KEY`：服务端签名 Ed25519 manifest 的 PKCS8 PEM。
- `WXAUTO_UPDATE_SIGNING_PUBLIC_KEY`：桌面端校验 manifest 的 SPKI PEM；同一个公钥必须嵌入桌面端构建。

生成签名密钥：

```powershell
npm.cmd run update:keys
```

## 2. 数据库迁移

每次部署前先运行迁移：

```powershell
npm.cmd run db:migrate
```

wxauto MCP 需要 `003_wxauto_mcp.sql` 和 `004_wxauto_state_lock.sql` 中的 agent、receipt、lease、release 和状态写锁表。未迁移时，桌面端注册、事件去重、出站租约和更新发布都会失败。

## 3. MCP 接入地址

桌面端连接：

```text
https://<board-host>/api/mcp
```

请求头：

```text
Authorization: Bearer <WXAUTO_MCP_TOKEN>
```

当前版本使用固定令牌鉴权；代码边界集中在 `src/lib/integrations/wxauto/auth.ts`，后续可升级到 OAuth 2.1 PKCE。

## 4. 更新包目录

桌面安装包不会写入 MariaDB，文件保存在运行时持久目录：

```text
data/wxauto-updates
```

部署时在服务所在机器上创建该目录，并确保运行用户可读写：

```powershell
New-Item -ItemType Directory -Force -Path .\data\wxauto-updates | Out-Null
```

该目录必须挂载到持久磁盘或备份路径，不要放在 `.next`、standalone 输出或其他不可变构建产物里。发布接口会写入安装包，公开下载接口会从该目录读取并校验路径不能逃逸。

## 5. 更新发布流程

1. 管理员进入 PC 后台的“系统配置”。
2. 在“wxauto 桌面更新”上传 `.exe` 安装包。
3. 填写语义版本号、发布通道、发布说明和 `WXAUTO_UPDATE_PUBLISH_TOKEN`。
4. 看板计算 SHA-256，生成 canonical manifest，并用 `WXAUTO_UPDATE_SIGNING_PRIVATE_KEY` 做 Ed25519 签名。
5. 桌面端通过 latest manifest 获取下载地址，并用内置 `WXAUTO_UPDATE_SIGNING_PUBLIC_KEY` 验签后再安装。

## 6. 兼容 REST bridge

旧 HTTP bridge 入口仍可用：

```text
POST /api/integrations/wechat/messages
POST /api/integrations/wechat/outbound
PATCH /api/integrations/wechat/outbound/<messageId>
```

它现在共享 durable receipt、lease 和 completion 语义，但仅用于旧现场试跑和回滚。正式桌面端不要继续依赖 REST bridge；请使用标准 MCP `/api/mcp`。

## 7. Windows 看板打包

打包前先完成：

```powershell
npm.cmd run test:run
npm.cmd run build
```

再运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-windows-package.ps1
```

打包产物会包含 `db/migrations`；如果仓库存在 `deploy/windows` 部署辅助文件，也会随包附带。更新包目录仍需在部署机运行时创建为持久目录，不应把历史安装包塞进 zip。

## 8. 手工 MCP smoke

生产环境变量配置完成后，用官方 MCP SDK 做一次冒烟：

1. 连接 `https://<board-host>/api/mcp`。
2. 调用 `register_wxauto_agent`。
3. 调用 `submit_wechat_events` 提交一条非现场诉求测试消息。
4. 调用 `claim_outbound_messages`，允许返回空数组。

预期：鉴权成功、协议初始化成功、重复消息不会二次处理，claim 返回稳定结构。
