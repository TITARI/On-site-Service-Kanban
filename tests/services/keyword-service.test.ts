import { describe, expect, it } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { detectKeywordIssueType, hasKeywordOperationalIntent } from "@/lib/services/keyword-service";

describe("keyword service", () => {
  it("detects intent from one rule set that owns multiple keyword terms", () => {
    const config = defaultConfig();
    config.keywordGroups = [
      {
        id: "site-intent",
        name: "现场诉求",
        description: "一条规则维护多个同规则关键词",
        enabled: true,
        ruleSets: [
          {
            id: "site-intent-report",
            matchType: "contains",
            action: "operational-intent",
            priority: 30,
            enabled: true,
            terms: [
              { id: "term-repair", value: "报修", enabled: true },
              { id: "term-broken", value: "故障", enabled: true }
            ]
          }
        ]
      }
    ];

    expect(hasKeywordOperationalIntent("A01 需要报修", [], config.keywordGroups)).toBe(true);
    expect(hasKeywordOperationalIntent("A02 设备故障", [], config.keywordGroups)).toBe(true);
    expect(hasKeywordOperationalIntent("只是普通聊天", [], config.keywordGroups)).toBe(false);
  });

  it("detects operational intent from configured keywords instead of hardcoded lists", () => {
    const config = defaultConfig();
    config.keywordGroups = [
      {
        id: "custom-intent",
        name: "自定义意图",
        description: "测试用关键词",
        enabled: true,
        rules: [
          {
            id: "coffee-machine",
            keyword: "咖啡机",
            matchType: "contains",
            action: "operational-intent",
            priority: 10,
            enabled: true
          }
        ]
      }
    ];

    expect(hasKeywordOperationalIntent("A01 咖啡机坏了", [], config.keywordGroups)).toBe(true);
    expect(hasKeywordOperationalIntent("只是普通聊天", [], config.keywordGroups)).toBe(false);
  });

  it("maps configured issue keywords to enabled issue types", () => {
    const config = defaultConfig();
    config.keywordGroups = [
      {
        id: "custom-issue",
        name: "自定义问题类型",
        description: "测试用关键词",
        enabled: true,
        rules: [
          {
            id: "water-leak",
            keyword: "漏水",
            matchType: "contains",
            action: "issue-type",
            issueType: "综合服务",
            priority: 20,
            enabled: true
          }
        ]
      }
    ];

    expect(detectKeywordIssueType("B03 漏水了", config.issueTypes, config.keywordGroups)).toBe("综合服务");
  });
});
