import type { AiDecision, AiModelConfig, CustomerServiceDecision, Ticket } from "../domain/types";

export type CustomerServiceContext = {
  messageText: string;
  senderName?: string;
  historyMessages: Array<{ text: string; createdAt: string; analysis?: unknown }>;
  candidateTickets: Ticket[];
};

export type AiProvider = {
  classify(model: AiModelConfig, boothNumber: string, description: string, systemPrompt?: string): Promise<AiDecision>;
  dedupe(model: AiModelConfig, boothNumber: string, description: string, candidates: Ticket[], systemPrompt?: string): Promise<AiDecision>;
  escalate(model: AiModelConfig, boothNumber: string, description: string, similarTickets: Ticket[], systemPrompt?: string): Promise<AiDecision>;
  customerService(model: AiModelConfig, context: CustomerServiceContext, systemPrompt?: string): Promise<CustomerServiceDecision>;
};
