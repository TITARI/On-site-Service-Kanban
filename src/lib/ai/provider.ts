import type { AiModelConfig, Ticket } from "../domain/types";
import { httpAiProvider } from "./http-provider";
import { mockAiProvider } from "./mock-provider";
import type { AiProvider } from "./types";

async function withFallback<T>(
  model: AiModelConfig,
  scenario: string,
  httpCall: () => Promise<T>,
  mockCall: () => Promise<T>
) {
  if (model.provider !== "http") return { ...await mockCall(), provider: "mock" as const };
  try {
    return { ...await httpCall(), provider: "http" as const };
  } catch (error) {
    console.warn("[ai] http 降级到 mock", {
      modelId: model.id,
      scenario,
      endpoint: model.endpoint,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString()
    });
    return { ...await mockCall(), provider: "mock" as const };
  }
}

export function createConfiguredAiProvider(): AiProvider {
  return {
    classify(model, boothNumber, description, systemPrompt) {
      return withFallback(
        model,
        "classify",
        () => httpAiProvider.classify(model, boothNumber, description, systemPrompt),
        () => mockAiProvider.classify(model, boothNumber, description, systemPrompt)
      );
    },
    dedupe(model, boothNumber, description, candidates: Ticket[], systemPrompt) {
      return withFallback(
        model,
        "dedupe",
        () => httpAiProvider.dedupe(model, boothNumber, description, candidates, systemPrompt),
        () => mockAiProvider.dedupe(model, boothNumber, description, candidates, systemPrompt)
      );
    },
    escalate(model, boothNumber, description, similarTickets: Ticket[], systemPrompt) {
      return withFallback(
        model,
        "escalation",
        () => httpAiProvider.escalate(model, boothNumber, description, similarTickets, systemPrompt),
        () => mockAiProvider.escalate(model, boothNumber, description, similarTickets, systemPrompt)
      );
    },
    customerService(model, context, systemPrompt) {
      return withFallback(
        model,
        "customer-service",
        () => httpAiProvider.customerService(model, context, systemPrompt),
        () => mockAiProvider.customerService(model, context, systemPrompt)
      );
    },
    mapExhibitorFields(model, context, systemPrompt) {
      return withFallback(
        model,
        "exhibitor-import",
        () => httpAiProvider.mapExhibitorFields(model, context, systemPrompt),
        () => mockAiProvider.mapExhibitorFields(model, context, systemPrompt)
      );
    }
  };
}
