import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { z } from "zod";
import { selectedAiPromptTemplate } from "../domain/ai-config";
import { decideDeduplication } from "../domain/deduplication";
import type { AiDecision, AiModelConfig, AiPromptScenario, Ticket } from "../domain/types";
import { assertApiKeyEnv, validateAiEndpoint } from "./endpoint-validation";
import type { AiProvider, ExhibitorFieldMappingContext, ExhibitorFieldMappingDecision } from "./types";

const DEFAULT_TIMEOUT_MS = 8000;

const classifySchema = z.object({
  issueType: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const matchedTicketIdSchema = z.string().min(1).nullable().default(null);

const dedupeSchema = z.object({
  confidence: z.number().min(0).max(1),
  matchedTicketId: matchedTicketIdSchema
});

const escalationSchema = z.object({
  confidence: z.number().min(0).max(1),
  suggestion: z.string().min(1),
  matchedTicketId: matchedTicketIdSchema
});

const customerServiceSchema = z.object({
  confidence: z.number().min(0).max(1),
  pressureLevel: z.number().int().min(1).max(5),
  action: z.enum(["reply", "ask-follow-up", "urge-existing", "expedite", "manual-review", "ignore"]),
  matchedTicketId: matchedTicketIdSchema,
  replyText: z.string().min(1),
  reason: z.string().min(1)
});

const exhibitorFieldSchema = z.enum([
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

const exhibitorMappingSchema = z.object({
  mappings: z.array(z.object({
    field: exhibitorFieldSchema,
    columnIndex: z.number().int().min(0),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1)
  }))
});

function readApiKey(model: AiModelConfig) {
  if (model.apiKey) return model.apiKey;
  if (model.apiKeyEnv) {
    assertApiKeyEnv(model.apiKeyEnv);
    return process.env[model.apiKeyEnv];
  }
  return undefined;
}

function normalizeEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const queryParams = Object.fromEntries(url.searchParams.entries());
  url.search = "";
  return {
    baseURL: url.toString().replace(/\/$/, ""),
    queryParams
  };
}

function timeoutFor(model: AiModelConfig) {
  return Number.isFinite(model.timeoutMs) && model.timeoutMs > 0
    ? model.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

function systemPromptFor(scenario: AiPromptScenario, configured?: string) {
  return configured ?? selectedAiPromptTemplate({}, scenario).systemPrompt;
}

async function generateStructured<Result>(
  model: AiModelConfig,
  schema: z.ZodType<Result>,
  system: string,
  payload: Record<string, unknown>
) {
  if (!model.endpoint) throw new Error("智能接口地址未配置");
  const endpointValidation = validateAiEndpoint(model.endpoint);
  if (!endpointValidation.ok) throw new Error(`AI endpoint invalid: ${endpointValidation.reason}`);
  const apiKey = readApiKey(model);
  if (!apiKey) throw new Error(`AI 模型 ${model.id} 未配置密钥`);
  const provider = createOpenAICompatible({
    name: "configured-ai",
    ...normalizeEndpoint(model.endpoint),
    apiKey,
    supportsStructuredOutputs: false
  });
  const startedAt = Date.now();
  const result = await generateText({
    model: provider(model.modelName),
    output: Output.json(),
    system,
    prompt: JSON.stringify(payload),
    temperature: 0,
    maxRetries: 2,
    timeout: timeoutFor(model)
  });
  return { output: schema.parse(result.output), latencyMs: Date.now() - startedAt };
}

export const httpAiProvider: AiProvider = {
  async classify(model, boothNumber, description, systemPrompt): Promise<AiDecision> {
    const result = await generateStructured(
      model,
      classifySchema,
      systemPromptFor("classify", systemPrompt),
      { boothNumber, description }
    );
    return {
      modelId: model.id,
      provider: "http",
      scenario: "classify",
      confidence: result.output.confidence,
      action: "classify",
      issueType: result.output.issueType,
      latencyMs: result.latencyMs
    };
  },
  async dedupe(model, boothNumber, description, candidates, systemPrompt): Promise<AiDecision> {
    const result = await generateStructured(
      model,
      dedupeSchema,
      systemPromptFor("dedupe", systemPrompt),
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
    const confidence = result.output.confidence;
    return {
      modelId: model.id,
      provider: "http",
      scenario: "dedupe",
      confidence,
      action: decideDeduplication(confidence),
      matchedTicketId: result.output.matchedTicketId ?? undefined,
      latencyMs: result.latencyMs
    };
  },
  async escalate(model, boothNumber, description, similarTickets: Ticket[], systemPrompt): Promise<AiDecision> {
    const result = await generateStructured(
      model,
      escalationSchema,
      systemPromptFor("escalation", systemPrompt),
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
      confidence: result.output.confidence,
      action: "manual-review",
      suggestion: result.output.suggestion,
      matchedTicketId: result.output.matchedTicketId ?? similarTickets[0]?.id,
      latencyMs: result.latencyMs
    };
  },
  async customerService(model, context, systemPrompt) {
    const result = await generateStructured(
      model,
      customerServiceSchema,
      systemPromptFor("customer-service", systemPrompt),
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
    return {
      modelId: "smart" as const,
      provider: "http" as const,
      scenario: "customer-service" as const,
      confidence: result.output.confidence,
      pressureLevel: result.output.pressureLevel as 1 | 2 | 3 | 4 | 5,
      action: result.output.action,
      matchedTicketId: result.output.matchedTicketId ?? undefined,
      replyText: result.output.replyText,
      reason: result.output.reason,
      latencyMs: result.latencyMs
    };
  },
  async mapExhibitorFields(model, context: ExhibitorFieldMappingContext, systemPrompt): Promise<ExhibitorFieldMappingDecision> {
    const result = await generateStructured(
      model,
      exhibitorMappingSchema,
      systemPromptFor("exhibitor-import", systemPrompt),
      context
    );
    return { mappings: result.output.mappings };
  }
};
