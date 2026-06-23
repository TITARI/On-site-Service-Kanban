import { afterEach, describe, expect, it } from "vitest";
import { isWechatRequestAuthorized } from "@/lib/integrations/wechat/auth";

describe("isWechatRequestAuthorized", () => {
  afterEach(() => {
    delete process.env.TEST_SECRET;
  });

  it("secretEnv 未定义时拒绝", () => {
    const req = new Request("https://x.test/api/integrations/wechat/messages");

    expect(isWechatRequestAuthorized(req, undefined)).toBe(false);
  });

  it("env 变量未设置时拒绝", () => {
    const req = new Request("https://x.test/api/integrations/wechat/messages", {
      headers: { "x-integration-secret": "anything" }
    });

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(false);
  });

  it("请求未携带 secret 头时拒绝", () => {
    process.env.TEST_SECRET = "supersecret";
    const req = new Request("https://x.test/api/integrations/wechat/messages");

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(false);
  });

  it("错误的 secret 拒绝", () => {
    process.env.TEST_SECRET = "supersecret";
    const req = new Request("https://x.test/api/integrations/wechat/messages", {
      headers: { "x-integration-secret": "wrong" }
    });

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(false);
  });

  it("x-integration-secret 头携带正确 secret 时通过", () => {
    process.env.TEST_SECRET = "supersecret";
    const req = new Request("https://x.test/api/integrations/wechat/messages", {
      headers: { "x-integration-secret": "supersecret" }
    });

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(true);
  });

  it("Authorization Bearer 头携带正确 secret 时通过", () => {
    process.env.TEST_SECRET = "supersecret";
    const req = new Request("https://x.test/api/integrations/wechat/messages", {
      headers: { authorization: "Bearer supersecret" }
    });

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(true);
  });

  it("旧版 x-mcp-secret 头携带正确 secret 时通过", () => {
    process.env.TEST_SECRET = "supersecret";
    const req = new Request("https://x.test/api/integrations/wechat/messages", {
      headers: { "x-mcp-secret": "supersecret" }
    });

    expect(isWechatRequestAuthorized(req, "TEST_SECRET")).toBe(true);
  });
});
