import { describe, expect, it } from "vitest";
import { createAiRouter } from "@/lib/ai/router";
import { mockAiProvider } from "@/lib/ai/mock-provider";
import type { AiProvider } from "@/lib/ai/types";
import type { AiDecision, AiModelConfig } from "@/lib/domain/types";

const models: AiModelConfig[] = [
  { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
  { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
];

describe("ai router", () => {
  it("uses fast ai for classification", async () => {
    const router = createAiRouter({ models, provider: mockAiProvider });
    const decision = await router.classifyIssue("A01", "网络断了，展台不能扫码");

    expect(decision.modelId).toBe("fast");
    expect(decision.provider).toBe("mock");
    expect(decision.action).toBe("classify");
    expect(decision.issueType).toBe("网络");
  });

  it("uses smart ai for escalation advice", async () => {
    const router = createAiRouter({ models, provider: mockAiProvider });
    const decision = await router.escalate("A01", "网络断了", []);

    expect(decision.modelId).toBe("smart");
    expect(decision.provider).toBe("mock");
    expect(decision.suggestion).toContain("优先核查");
  });

  it("uses smart ai for deduplication", async () => {
    let modelUsed: AiModelConfig | undefined;
    const provider: AiProvider = {
      async classify(model): Promise<AiDecision> {
        return { modelId: model.id, provider: "mock", scenario: "classify", confidence: 0.8, action: "classify", issueType: "网络", latencyMs: 1 };
      },
      async dedupe(model): Promise<AiDecision> {
        modelUsed = model;
        return { modelId: model.id, provider: "mock", scenario: "dedupe", confidence: 0.91, action: "urge", latencyMs: 1 };
      },
      async escalate(model): Promise<AiDecision> {
        return { modelId: model.id, provider: "mock", scenario: "escalation", confidence: 0.8, action: "manual-review", suggestion: "优先核查", latencyMs: 1 };
      },
      async customerService() {
        return { modelId: "smart", provider: "mock", scenario: "customer-service", confidence: 0.9, pressureLevel: 4, action: "expedite", replyText: "已加急", reason: "客户催办", latencyMs: 1 };
      }
    };

    const router = createAiRouter({ models, provider });
    const decision = await router.dedupeIssue("A01", "网络断了", []);

    expect(modelUsed?.id).toBe("smart");
    expect(decision.action).toBe("urge");
  });

  it("uses smart ai for customer service urgency decisions", async () => {
    const router = createAiRouter({ models, provider: mockAiProvider });
    const decision = await router.customerService({
      messageText: "怎么样了，客户一直在催",
      senderName: "王宁",
      historyMessages: [],
      candidateTickets: [{
        id: "ticket-1",
        title: "A01 星河科技 网络",
        boothNumber: "A01",
        companyName: "上海星河科技有限公司",
        companyShortName: "星河科技",
        description: "A01 网络断了",
        imageUrls: [],
        issueType: "网络",
        submitterId: "person-1",
        submitterName: "王宁",
        feedbackUsers: [],
        status: "待受理",
        assignmentGroup: "网络组",
        urgeCount: 0,
        urgeLevel: 0,
        priorityScore: 25,
        aiDecisions: [],
        replies: [],
        timeline: [],
        createdAt: "2026-05-22T08:00:00.000Z",
        updatedAt: "2026-05-22T08:00:00.000Z"
      }]
    });

    expect(decision.modelId).toBe("smart");
    expect(decision.provider).toBe("mock");
    expect(decision.action).toBe("expedite");
    expect(decision.pressureLevel).toBeGreaterThanOrEqual(4);
  });
});
