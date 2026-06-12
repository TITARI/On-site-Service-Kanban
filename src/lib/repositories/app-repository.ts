import type { AppState } from "../domain/app-state";
import type { KeywordGroup, MessageChannel, Ticket, UserGroup } from "../domain/types";
import type {
  AccountSession,
  AdminLoginRecord,
  AuthenticatedActor,
  BootstrapAdminInput,
  BootstrapAdminSessionInput,
  ChatIdentityBindingMutation,
  ManagedChatIdentity,
  MobileAccountInput,
  SessionResolution,
  SessionType,
  UserDeletionHistory,
  UserListItem,
  UserMutation,
  UserQuery
} from "../domain/access-control";
import { toTicketSummary, type TicketSummary } from "../domain/ticket-summary";
import type {
  UserImportApplyResult,
  UserImportDecision,
  UserImportJob
} from "../domain/user-import";
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
import {
  readState as readJsonState,
  updateState as updateJsonState,
  writeState as writeJsonState
} from "../storage/file-store";
import { hashPassword } from "../services/password-service";
import {
  adminLoginRecordFromState,
  applyUserImportInState,
  assertUsableAdminAfterGroupChange,
  bootstrapAdminInState,
  bootstrapStatusFromState,
  bindChatIdentityInState,
  createAccountSessionInState,
  createUserInState,
  deleteUserInState,
  getUserFromState,
  getChatIdentityFromState,
  identityByExternalIdFromState,
  listChatIdentitiesFromState,
  listUsersFromState,
  normalizeAccessState,
  recordAdminLoginFailureInState,
  recordAdminLoginSuccessInState,
  resolveAccountSessionInState,
  revokeAccountSessionInState,
  revokeAccountSessionsInState,
  setUserEnabledInState,
  setUserPasswordInState,
  syncAccessRolesInState,
  unbindChatIdentityInState,
  updateUserInState,
  upsertMobileAccountInState,
  usableAdminCountFromState,
  userDeletionHistoryFromState
} from "../services/access-state-service";

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
  upsertMobileAccount(input: MobileAccountInput): Promise<{ actor: AuthenticatedActor }>;
  createAccountSession(accountId: string, type: SessionType, tokenHash: string, expiresAt: string): Promise<AccountSession>;
  resolveAccountSession(tokenHash: string, type: SessionType): Promise<SessionResolution | undefined>;
  revokeAccountSession(tokenHash: string): Promise<void>;
  revokeAccountSessions(accountId: string): Promise<void>;
  adminLoginRecord(phone: string): Promise<AdminLoginRecord | undefined>;
  recordAdminLoginFailure(accountId: string, lockedUntil?: string): Promise<void>;
  recordAdminLoginSuccess(accountId: string): Promise<void>;
  bootstrapStatus(): Promise<{ required: boolean }>;
  bootstrapAdmin(
    input: BootstrapAdminInput,
    session?: BootstrapAdminSessionInput
  ): Promise<AuthenticatedActor>;
  listUsers(query: UserQuery): Promise<{ users: UserListItem[]; total: number }>;
  getUser(userId: string): Promise<UserListItem | undefined>;
  createUser(input: UserMutation, actor: AuthenticatedActor): Promise<UserListItem>;
  updateUser(userId: string, input: Partial<UserMutation>, actor: AuthenticatedActor): Promise<UserListItem>;
  setUserEnabled(userId: string, enabled: boolean, actor: AuthenticatedActor): Promise<UserListItem>;
  deleteUser(userId: string, actor: AuthenticatedActor): Promise<void>;
  setUserPassword(userId: string, passwordHash: string, actor: AuthenticatedActor): Promise<void>;
  userDeletionHistory(userId: string): Promise<UserDeletionHistory>;
  usableAdminCount(): Promise<number>;
  listChatIdentities(platform?: MessageChannel): Promise<ManagedChatIdentity[]>;
  getChatIdentity(identityId: string): Promise<ManagedChatIdentity | undefined>;
  identityByExternalId(platform: MessageChannel, externalUserId: string): Promise<ManagedChatIdentity | undefined>;
  bindChatIdentity(input: ChatIdentityBindingMutation, actor: AuthenticatedActor): Promise<UserListItem>;
  unbindChatIdentity(userId: string, platform: MessageChannel, actor: AuthenticatedActor): Promise<UserListItem>;
  saveUserImportPreview(job: UserImportJob): Promise<UserImportJob>;
  loadUserImportJob(jobId: string): Promise<UserImportJob | undefined>;
  updateUserImportDecisions(
    jobId: string,
    ownerAccountId: string,
    updates: Array<{ rowId: string; decision: UserImportDecision }>
  ): Promise<UserImportJob>;
  applyUserImport(
    jobId: string,
    ownerAccountId: string,
    actor: AuthenticatedActor
  ): Promise<UserImportApplyResult>;
  syncAccessRoles(userGroups: UserGroup[], actor?: AuthenticatedActor): Promise<void>;
};

type StateFileRepository = {
  readState(): Promise<AppState>;
  writeState(state: AppState): Promise<void>;
  updateState?<T>(operation: (state: AppState) => Promise<T> | T): Promise<T>;
};

type BootstrapAdminStoreInput = Pick<BootstrapAdminInput, "name" | "phone" | "group"> & {
  passwordHash: string;
};

type AccessRepositoryStore = Omit<Pick<AppRepository,
  | "upsertMobileAccount"
  | "createAccountSession"
  | "resolveAccountSession"
  | "revokeAccountSession"
  | "revokeAccountSessions"
  | "adminLoginRecord"
  | "recordAdminLoginFailure"
  | "recordAdminLoginSuccess"
  | "bootstrapStatus"
  | "listUsers"
  | "getUser"
  | "createUser"
  | "updateUser"
  | "setUserEnabled"
  | "deleteUser"
  | "setUserPassword"
  | "userDeletionHistory"
  | "usableAdminCount"
  | "listChatIdentities"
  | "getChatIdentity"
  | "identityByExternalId"
  | "bindChatIdentity"
  | "unbindChatIdentity"
  | "saveUserImportPreview"
  | "loadUserImportJob"
  | "updateUserImportDecisions"
  | "applyUserImport"
  | "syncAccessRoles"
>, "bootstrapAdmin"> & {
  bootstrapAdmin(
    input: BootstrapAdminStoreInput,
    session?: BootstrapAdminSessionInput
  ): Promise<AuthenticatedActor>;
};

type AutoAcceptanceStore = MariaDbStateStore & AccessRepositoryStore & {
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
  normalizeAccessState(state);
  return state as NormalizedAppState;
}

const fallbackUpdateQueues = new WeakMap<StateFileRepository, Promise<void>>();

function createStateUpdater(store: StateFileRepository) {
  if (store.updateState) {
    return <T>(operation: (state: AppState) => Promise<T> | T) => (
      store.updateState?.((state) => operation(stateCollections(state))) as Promise<T>
    );
  }

  return <T>(operation: (state: AppState) => Promise<T> | T) => {
    const previous = fallbackUpdateQueues.get(store) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const state = stateCollections(await store.readState());
      const result = await operation(state);
      await store.writeState(state);
      return result;
    });
    fallbackUpdateQueues.set(store, queued.then(() => undefined, () => undefined));
    return queued;
  };
}

export function createFileAppRepository(store: StateFileRepository = {
  readState: readJsonState,
  writeState: writeJsonState,
  updateState: updateJsonState
}): AppRepository {
  const updateState = createStateUpdater(store);
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
    saveConfig: async (config) => updateState((state) => {
      const userGroups = config.userGroups ?? state.config.userGroups ?? [];
      assertUsableAdminAfterGroupChange(state, userGroups);
      state.config = config;
      syncAccessRolesInState(state, userGroups);
      return state.config;
    }),
    saveKeywordGroups: async (keywordGroups) => updateState((state) => {
      state.config = {
        ...state.config,
        keywordGroups: normalizeKeywordGroups(keywordGroups)
      };
      return state.config.keywordGroups ?? [];
    }),
    importBooths: async (booths) => updateState((state) => {
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
    saveTicket: async (ticket, options = {}) => updateState((state) => {
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
    submitTicket: async (input) => updateState(async (state) => {
      return await createTicketService({ state }).submitTicket(input);
    }),
    processWechatMessage: async (input) => updateState(async (state) => {
      return await processWechatWatchtowerMessage(state, input);
    }),
    claimOutboundMessages: async (limit) => updateState((state) => {
      return claimPendingOutboundMessages(state, { limit });
    }),
    markOutboundMessage: async (messageId, status, error) => updateState((state) => {
      const existing = state.outboundMessages?.find((message) => message.id === messageId);
      if (!existing) return undefined;
      return status === "sent"
        ? markOutboundMessageSent(state, messageId)
        : markOutboundMessageFailed(state, messageId, error ?? "发送失败");
    }),
    listWechatOrderLogs: async () => [],
    upsertMobileAccount: (input) => updateState((state) => upsertMobileAccountInState(state, input)),
    createAccountSession: (accountId, type, tokenHash, expiresAt) => updateState((state) => (
      createAccountSessionInState(state, accountId, type, tokenHash, expiresAt)
    )),
    resolveAccountSession: async (tokenHash, type) => (
      resolveAccountSessionInState(await store.readState(), tokenHash, type)
    ),
    revokeAccountSession: (tokenHash) => updateState((state) => {
      revokeAccountSessionInState(state, tokenHash);
    }),
    revokeAccountSessions: (accountId) => updateState((state) => {
      revokeAccountSessionsInState(state, accountId);
    }),
    adminLoginRecord: async (phone) => adminLoginRecordFromState(await store.readState(), phone),
    recordAdminLoginFailure: (accountId, lockedUntil) => updateState((state) => {
      recordAdminLoginFailureInState(state, accountId, lockedUntil);
    }),
    recordAdminLoginSuccess: (accountId) => updateState((state) => {
      recordAdminLoginSuccessInState(state, accountId);
    }),
    bootstrapStatus: async () => bootstrapStatusFromState(await store.readState()),
    bootstrapAdmin: async (input, session) => {
      const passwordHash = await hashPassword(input.password);
      return updateState((state) => {
        const actor = bootstrapAdminInState(state, input, passwordHash);
        if (session) {
          createAccountSessionInState(
            state,
            actor.accountId,
            session.sessionType,
            session.tokenHash,
            session.expiresAt
          );
        }
        return actor;
      });
    },
    listUsers: async (query) => listUsersFromState(await store.readState(), query),
    getUser: async (userId) => getUserFromState(await store.readState(), userId),
    createUser: (input, actor) => updateState((state) => createUserInState(state, input, actor)),
    updateUser: (userId, input, actor) => updateState((state) => updateUserInState(state, userId, input, actor)),
    setUserEnabled: (userId, enabled, actor) => updateState((state) => (
      setUserEnabledInState(state, userId, enabled, actor)
    )),
    deleteUser: (userId, actor) => updateState((state) => {
      deleteUserInState(state, userId, actor);
    }),
    setUserPassword: (userId, passwordHash, actor) => updateState((state) => {
      setUserPasswordInState(state, userId, passwordHash, actor);
    }),
    userDeletionHistory: async (userId) => userDeletionHistoryFromState(await store.readState(), userId),
    usableAdminCount: async () => usableAdminCountFromState(await store.readState()),
    listChatIdentities: async (platform) => listChatIdentitiesFromState(await store.readState(), platform),
    getChatIdentity: async (identityId) => getChatIdentityFromState(await store.readState(), identityId),
    identityByExternalId: async (platform, externalUserId) => (
      identityByExternalIdFromState(await store.readState(), platform, externalUserId)
    ),
    bindChatIdentity: (input, actor) => updateState((state) => bindChatIdentityInState(state, input, actor)),
    unbindChatIdentity: (userId, platform, actor) => updateState((state) => (
      unbindChatIdentityInState(state, userId, platform, actor)
    )),
    saveUserImportPreview: (job) => updateState((state) => {
      state.userImportJobs ??= [];
      state.userImportJobs = state.userImportJobs.filter((item) => item.id !== job.id);
      state.userImportJobs.push(structuredClone(job));
      return structuredClone(job);
    }),
    loadUserImportJob: async (jobId) => {
      const state = await store.readState();
      const job = state.userImportJobs?.find((item) => item.id === jobId);
      return job ? structuredClone(job) : undefined;
    },
    updateUserImportDecisions: (jobId, ownerAccountId, updates) => updateState((state) => {
      const job = state.userImportJobs?.find((item) => item.id === jobId);
      if (!job || job.ownerAccountId !== ownerAccountId) throw new Error("导入预览不存在");
      if (job.status !== "preview") throw new Error("导入预览已不能修改");
      for (const update of updates) {
        const row = job.rows.find((item) => item.id === update.rowId);
        if (!row) throw new Error("导入行不存在");
        row.decision = structuredClone(update.decision);
      }
      job.updatedAt = new Date().toISOString();
      return structuredClone(job);
    }),
    applyUserImport: (jobId, ownerAccountId, actor) => updateState((state) => (
      applyUserImportInState(state, jobId, ownerAccountId, actor)
    )),
    syncAccessRoles: (userGroups, actor) => updateState((state) => {
      syncAccessRolesInState(state, userGroups, actor);
    })
  };
}

export function createMariaDbAppRepository(
  store: AutoAcceptanceStore = new MariaDbStateStore()
): AppRepository {
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
    listWechatOrderLogs: (limit = 100) => store.listWechatOrderLogs(limit),
    upsertMobileAccount: (input) => store.upsertMobileAccount(input),
    createAccountSession: (accountId, type, tokenHash, expiresAt) => store.createAccountSession(accountId, type, tokenHash, expiresAt),
    resolveAccountSession: (tokenHash, type) => store.resolveAccountSession(tokenHash, type),
    revokeAccountSession: (tokenHash) => store.revokeAccountSession(tokenHash),
    revokeAccountSessions: (accountId) => store.revokeAccountSessions(accountId),
    adminLoginRecord: (phone) => store.adminLoginRecord(phone),
    recordAdminLoginFailure: (accountId, lockedUntil) => store.recordAdminLoginFailure(accountId, lockedUntil),
    recordAdminLoginSuccess: (accountId) => store.recordAdminLoginSuccess(accountId),
    bootstrapStatus: () => store.bootstrapStatus(),
    bootstrapAdmin: async (input, session) => {
      const passwordHash = await hashPassword(input.password);
      const storeInput = {
        name: input.name,
        phone: input.phone,
        group: input.group,
        passwordHash
      };
      return session
        ? store.bootstrapAdmin(storeInput, session)
        : store.bootstrapAdmin(storeInput);
    },
    listUsers: (query) => store.listUsers(query),
    getUser: (userId) => store.getUser(userId),
    createUser: (input, actor) => store.createUser(input, actor),
    updateUser: (userId, input, actor) => store.updateUser(userId, input, actor),
    setUserEnabled: (userId, enabled, actor) => store.setUserEnabled(userId, enabled, actor),
    deleteUser: (userId, actor) => store.deleteUser(userId, actor),
    setUserPassword: (userId, passwordHash, actor) => store.setUserPassword(userId, passwordHash, actor),
    userDeletionHistory: (userId) => store.userDeletionHistory(userId),
    usableAdminCount: () => store.usableAdminCount(),
    listChatIdentities: (platform) => store.listChatIdentities(platform),
    getChatIdentity: (identityId) => store.getChatIdentity(identityId),
    identityByExternalId: (platform, externalUserId) => store.identityByExternalId(platform, externalUserId),
    bindChatIdentity: (input, actor) => store.bindChatIdentity(input, actor),
    unbindChatIdentity: (userId, platform, actor) => store.unbindChatIdentity(userId, platform, actor),
    saveUserImportPreview: (job) => store.saveUserImportPreview(job),
    loadUserImportJob: (jobId) => store.loadUserImportJob(jobId),
    updateUserImportDecisions: (jobId, ownerAccountId, updates) => (
      store.updateUserImportDecisions(jobId, ownerAccountId, updates)
    ),
    applyUserImport: (jobId, ownerAccountId, actor) => (
      store.applyUserImport(jobId, ownerAccountId, actor)
    ),
    syncAccessRoles: (userGroups, actor) => store.syncAccessRoles(userGroups, actor)
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
