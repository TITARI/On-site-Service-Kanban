import type { AiDecision, AiModelConfig, CustomerServiceDecision, ImportSystemField, Ticket } from "../domain/types";

export type CustomerServiceContext = {
  messageText: string;
  senderName?: string;
  historyMessages: Array<{ text: string; createdAt: string; analysis?: unknown }>;
  candidateTickets: Ticket[];
};

export type ExhibitorFieldMappingContext = {
  sheetName: string;
  headers: Array<{ columnIndex: number; label: string; samples: string[] }>;
  unmappedFields: ImportSystemField[];
};

export type ExhibitorFieldMappingDecision = {
  mappings: Array<{
    field: ImportSystemField;
    columnIndex: number;
    confidence: number;
    reason: string;
  }>;
};

export type AiProvider = {
  classify(model: AiModelConfig, boothNumber: string, description: string, systemPrompt?: string): Promise<AiDecision>;
  dedupe(model: AiModelConfig, boothNumber: string, description: string, candidates: Ticket[], systemPrompt?: string): Promise<AiDecision>;
  escalate(model: AiModelConfig, boothNumber: string, description: string, similarTickets: Ticket[], systemPrompt?: string): Promise<AiDecision>;
  customerService(model: AiModelConfig, context: CustomerServiceContext, systemPrompt?: string): Promise<CustomerServiceDecision>;
  mapExhibitorFields(model: AiModelConfig, context: ExhibitorFieldMappingContext, systemPrompt?: string): Promise<ExhibitorFieldMappingDecision>;
};
