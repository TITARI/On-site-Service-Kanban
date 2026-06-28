import { describe, expect, it } from "vitest";
import { looksLikeBoothReference } from "@/lib/services/wechat-watchtower-service";

describe("watchtower booth reference detection", () => {
  it.each([
    "展位 A01",
    "展台A01-123",
    "摊位 12B3",
    "booth A01"
  ])("matches an explicitly prefixed booth reference: %s", (text) => {
    expect(looksLikeBoothReference(text)).toBe(true);
  });

  it.each([
    "12 点吃饭",
    "abc123",
    "A01"
  ])("ignores text without an explicit booth prefix: %s", (text) => {
    expect(looksLikeBoothReference(text)).toBe(false);
  });
});
