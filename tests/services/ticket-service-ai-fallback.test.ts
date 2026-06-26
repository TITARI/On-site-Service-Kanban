import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";

const aiMock = vi.hoisted(() => ({
  classifyIssue: vi.fn(),
  dedupeIssue: vi.fn()
}));

vi.mock("@/lib/ai/router", () => ({
  createAiRouter: () => aiMock
}));

import { createTicketService } from "@/lib/services/ticket-service";

function classification(issueType = "网络") {
  return {
    modelId: "fast",
    scenario: "classify",
    confidence: 0.86,
    action: "classify",
    issueType,
    latencyMs: 1
  };
}

function dedupe(confidence = 0) {
  return {
    modelId: "smart",
    scenario: "dedupe",
    confidence,
    action: "create",
    latencyMs: 1
  };
}

function state() {
  return {
    booths: [{ boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }],
    tickets: [],
    messageRecords: [],
    config: defaultConfig()
  };
}

function input() {
  return {
    boothNumber: "A01",
    description: "现场需要协助处理",
    imageUrls: [],
    issueType: "自动",
    submitterId: "u1",
    submitterName: "张三"
  };
}

beforeEach(() => {
  aiMock.classifyIssue.mockReset().mockResolvedValue(classification());
  aiMock.dedupeIssue.mockReset().mockResolvedValue(dedupe());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ticket service AI fallback", () => {
  it("creates a ticket with 综合服务 when classification fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockRejectedValue(new Error("classify down"));
    const service = createTicketService({ state: state() });

    const result = await service.submitTicket(input());

    expect(result.kind).toBe("created");
    expect(result.ticket.issueType).toBe("综合服务");
  });

  it("logs a warning when classification fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockRejectedValue(new Error("classify down"));
    const service = createTicketService({ state: state() });

    await service.submitTicket(input());

    expect(warnSpy).toHaveBeenCalledWith("[ticket-service] classifyIssue 失败，使用降级值", expect.objectContaining({
      modelId: "fast",
      scenario: "classify",
      error: "classify down",
      timestamp: expect.any(String)
    }));
  });

  it("creates a new ticket when dedupe fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.dedupeIssue.mockRejectedValue(new Error("dedupe down"));
    const service = createTicketService({ state: state() });

    const result = await service.submitTicket(input());

    expect(result.kind).toBe("created");
    expect(result.ticket.aiDecisions.at(-1)).toMatchObject({ scenario: "dedupe", action: "create", confidence: 0 });
  });

  it("creates a ticket when both classification and dedupe fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockRejectedValue(new Error("classify down"));
    aiMock.dedupeIssue.mockRejectedValue(new Error("dedupe down"));
    const service = createTicketService({ state: state() });

    const result = await service.submitTicket(input());

    expect(result.kind).toBe("created");
    expect(result.ticket.issueType).toBe("综合服务");
    expect(result.ticket.aiDecisions.at(-1)).toMatchObject({ scenario: "dedupe", action: "create" });
  });

  it("keeps the normal AI path unchanged", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockResolvedValue(classification("网络"));
    aiMock.dedupeIssue.mockImplementation(async (_boothNumber, _description, candidates) => ({
      ...dedupe(candidates.length ? 0.91 : 0),
      matchedTicketId: candidates[0]?.id
    }));
    const appState = state();
    const service = createTicketService({ state: appState });

    await service.submitTicket(input());
    const result = await service.submitTicket({ ...input(), submitterId: "u2", submitterName: "李四" });

    expect(result.kind).toBe("urged");
    expect(result.ticket.issueType).toBe("网络");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
