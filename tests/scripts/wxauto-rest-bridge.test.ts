import { describe, expect, it, vi } from "vitest";

// @ts-expect-error Importing the local ESM bridge script is intentional for script helper tests.
const bridge = await import("../../scripts/wxauto-rest-bridge.mjs");

describe("wxauto rest bridge helpers", () => {
  it("ignores self and system messages to prevent outbound loops", () => {
    expect(bridge.mapToIntakePayload({
      id: "msg-self-1",
      sender: "Self",
      chat_name: "刘基鑫",
      content: "请补充身份组、真实姓名、手机号"
    }, {})).toBeNull();

    expect(bridge.mapToIntakePayload({
      id: "msg-system-1",
      sender: "SYS",
      chat_name: "刘基鑫",
      content: "系统提示"
    }, {})).toBeNull();
  });

  it("maps direct wxauto messages with stable sender id and no sender group", () => {
    expect(bridge.mapToIntakePayload({
      id: "msg-direct-1",
      sender: "刘基鑫",
      chat_name: "刘基鑫",
      content: "1AT201 电联不通",
      is_group: false
    }, {})).toMatchObject({
      channel: "wechat",
      externalMessageId: "msg-direct-1",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      senderGroup: undefined,
      sourceConversationId: "刘基鑫",
      text: "1AT201 电联不通"
    });
  });

  it("maps outbound messages to wxauto send payloads", () => {
    expect(bridge.mapOutboundToWxautoSend({
      id: "outbound-1",
      targetName: "现场群",
      text: "请补充展位号"
    })).toEqual({
      who: "现场群",
      msg: "请补充展位号",
      clear: true,
      exact: false
    });
  });

  it("sends outbound messages and marks them sent", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} })
      };
    });

    await bridge.sendOutboundMessage({
      message: { id: "outbound-1", targetName: "现场群", text: "已创建工单" },
      fetchImpl,
      config: {
        wxautoBaseUrl: "http://127.0.0.1:8001",
        wxautoToken: "token",
        intakeSecret: "secret",
        outboundUrl: "http://127.0.0.1:3000/api/integrations/wechat/outbound",
        requestTimeoutMs: 1000
      }
    });

    expect(calls[0].url).toBe("http://127.0.0.1:8001/v1/wechat/send");
    expect(JSON.parse(String(calls[0].options.body))).toMatchObject({ who: "现场群", msg: "已创建工单" });
    expect(calls[1].url).toBe("http://127.0.0.1:3000/api/integrations/wechat/outbound/outbound-1");
    expect(JSON.parse(String(calls[1].options.body))).toEqual({ status: "sent" });
  });

  it("marks outbound messages failed when wxauto send fails", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (url.includes("/v1/wechat/send")) {
        return {
          ok: false,
          status: 500,
          json: async () => ({ success: false, message: "窗口不存在" })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    });

    await expect(bridge.sendOutboundMessage({
      message: { id: "outbound-2", targetName: "现场群", text: "发送失败测试" },
      fetchImpl,
      config: {
        wxautoBaseUrl: "http://127.0.0.1:8001",
        wxautoToken: "token",
        intakeSecret: "secret",
        outboundUrl: "http://127.0.0.1:3000/api/integrations/wechat/outbound",
        requestTimeoutMs: 1000
      }
    })).rejects.toThrow("outbound send failed");

    expect(calls[1].url).toBe("http://127.0.0.1:3000/api/integrations/wechat/outbound/outbound-2");
    expect(JSON.parse(String(calls[1].options.body))).toEqual({ status: "failed", error: "窗口不存在" });
  });

  it("marks outbound messages failed when wxauto send request throws", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      if (url.includes("/v1/wechat/send")) throw new Error("request timeout");
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      };
    });

    await expect(bridge.sendOutboundMessage({
      message: { id: "outbound-throw", targetName: "客服组", text: "新工单" },
      fetchImpl,
      config: {
        wxautoBaseUrl: "http://127.0.0.1:8001",
        wxautoToken: "token",
        intakeSecret: "secret",
        outboundUrl: "http://127.0.0.1:3000/api/integrations/wechat/outbound",
        requestTimeoutMs: 1000
      }
    })).rejects.toThrow("outbound send failed");

    expect(calls[1].url).toBe("http://127.0.0.1:3000/api/integrations/wechat/outbound/outbound-throw");
    expect(JSON.parse(String(calls[1].options.body))).toEqual({ status: "failed", error: "request timeout" });
  });

  it("claims outbound messages from the app", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "outbound-1", targetName: "现场群", text: "请补充展位号" }] })
    }));

    const messages = await bridge.pullOutboundMessages(fetchImpl, {
      outboundUrl: "http://127.0.0.1:3000/api/integrations/wechat/outbound",
      intakeSecret: "secret"
    });

    expect(messages).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3000/api/integrations/wechat/outbound", expect.objectContaining({
      method: "POST"
    }));
  });
});
