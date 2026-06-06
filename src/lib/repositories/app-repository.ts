import type { AppState } from "../domain/app-state";
import type { KeywordGroup, OutboundMessage, Ticket } from "../domain/types";
import type { TicketSummary } from "../domain/ticket-summary";
import { MariaDbStateStore, type WechatOrderLog } from "../db/mariadb-state-store";
import { resolveStorageMode, type StorageMode } from "../db/storage-mode";
import type { BoothRecord } from "../domain/types";
import type { AppConfig } from "../seed";
import type { SubmitTicketInput, SubmitTicketResult } from "../services/ticket-service";
import type { IntakeMessageInput } from "../services/message-intake-service";
import type { WatchtowerResult } from "../services/wechat-watchtower-service";
import type {
  AgentRegistrationResult,
  ClaimOutboundInput,
  CompleteOutboundInput,
  EventReceipt,
  OutboundLease,
  RegisterAgentInput,
  SubmitEventsInput
} from "../integrations/wxauto/contracts";

export type MobileBootstrapData = {
  tickets: TicketSummary[];
  config: AppConfig;
};

export type AdminBootstrapData = {
  tickets: TicketSummary[];
  booths: BoothRecord[];
  messageRecords: AppState["messageRecords"];
  people: NonNullable<AppState["people"]>;
  chatIdentities: NonNullable<AppState["chatIdentities"]>;
  conversations: NonNullable<AppState["conversations"]>;
  pendingWorkOrderSessions: NonNullable<AppState["pendingWorkOrderSessions"]>;
  outboundMessages: NonNullable<AppState["outboundMessages"]>;
  config: AppConfig;
};

export type AppRepository = {
  kind: StorageMode;
  mobileBootstrap(): Promise<MobileBootstrapData>;
  adminBootstrap(): Promise<AdminBootstrapData>;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  saveKeywordGroups(keywordGroups: KeywordGroup[]): Promise<KeywordGroup[]>;
  importBooths(booths: BoothRecord[]): Promise<BoothRecord[]>;
  listTicketSummaries(): Promise<TicketSummary[]>;
  getTicket(ticketId: string): Promise<Ticket | undefined>;
  saveTicket(ticket: Ticket, options?: { notificationText?: string }): Promise<Ticket>;
  submitTicket(input: SubmitTicketInput): Promise<SubmitTicketResult>;
  processWechatMessage(input: IntakeMessageInput): Promise<WatchtowerResult>;
  registerWxautoAgent(input: RegisterAgentInput): Promise<AgentRegistrationResult>;
  submitWxautoEvents(input: SubmitEventsInput): Promise<EventReceipt[]>;
  claimWxautoOutbound(input: ClaimOutboundInput): Promise<OutboundLease[]>;
  completeWxautoOutbound(input: CompleteOutboundInput): Promise<{ accepted: boolean; message?: OutboundMessage }>;
  claimOutboundMessages(limit?: number): Promise<NonNullable<AppState["outboundMessages"]>>;
  markOutboundMessage(messageId: string, status: "sent" | "failed", error?: string): Promise<NonNullable<AppState["outboundMessages"]>[number] | undefined>;
  listWechatOrderLogs(limit?: number): Promise<WechatOrderLog[]>;
};

export function createMariaDbAppRepository(store = new MariaDbStateStore()): AppRepository {
  return {
    kind: "mariadb",
    mobileBootstrap: () => store.mobileBootstrap(),
    adminBootstrap: () => store.adminBootstrap(),
    getConfig: () => store.getConfig(),
    saveConfig: (config) => store.saveConfig(config),
    saveKeywordGroups: (keywordGroups) => store.saveKeywordGroups(keywordGroups),
    importBooths: (booths) => store.importBooths(booths),
    listTicketSummaries: () => store.listTicketSummaries(),
    getTicket: (ticketId) => store.getTicket(ticketId),
    saveTicket: (ticket, options) => store.saveTicket(ticket, options),
    submitTicket: (input) => store.submitTicket(input),
    processWechatMessage: (input) => store.processWechatMessage(input),
    registerWxautoAgent: (input) => store.registerWxautoAgent(input),
    submitWxautoEvents: (input) => store.submitWxautoEvents(input),
    claimWxautoOutbound: (input) => store.claimWxautoOutbound(input),
    completeWxautoOutbound: (input) => store.completeWxautoOutbound(input),
    claimOutboundMessages: (limit) => store.claimOutboundMessages(limit),
    markOutboundMessage: (messageId, status, error) => store.markOutboundMessage(messageId, status, error),
    listWechatOrderLogs: (limit = 100) => store.listWechatOrderLogs(limit)
  };
}

export function createAppRepository(env: NodeJS.ProcessEnv = process.env): AppRepository {
  resolveStorageMode(env);
  return createMariaDbAppRepository();
}

let repository: AppRepository | undefined;

export function getAppRepository() {
  repository ??= createAppRepository();
  return repository;
}

export function resetAppRepositoryForTests() {
  repository = undefined;
}
