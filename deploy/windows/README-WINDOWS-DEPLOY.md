# Windows 一键部署说明

## 部署步骤

1. 将整个部署包解压到服务器目录，例如 `C:\apps\internal-collaboration-board`。
2. 右键 `install-and-start.cmd`，选择“以管理员身份运行”。
3. 脚本会自动注册开机自启任务、开放端口、防火墙放行，并启动网站。
4. 浏览器访问 `http://服务器IP:3000`。

## 环境要求

- Windows Server 2016 或更新版本。
- Node.js 22 LTS 或更新版本。
- 默认端口为 `3000`，可用下面方式改端口：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy-windows.ps1 -Port 8080
```

## 微信/企微 MCP 密钥

如果管理页里配置了 `WECHAT_MCP_SECRET` 或 `WECOM_MCP_SECRET`，请编辑 `app.env.ps1`，取消对应行注释并填入密钥。

外部 MCP 消息入口：

```text
POST http://服务器IP:3000/api/integrations/wechat/messages
```

常用消息字段：

```json
{
  "channel": "wecom",
  "msgId": "mcp-msg-1",
  "fromName": "企微机器人",
  "mobile": "13600136000",
  "content": "A01 网络断了，请尽快处理",
  "images": ["data:image/png;base64,..."]
}
```

## 运维命令

- 停止网站：运行 `stop-server.cmd`。
- 临时前台启动：运行 `start-now.cmd`。
- 查看日志：打开 `logs\web.log`。
- 数据文件：`data\app-state.json`，迁移或备份时保留这个目录。
