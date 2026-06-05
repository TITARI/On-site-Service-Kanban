import { selectedAiPromptTemplate, type AiPromptConfigLike } from "../domain/ai-config";
import type { AiModelConfig, AiPromptScenario, Ticket } from "../domain/types";
import type { AiProvider, CustomerServiceContext } from "./types";

type RouterOptions = {
  models: AiModelConfig[];
  provider: AiProvider;
  promptConfig?: AiPromptConfigLike;
};

function getEnabledModel(models: AiModelConfig[], id: "fast" | "smart") {
  const model = models.find((item) => item.id === id && item.enabled);
  if (!model) throw new Error(`${id} AI未启用`);
  return model;
}

function selectedPrompt(config: AiPromptConfigLike | undefined, scenario: AiPromptScenario) {
  return selectedAiPromptTemplate(config ?? {}, scenario).systemPrompt;
}

export function createAiRouter({ models, provider, promptConfig }: RouterOptions) {
  return {
    classifyIssue(boothNumber: string, description: string) {
      return provider.classify(getEnabledModel(models, "fast"), boothNumber, description, selectedPrompt(promptConfig, "classify"));
    },
    dedupeIssue(boothNumber: string, description: string, candidates: Ticket[]) {
      return provider.dedupe(getEnabledModel(models, "smart"), boothNumber, description, candidates, selectedPrompt(promptConfig, "dedupe"));
    },
    escalate(boothNumber: string, description: string, similarTickets: Ticket[]) {
      return provider.escalate(getEnabledModel(models, "smart"), boothNumber, description, similarTickets, selectedPrompt(promptConfig, "escalation"));
    },
    customerService(context: CustomerServiceContext) {
      return provider.customerService(getEnabledModel(models, "smart"), context, selectedPrompt(promptConfig, "customer-service"));
    }
  };
}
