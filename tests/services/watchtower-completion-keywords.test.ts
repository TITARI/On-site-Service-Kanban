import { describe, expect, it } from "vitest";
import { isHandlerCompletionText } from "@/lib/services/wechat-watchtower-service";

describe("watchtower handler completion keywords", () => {
  it.each([
    "已处理",
    "A01 已处理完成",
    "现场测试正常"
  ])("matches completion text: %s", (text) => {
    expect(isHandlerCompletionText(text)).toBe(true);
  });

  it.each([
    "未完成",
    "没完成",
    "修复失败",
    "问题没解决了",
    "完成度不够",
    "未能修复"
  ])("ignores negated or failed completion text: %s", (text) => {
    expect(isHandlerCompletionText(text)).toBe(false);
  });
});
