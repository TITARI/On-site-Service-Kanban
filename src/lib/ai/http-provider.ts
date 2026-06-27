import { decideDeduplication } from "../domain/deduplication";
import type { AiDecision, AiModelConfig, ImportSystemField, Ticket } from "../domain/types";
import { assertApiKeyEnv, validateAiEndpoint } from "./endpoint-validation";
import type { AiProvider, ExhibitorFieldMappingContext, ExhibitorFieldMappingDecision } from "./types";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  output_text?: string;
  content?: string;
};

function readApiKey(model: AiModelConfig) {
  if (model.apiKey) return model.apiKey;
  if (model.apiKeyEnv) {
    assertApiKeyEnv(model.apiKeyEnv);
    return process.env[model.apiKeyEnv];
  }
  return undefined;
}

function clampConfidence(value: unknown, fallback = 0.75) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function parseJsonContent(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const trimmed = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) return {};
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function responseContent(data: ChatCompletionResponse) {
  return data.choices?.[0]?.message?.content ?? data.output_text ?? data.content ?? "";
}

function pressureLevel(value: unknown) {
  const numberValue = Math.round(Number(value));
  if (!Number.isFinite(numberValue)) return 3;
  return Math.max(1, Math.min(5, numberValue)) as 1 | 2 | 3 | 4 | 5;
}

async function callChatJson(model: AiModelConfig, system: string, payload: Record<string, unknown>) {
  if (!model.endpoint) throw new Error("智能接口地址未配置");
  const endpointValidation = validateAiEndpoint(model.endpoint);
  if (!endpointValidation.ok) throw new Error(`AI endpoint invalid: ${endpointValidation.reason}`);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), model.timeoutMs);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = readApiKey(model);
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(model.endpoint, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: model.modelName,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(payload) }
        ],
        response_format: { type: "json_object" }
      })
    });
    if (!response.ok) throw new Error(`智能接口异常：${response.status}`);
    const data = await response.json() as ChatCompletionResponse;
    return { json: parseJsonContent(responseContent(data)), latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

export const httpAiProvider: AiProvider = {
  async classify(model, boothNumber, description, systemPrompt): Promise<AiDecision> {
    const result = await callChatJson(
      model,
      systemPrompt ??
      "你是展会现场工单分类助手。只返回JSON：{\"issueType\":\"问题类型\",\"confidence\":0到1}。",
      { boothNumber, description }
    );
    return {
      modelId: model.id,
      provider: "http",
      scenario: "classify",
      confidence: clampConfidence(result.json.confidence),
      action: "classify",
      issueType: typeof result.json.issueType === "string" ? result.json.issueType : "综合服务",
      latencyMs: result.latencyMs
    };
  },
  async dedupe(model, boothNumber, description, candidates, systemPrompt): Promise<AiDecision> {
    const result = await callChatJson(
      model,
      systemPrompt ??
      "你是展会现场工单语义判重助手。只返回JSON：{\"confidence\":0到1,\"matchedTicketId\":\"可选工单ID\"}。",
      {
        boothNumber,
        description,
        candidates: candidates.map((ticket) => ({
          id: ticket.id,
          boothNumber: ticket.boothNumber,
          issueType: ticket.issueType,
          description: ticket.description,
          status: ticket.status
        }))
      }
    );
    const confidence = clampConfidence(result.json.confidence, 0);
    const matchedTicketId = typeof result.json.matchedTicketId === "string" ? result.json.matchedTicketId : undefined;
    return {
      modelId: model.id,
      provider: "http",
      scenario: "dedupe",
      confidence,
      action: decideDeduplication(confidence),
      matchedTicketId,
      latencyMs: result.latencyMs
    };
  },
  async escalate(model, boothNumber, description, similarTickets: Ticket[], systemPrompt): Promise<AiDecision> {
    const result = await callChatJson(
      model,
      systemPrompt ??
      "你是展会现场超时工单研判助手。只返回JSON：{\"confidence\":0到1,\"suggestion\":\"处理建议\",\"matchedTicketId\":\"可选工单ID\"}。",
      {
        boothNumber,
        description,
        similarTickets: similarTickets.map((ticket) => ({
          id: ticket.id,
          issueType: ticket.issueType,
          description: ticket.description,
          status: ticket.status,
          urgeCount: ticket.urgeCount
        }))
      }
    );
    return {
      modelId: model.id,
      provider: "http",
      scenario: "escalation",
      confidence: clampConfidence(result.json.confidence),
      action: "manual-review",
      suggestion: typeof result.json.suggestion === "string" ? result.json.suggestion : "建议管理员复核责任组、处理时限和现场资源。",
      matchedTicketId: typeof result.json.matchedTicketId === "string" ? result.json.matchedTicketId : similarTickets[0]?.id,
      latencyMs: result.latencyMs
    };
  },
  async customerService(model, context, systemPrompt) {
    const result = await callChatJson(
      model,
      systemPrompt ??
      "你是展会现场客服研判助手。请只返回JSON：{\"action\":\"reply|ask-follow-up|urge-existing|expedite|manual-review|ignore\",\"confidence\":0到1,\"pressureLevel\":1到5,\"matchedTicketId\":\"可选工单ID\",\"replyText\":\"给用户的专业回复\",\"reason\":\"判断原因\"}。只能根据输入中的真实工单状态回复，不得编造进度。",
      {
        messageText: context.messageText,
        senderName: context.senderName,
        historyMessages: context.historyMessages.slice(-8),
        candidateTickets: context.candidateTickets.map((ticket) => ({
          id: ticket.id,
          title: ticket.title,
          boothNumber: ticket.boothNumber,
          issueType: ticket.issueType,
          status: ticket.status,
          description: ticket.description,
          urgeCount: ticket.urgeCount,
          urgeLevel: ticket.urgeLevel,
          lastUrgedAt: ticket.lastUrgedAt,
          updatedAt: ticket.updatedAt
        }))
      }
    );
    const actionValue = typeof result.json.action === "string" ? result.json.action : "";
    const action = ["reply", "ask-follow-up", "urge-existing", "expedite", "manual-review", "ignore"].includes(actionValue)
      ? actionValue as "reply" | "ask-follow-up" | "urge-existing" | "expedite" | "manual-review" | "ignore"
      : "manual-review";
    return {
      modelId: "smart" as const,
      provider: "http" as const,
      scenario: "customer-service" as const,
      confidence: clampConfidence(result.json.confidence, 0),
      pressureLevel: pressureLevel(result.json.pressureLevel),
      action,
      matchedTicketId: typeof result.json.matchedTicketId === "string" ? result.json.matchedTicketId : undefined,
      replyText: typeof result.json.replyText === "string" ? result.json.replyText : "收到，我来帮您跟进处理进度。",
      reason: typeof result.json.reason === "string" ? result.json.reason : "智能客服研判未返回明确原因",
      latencyMs: result.latencyMs
    };
  },
  async mapExhibitorFields(model, context: ExhibitorFieldMappingContext, systemPrompt): Promise<ExhibitorFieldMappingDecision> {
    const result = await callChatJson(
      model,
      systemPrompt ??
      "你是展商导入表格字段映射助手。只允许根据表头、样例值和工作表名输出 JSON，不要编造不存在的列。输出格式：{\"mappings\":[{\"field\":\"boothNumber|companyName|floor|hall|area|areaSpecification|exhibitorType|salesOwner|builder\",\"columnIndex\":0,\"confidence\":0.0,\"reason\":\"简短理由\"}]}。只为无法通过规则可靠识别的字段给建议；如果无法判断就返回空数组。",
      context
    );
    const validFields = new Set<ImportSystemField>([
      "boothNumber",
      "companyName",
      "floor",
      "hall",
      "area",
      "areaSpecification",
      "exhibitorType",
      "salesOwner",
      "builder"
    ]);
    const mappings = Array.isArray(result.json.mappings) ? result.json.mappings : [];
    return {
      mappings: mappings.flatMap((mapping) => {
        const field = typeof mapping?.field === "string" && validFields.has(mapping.field as ImportSystemField) ? mapping.field as ImportSystemField : undefined;
        const columnIndex = Number(mapping?.columnIndex);
        const confidence = clampConfidence(mapping?.confidence, 0);
        const reason = typeof mapping?.reason === "string" ? mapping.reason : "";
        if (!field || !Number.isInteger(columnIndex) || columnIndex < 0 || !reason) return [];
        return [{ field, columnIndex, confidence, reason }];
      })
    };
  }
};
