import type { AppState } from "../domain/app-state";
import type { KeywordGroup, Ticket } from "../domain/types";
import { toTicketSummary, type TicketSummary } from "../domain/ticket-summary";
import { MariaDbStateStore, type WechatOrderLog } from "../db/mariadb-state-store";
import { resolveStorageMode, type StorageMode } from "../db/storage-mode";
import type { BoothRecord } from "../domain/types";
import type { AppConfig } from "../seed";
import type { SubmitTicketInput, SubmitTicketResult } from "../services/ticket-service";
import { createTicketService } from "../services/ticket-service";
import type { IntakeMessageInput } from "../services/message-intake-service";
import type { WatchtowerResult } from "../services/wechat-watchtower-service";
import { processWechatWatchtowerMessage } from "../services/wechat-watchtower-service";
import { claimPendingOutboundMessages, markOutboundMessageFailed, markOutboundMessageSent, queueTicketFeedbackMessage } from "../services/outbound-message-service";
import { runAutoAcceptanceForState } from "../services/auto-acceptance-service";
import { normalizeKeywordGroups } from "../domain/keyword-config";
import { readState as readJsonState, writeState as writeJsonState } from "../storage/file-store";

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
  runAutoAcceptance(now?: Date): Promise<void>;
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
  claimOutboundMessages(limit?: number): Promise<NonNullable<AppState["outboundMessages"]>>;
  markOutboundMessage(messageId: string, status: "sent" | "failed", error?: string): Promise<NonNullable<AppState["outboundMessages"]>[number] | undefined>;
  listWechatOrderLogs(limit?: number): Promise<WechatOrderLog[]>;
};

type StateFileRepository = {
  readState(): Promise<AppState>;
  writeState(state: AppState): Promise<void>;
};

type AutoAcceptanceStore = MariaDbStateStore & {
  runAutoAcceptance?: (now?: Date) => Promise<void>;
};

type NormalizedAppState = AppState & {
  people: NonNullable<AppState["people"]>;
  chatIdentities: NonNullable<AppState["chatIdentities"]>;
  conversations: NonNullable<AppState["conversations"]>;
  pendingWorkOrderSessions: NonNullable<AppState["pendingWorkOrderSessions"]>;
  outboundMessages: NonNullable<AppState["outboundMessages"]>;
};

function stateCollections(state: AppState): NormalizedAppState {
  state.messageRecords ??= [];
  state.people ??= [];
  state.chatIdentities ??= [];
  state.conversations ??= [];
  state.pendingWorkOrderSessions ??= [];
  state.outboundMessages ??= [];
  return state as NormalizedAppState;
}

async function updateState<T>(store: StateFileRepository, operation: (state: AppState) => Promise<T> | T) {
  const state = stateCollections(await store.readState());
  const result = await operation(state);
  await store.writeState(state);
  return result;
}

export function createFileAppRepository(store: StateFileRepository = { readState: readJsonState, writeState: writeJsonState }): AppRepository {
  return {
    kind: "file",
    runAutoAcceptance: async (now = new Date()) => {
      const state = stateCollections(await store.readState());
      const result = runAutoAcceptanceForState(state, { now: now.toISOString() });
      if (result.acceptedTicketIds.length > 0) {
        await store.writeState(state);
      }
    },
    mobileBootstrap: async () => {
      const state = stateCollections(await store.readState());
      return {
        tickets: state.tickets.map(toTicketSummary),
        config: state.config
      };
    },
    adminBootstrap: async () => {
      const state = stateCollections(await store.readState());
      return {
        tickets: state.tickets.map(toTicketSummary),
        booths: state.booths,
        messageRecords: state.messageRecords,
        people: state.people,
        chatIdentities: state.chatIdentities,
        conversations: state.conversations,
        pendingWorkOrderSessions: state.pendingWorkOrderSessions,
        outboundMessages: state.outboundMessages,
        config: state.config
      };
    },
    getConfig: async () => (await store.readState()).config,
    saveConfig: async (config) => updateState(store, (state) => {
      state.config = config;
      return config;
    }),
    saveKeywordGroups: async (keywordGroups) => updateState(store, (state) => {
      state.config = {
        ...state.config,
        keywordGroups: normalizeKeywordGroups(keywordGroups)
      };
      return state.config.keywordGroups ?? [];
    }),
    importBooths: async (booths) => updateState(store, (state) => {
      state.booths = booths;
      return state.booths;
    }),
    listTicketSummaries: async () => {
      const state = await store.readState();
      return state.tickets.map(toTicketSummary);
    },
    getTicket: async (ticketId) => {
      const state = await store.readState();
      return state.tickets.find((ticket) => ticket.id === ticketId);
    },
    saveTicket: async (ticket, options = {}) => updateState(store, (state) => {
      const existingIndex = state.tickets.findIndex((item) => item.id === ticket.id);
      if (existingIndex >= 0) {
        state.tickets[existingIndex] = ticket;
      } else {
        state.tickets.push(ticket);
      }
      if (options.notificationText) {
        queueTicketFeedbackMessage(state, ticket, options.notificationText);
      }
      return ticket;
    }),
    submitTicket: async (input) => updateState(store, async (state) => {
      return await createTicketService({ state }).submitTicket(input);
    }),
    processWechatMessage: async (input) => updateState(store, async (state) => {
      return await processWechatWatchtowerMessage(state, input);
    }),
    claimOutboundMessages: async (limit) => updateState(store, (state) => {
      return claimPendingOutboundMessages(state, { limit });
    }),
    markOutboundMessage: async (messageId, status, error) => updateState(store, (state) => {
      const existing = state.outboundMessages?.find((message) => message.id === messageId);
      if (!existing) return undefined;
      return status === "sent"
        ? markOutboundMessageSent(state, messageId)
        : markOutboundMessageFailed(state, messageId, error ?? "发送失败");
    }),
    listWechatOrderLogs: async () => []
  };
}

export function createMariaDbAppRepository(store: AutoAcceptanceStore = new MariaDbStateStore()): AppRepository {
  return {
    kind: "mariadb",
    runAutoAcceptance: (now) => store.runAutoAcceptance?.(now) ?? Promise.resolve(),
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
    claimOutboundMessages: (limit) => store.claimOutboundMessages(limit),
    markOutboundMessage: (messageId, status, error) => store.markOutboundMessage(messageId, status, error),
    listWechatOrderLogs: (limit = 100) => store.listWechatOrderLogs(limit)
  };
}

export function createAppRepository(env: NodeJS.ProcessEnv = process.env): AppRepository {
  const mode = resolveStorageMode(env);
  return mode === "file" ? createFileAppRepository() : createMariaDbAppRepository();
}

let repository: AppRepository | undefined;

export function getAppRepository() {
  repository ??= createAppRepository();
  return repository;
}

export function resetAppRepositoryForTests() {
  repository = undefined;
}
