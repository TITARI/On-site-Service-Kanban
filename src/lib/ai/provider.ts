import type { AiModelConfig, Ticket } from "../domain/types";
import { httpAiProvider } from "./http-provider";
import { mockAiProvider } from "./mock-provider";
import type { AiProvider } from "./types";

async function withFallback<T>(model: AiModelConfig, httpCall: () => Promise<T>, mockCall: () => Promise<T>) {
  if (model.provider !== "http") return mockCall();
  try {
    return await httpCall();
  } catch {
    return mockCall();
  }
}

export function createConfiguredAiProvider(): AiProvider {
  return {
    classify(model, boothNumber, description, systemPrompt) {
      return withFallback(
        model,
        () => httpAiProvider.classify(model, boothNumber, description, systemPrompt),
        () => mockAiProvider.classify(model, boothNumber, description, systemPrompt)
      );
    },
    dedupe(model, boothNumber, description, candidates: Ticket[], systemPrompt) {
      return withFallback(
        model,
        () => httpAiProvider.dedupe(model, boothNumber, description, candidates, systemPrompt),
        () => mockAiProvider.dedupe(model, boothNumber, description, candidates, systemPrompt)
      );
    },
    escalate(model, boothNumber, description, similarTickets: Ticket[], systemPrompt) {
      return withFallback(
        model,
        () => httpAiProvider.escalate(model, boothNumber, description, similarTickets, systemPrompt),
        () => mockAiProvider.escalate(model, boothNumber, description, similarTickets, systemPrompt)
      );
    },
    customerService(model, context, systemPrompt) {
      return withFallback(
        model,
        () => httpAiProvider.customerService(model, context, systemPrompt),
        () => mockAiProvider.customerService(model, context, systemPrompt)
      );
    },
    mapExhibitorFields(model, context, systemPrompt) {
      return withFallback(
        model,
        () => httpAiProvider.mapExhibitorFields(model, context, systemPrompt),
        () => mockAiProvider.mapExhibitorFields(model, context, systemPrompt)
      );
    }
  };
}
