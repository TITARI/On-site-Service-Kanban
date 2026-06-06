import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WxautoAgentPanel } from "@/components/admin/wxauto-agent-panel";

describe("WxautoAgentPanel", () => {
  it("shows agent, WeChat and last-seen health", () => {
    render(<WxautoAgentPanel agents={[{
      id: "device-a",
      displayName: "Front Desk PC",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"],
      lastSeenAt: "2026-06-05T08:00:00.000Z",
      createdAt: "2026-06-05T08:00:00.000Z",
      updatedAt: "2026-06-05T08:00:00.000Z"
    }]} />);

    expect(screen.getByText("Front Desk PC")).not.toBeNull();
    expect(screen.getByText("微信已登录")).not.toBeNull();
    expect(screen.getByText("严格安全模式")).not.toBeNull();
    expect(screen.getByText(/上次心跳/)).not.toBeNull();
  });

  it("shows an empty state when no desktop clients have connected", () => {
    render(<WxautoAgentPanel agents={[]} />);

    expect(screen.getByText("尚无桌面客户端连接。")).not.toBeNull();
  });
});
