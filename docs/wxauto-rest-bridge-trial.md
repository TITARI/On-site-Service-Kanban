# wxauto 方案B试跑说明（REST网关桥接）

本文用于把 `wxauto-restful-api` 的消息转发到本项目的微信接入接口：

- 目标接口：`POST /api/integrations/wechat/messages`
- 本地默认地址：`http://127.0.0.1:3000/api/integrations/wechat/messages`

## 1. 前置条件

1. Windows 已登录微信客户端。
2. `wxautox4` Plus 已激活。
3. `wxauto-restful-api` 已启动（默认 `http://127.0.0.1:8001`）。
4. 本项目已启动（默认 `http://127.0.0.1:3000`）。
5. 在管理页启用 `微信 MCP` 或 `企业微信 MCP` 配置，并配置对应 `secretEnv`。
6. Redis 已启动，且看板服务与 bridge 使用同一个 `REDIS_URL`。

## 2. 启动桥接

在 PowerShell 里设置环境变量并运行：

```powershell
$env:WXAUTO_REST_BASE_URL = "http://127.0.0.1:8001"
$env:WXAUTO_REST_TOKEN = "token"
$env:WXAUTO_NAME = ""
$env:WXAUTO_FILTER_MUTE = "false"

$env:INTAKE_URL = "http://127.0.0.1:3000/api/integrations/wechat/messages"
$env:INTAKE_SECRET = "替换为你配置的MCP密钥"
$env:REDIS_URL = "redis://127.0.0.1:6379"

$env:BRIDGE_POLL_INTERVAL_MS = "1200"
$env:BRIDGE_REQUEST_TIMEOUT_MS = "10000"
$env:BRIDGE_DEDUPE_WINDOW_SIZE = "1000"
$env:BRIDGE_DRY_RUN = "false"

npm run bridge:wxauto
```

## 3. Dry-run（先不入库）

先不写入你项目，只看桥接解析结果：

```powershell
$env:BRIDGE_DRY_RUN = "true"
npm run bridge:wxauto
```

脚本会打印类似日志：

```text
[dry-run] {"channel":"wechat", ...}
```

## 4. 字段映射（桥接脚本内置）

- `channel`: 固定 `wechat`
- `externalMessageId`: 优先取消息原始 `id/msg_id/msgId/message_id`，否则用哈希指纹生成
- `senderName/senderId`: 从消息字段推断
- `senderGroup`: 会话名（聊天窗口名）
- `text`: 内容字段
- `imageUrls`: 图片路径或URL字段归一化为数组
- `receivedAt`: 消息时间，没有则用当前时间

## 5. 常见问题

1. `wxauto initialize failed`
   - 检查微信是否登录、`wxautox4` 是否激活、`WXAUTO_REST_TOKEN` 是否正确。
2. `intake push failed: HTTP 401`
   - `INTAKE_SECRET` 与你项目配置的 `secretEnv` 对应值不一致。
3. 持续无消息
   - 微信未收到新消息，或 `WXAUTO_FILTER_MUTE=true` 过滤了免打扰会话。
4. 重复消息
   - 脚本带内存去重窗口（默认1000条），进程重启后会重新接收历史未去重消息。

## 6. 完整值守模式

完整值守模式会同时执行：

1. 从 wxauto REST 拉取所有新微信消息。
2. 转发到 `/api/integrations/wechat/messages`，由系统侧过滤普通聊天。
3. 从 `/api/integrations/wechat/outbound` 将待发通知调度到 BullMQ。
4. BullMQ Worker 调用 wxauto `/v1/wechat/send` 回发微信，并自动重试临时失败。
5. 回调系统标记发送成功或失败。

新增环境变量：

```powershell
$env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
$env:REDIS_URL = "redis://127.0.0.1:6379"
$env:BRIDGE_OUTBOUND_POLL_INTERVAL_MS = "1500"
```

注册格式：

```text
注册 搭建组 张三 13800138000
```

陌生微信用户发送现场诉求时，系统会先追问身份组、真实姓名、手机号。注册成功后立即生效，并继续处理注册前的原始诉求；如果还缺展位号或问题类型，会继续追问缺失字段。
