import type { AppState } from "../domain/app-state";
import type { ChatIdentity, ChatIdentityRebindExpectation, KeywordGroup, MessageChannel, Ticket, UserGroup } from "../domain/types";
import type {
  UserImportCommitInput,
  UserImportCommitResult,
  UserImportConflictCode,
  UserImportDecisionPatch,
  UserImportPreview,
  UserImportPreviewInput,
  UserImportPreviewRow,
  UserImportReportRow
} from "../domain/user-import";
import {
  assertValidUserImportDecision,
  previewUserImport,
  summarizeUserImportRows
} from "../domain/user-import";
import type {
  AccountCredential,
  AccountSession,
  AuthenticatedActor,
  BootstrapAdminInput,
  MobileAccountInput,
  SessionResolution,
  SessionType,
  UserListItem,
  UserMutation,
  UserQuery
} from "../domain/access-control";
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
import {
  createFileRateLimiter,
  createMariaDbRateLimiter,
  type RateLimiter
} from "../services/rate-limiter";
import { normalizeKeywordGroups } from "../domain/keyword-config";
import {
  readState as readJsonState,
  updateState as updateJsonState
} from "../storage/file-store";
import { hashPassword } from "../services/password-service";
import {
  adminLoginRecordFromState,
  bootstrapAdminInState,
  bootstrapStatusFromState,
  bindChatIdentityInState,
  createAccountSessionInState,
  createUserInState,
  countUsableAdminsInState,
  deleteUserInState,
  getUserFromState,
  identityByExternalIdFromState,
  listChatIdentitiesFromState,
  listUsersFromState,
  normalizeAccessState,
  recordAdminLoginFailureInState,
  recordAdminLoginSuccessInState,
  resetExpiredAdminLockInState,
  resolveAccountSessionInState,
  revokeAccountSessionInState,
  revokeAccountSessionsInState,
  setUserEnabledInState,
  setUserPasswordInState,
  syncAccessRolesInState,
  syncAccessRolesWithoutAuditInState,
  unbindChatIdentityInState,
  updateUserInState,
  userDeletionHistoryInState,
  upsertMobileAccountInState
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

export type TicketActor = {
  personId: string;
  groupName: string;
  permissions: string[];
};

export function isTicketVisibleTo(
  ticket: { submitterId: string; handlerId?: string; assignmentGroup?: string },
  actor: TicketActor
) {
  return actor.permissions.includes("admin.access")
    || ticket.submitterId === actor.personId
    || ticket.handlerId === actor.personId
    || ticket.assignmentGroup === actor.groupName;
}

function visibleTickets<T extends { submitterId: string; handlerId?: string; assignmentGroup?: string }>(
  tickets: T[],
  actor?: TicketActor
) {
  return actor ? tickets.filter((ticket) => isTicketVisibleTo(ticket, actor)) : tickets;
}

export type AppRepository = {
  kind: StorageMode;
  getRateLimiter(): RateLimiter;
  runAutoAcceptance(now?: Date): Promise<void>;
  mobileBootstrap(): Promise<MobileBootstrapData>;
  adminBootstrap(): Promise<AdminBootstrapData>;
  getConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<AppConfig>;
  saveKeywordGroups(keywordGroups: KeywordGroup[]): Promise<KeywordGroup[]>;
  importBooths(booths: BoothRecord[]): Promise<BoothRecord[]>;
  listTicketSummaries(actor?: TicketActor): Promise<TicketSummary[]>;
  getTicket(ticketId: string, actor?: TicketActor): Promise<Ticket | undefined>;
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
  adminLoginRecord(phone: string): Promise<{ actor: AuthenticatedActor; credential: AccountCredential } | undefined>;
  recordAdminLoginFailure(accountId: string, lockedUntil?: string): Promise<void>;
  recordAdminLoginSuccess(accountId: string): Promise<void>;
  resetExpiredAdminLock(accountId: string): Promise<void>;
  bootstrapStatus(): Promise<{ required: boolean }>;
  bootstrapAdmin(input: BootstrapAdminInput): Promise<AuthenticatedActor>;
  bootstrapAdminWithSession(input: BootstrapAdminInput, tokenHash: string, expiresAt: string): Promise<{ actor: AuthenticatedActor; session: AccountSession }>;
  listUsers(query: UserQuery): Promise<{ users: UserListItem[]; total: number }>;
  getUser(userId: string): Promise<UserListItem | undefined>;
  createUser(input: UserMutation, actor: AuthenticatedActor): Promise<UserListItem>;
  updateUser(userId: string, input: Partial<UserMutation>, actor: AuthenticatedActor): Promise<UserListItem>;
  setUserEnabled(userId: string, enabled: boolean, actor: AuthenticatedActor): Promise<UserListItem>;
  deleteUser(userId: string, actor: AuthenticatedActor): Promise<void>;
  setUserPassword(userId: string, passwordHash: string, actor: AuthenticatedActor): Promise<void>;
  countUsableAdmins(excludeUserId?: string): Promise<number>;
  userDeletionHistory(userId: string): Promise<{ hasHistory: boolean; reasons: string[] }>;
  syncAccessRoles(userGroups: UserGroup[], actor?: AuthenticatedActor): Promise<void>;
  listChatIdentities(query: { platform?: MessageChannel; stableOnly?: boolean }): Promise<ChatIdentity[]>;
  identityByExternalId(platform: MessageChannel, externalUserId: string): Promise<ChatIdentity | undefined>;
  bindChatIdentity(input: {
    userId: string;
    platform: MessageChannel;
    externalUserId: string;
    displayName?: string;
    confirmedRebind?: boolean;
    expectedRebind?: ChatIdentityRebindExpectation;
  }, actor: AuthenticatedActor): Promise<ChatIdentity>;
  unbindChatIdentity(input: {
    userId: string;
    platform: MessageChannel;
  }, actor: AuthenticatedActor): Promise<void>;
  saveUserImportPreview(input: UserImportPreviewInput, actor: AuthenticatedActor): Promise<UserImportPreview>;
  getUserImportJobRows(jobId: string, actor: AuthenticatedActor): Promise<UserImportPreview>;
  saveUserImportDecisions(jobId: string, decisions: UserImportDecisionPatch[], actor: AuthenticatedActor): Promise<void>;
  markUserImportRowsStale(jobId: string, rowIds: string[], actor: AuthenticatedActor): Promise<void>;
  loadImportJob(jobId: string, actor: AuthenticatedActor): Promise<UserImportPreview>;
  currentUserVersion(row: UserImportPreview["rows"][number], actor: AuthenticatedActor): Promise<string | undefined>;
  applyUserImport(input: UserImportCommitInput, actor: AuthenticatedActor): Promise<UserImportCommitResult>;
  userImportReport(jobId: string, actor: AuthenticatedActor): Promise<UserImportReportRow[]>;
};

type StateFileRepository = {
  readState(): Promise<AppState>;
  updateState<T>(operation: (state: AppState) => Promise<T> | T): Promise<T>;
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
  userImportJobs: NonNullable<AppState["userImportJobs"]>;
};

function stateCollections(state: AppState): NormalizedAppState {
  state.messageRecords ??= [];
  state.people ??= [];
  state.chatIdentities ??= [];
  state.conversations ??= [];
  state.pendingWorkOrderSessions ??= [];
  state.outboundMessages ??= [];
  state.userImportJobs ??= [];
  normalizeAccessState(state);
  return state as NormalizedAppState;
}

function userImportPreviewFromJob(
  job: NonNullable<AppState["userImportJobs"]>[number]
): UserImportPreview {
  return {
    jobId: job.jobId,
    previewVersion: job.previewVersion,
    sourceName: job.sourceName,
    sourceHash: job.sourceHash,
    rows: job.rows.map((row) => ({ ...row })),
    summary: job.summary
  };
}

function userImportReportFromJob(
  job: NonNullable<AppState["userImportJobs"]>[number]
): UserImportReportRow[] {
  return job.rows.map((row) => {
    const stale = row.conflicts.includes("stale-preview");
    return {
      rowNumber: row.rowNumber,
      name: row.value?.name ?? Object.values(row.raw)[0] ?? "",
      phone: row.value?.phone ?? "",
      action: stale
        ? "blocked"
        : row.decision?.action ?? (row.selectable ? "" : "blocked"),
      status: stale
        ? "failed"
        : row.decision?.action === "skip"
          ? "skipped"
          : row.decision
            ? "success"
            : row.selectable
              ? "pending"
              : "failed",
      message: stale
        ? row.conflicts.join(", ")
        : row.decision?.action === "skip"
          ? "已跳过"
          : row.decision
            ? "导入成功"
            : row.conflicts.length
              ? row.conflicts.join(", ")
              : "待处理"
    };
  });
}

function markImportRowsStale(
  job: NonNullable<AppState["userImportJobs"]>[number],
  rowIds: string[]
) {
  const staleIds = new Set(rowIds);
  for (const row of job.rows) {
    if (!staleIds.has(row.id)) continue;
    const conflicts = new Set<UserImportConflictCode>(row.conflicts);
    conflicts.add("stale-preview");
    row.conflicts = [...conflicts];
    row.allowedActions = ["skip"];
    row.category = "blocked";
    row.selectable = false;
    row.decision = {
      action: "skip",
      confirmWechatRebind: false,
      confirmWecomRebind: false
    };
  }
  job.summary = summarizeUserImportRows(job.rows);
}

function expectedImportRebind(
  row: UserImportPreviewRow,
  platform: MessageChannel,
  toPersonId: string
) {
  const baseline = row.baseline?.identities?.[platform];
  const confirmed = platform === "wechat"
    ? row.decision?.confirmWechatRebind
    : row.decision?.confirmWecomRebind;
  if (!baseline || !confirmed) return undefined;
  return {
    platform,
    identityId: baseline.identityId,
    fromPersonId: baseline.personId ?? "",
    toPersonId
  };
}

function createStateUpdater(store: StateFileRepository) {
  if (typeof store.updateState !== "function") {
    throw new Error(
      "Atomic updateState is required for the file app repository"
    );
  }

  return <T>(operation: (state: AppState) => Promise<T> | T) => (
    store.updateState((state) =>
      operation(stateCollections(state))
    )
  );
}

export function createFileAppRepository(
  store: StateFileRepository = {
    readState: readJsonState,
    updateState: updateJsonState
  },
  rateLimiter: RateLimiter = createFileRateLimiter()
): AppRepository {
  const updateState = createStateUpdater(store);
  return {
    kind: "file",
    getRateLimiter: () => rateLimiter,
    runAutoAcceptance: (now = new Date()) => updateState((state) => {
      runAutoAcceptanceForState(state, { now: now.toISOString() });
    }),
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
      state.config = config;
      syncAccessRolesWithoutAuditInState(state, config.userGroups ?? []);
      return config;
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
    listTicketSummaries: async (actor) => {
      const state = await store.readState();
      return visibleTickets(state.tickets, actor).map(toTicketSummary);
    },
    getTicket: async (ticketId, actor) => {
      const state = await store.readState();
      const ticket = state.tickets.find((item) => item.id === ticketId);
      return ticket && (!actor || isTicketVisibleTo(ticket, actor)) ? ticket : undefined;
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
    upsertMobileAccount: (input) => updateState((state) => (
      upsertMobileAccountInState(state, input)
    )),
    createAccountSession: (accountId, type, tokenHash, expiresAt) => (
      updateState((state) => createAccountSessionInState(
        state,
        accountId,
        type,
        tokenHash,
        expiresAt
      ))
    ),
    resolveAccountSession: async (tokenHash, type) => (
      resolveAccountSessionInState(
        await store.readState(),
        tokenHash,
        type
      )
    ),
    revokeAccountSession: (tokenHash) => updateState((state) => {
      revokeAccountSessionInState(state, tokenHash);
    }),
    revokeAccountSessions: (accountId) => updateState((state) => {
      revokeAccountSessionsInState(state, accountId);
    }),
    adminLoginRecord: async (phone) => (
      adminLoginRecordFromState(await store.readState(), phone)
    ),
    recordAdminLoginFailure: (accountId, lockedUntil) => (
      updateState((state) => {
        recordAdminLoginFailureInState(state, accountId, lockedUntil);
      })
    ),
    recordAdminLoginSuccess: (accountId) => updateState((state) => {
      recordAdminLoginSuccessInState(state, accountId);
    }),
    resetExpiredAdminLock: (accountId) => updateState((state) => {
      resetExpiredAdminLockInState(state, accountId);
    }),
    bootstrapStatus: async () => (
      bootstrapStatusFromState(await store.readState())
    ),
    bootstrapAdmin: async (input) => {
      if (!input.legacyPassword.trim()) {
        throw new Error("Legacy password is required");
      }
      const passwordHash = await hashPassword(input.password);
      return updateState((state) => (
        bootstrapAdminInState(state, input, passwordHash)
      ));
    },
    bootstrapAdminWithSession: async (input, tokenHash, expiresAt) => {
      if (!input.legacyPassword.trim()) {
        throw new Error("Legacy password is required");
      }
      const passwordHash = await hashPassword(input.password);
      return updateState((state) => {
        const actor = bootstrapAdminInState(state, input, passwordHash);
        const session = createAccountSessionInState(
          state,
          actor.accountId,
          "admin",
          tokenHash,
          expiresAt
        );
        return { actor, session };
      });
    },
    listUsers: async (query) => (
      listUsersFromState(await store.readState(), query)
    ),
    getUser: async (userId) => (
      getUserFromState(await store.readState(), userId)
    ),
    createUser: (input, actor) => updateState((state) => (
      createUserInState(state, input, actor)
    )),
    updateUser: (userId, input, actor) => updateState((state) => (
      updateUserInState(state, userId, input, actor)
    )),
    setUserEnabled: (userId, enabled, actor) => updateState((state) => (
      setUserEnabledInState(state, userId, enabled, actor)
    )),
    deleteUser: (userId, actor) => updateState((state) => {
      deleteUserInState(state, userId, actor);
    }),
    setUserPassword: (userId, passwordHash, actor) => (
      updateState((state) => {
        setUserPasswordInState(state, userId, passwordHash, actor);
      })
    ),
    countUsableAdmins: async (excludeUserId) => (
      countUsableAdminsInState(await store.readState(), excludeUserId)
    ),
    userDeletionHistory: async (userId) => (
      userDeletionHistoryInState(await store.readState(), userId)
    ),
    syncAccessRoles: (userGroups, actor) => updateState((state) => {
      syncAccessRolesInState(state, userGroups, actor);
    }),
    listChatIdentities: async (query) => (
      listChatIdentitiesFromState(await store.readState(), query)
    ),
    identityByExternalId: async (platform, externalUserId) => (
      identityByExternalIdFromState(
        await store.readState(),
        platform,
        externalUserId
      )
    ),
    bindChatIdentity: (input, actor) => updateState((state) => (
      bindChatIdentityInState(state, input, actor)
    )),
    unbindChatIdentity: (input, actor) => updateState((state) => {
      unbindChatIdentityInState(state, input, actor);
    }),
    saveUserImportPreview: (input, actor) => updateState(async (state) => {
      const stateRepository = createFileAppRepository({
        readState: async () => state,
        updateState: async (operation) => operation(state)
      });
      const preview = await previewUserImport(
        stateRepository,
        input,
        actor
      );
      const at = new Date().toISOString();
      state.userImportJobs ??= [];
      state.userImportJobs.push({
        ...preview,
        ownerAccountId: actor.accountId,
        createdAt: at,
        updatedAt: at
      });
      return preview;
    }),
    getUserImportJobRows: async (jobId, actor) => {
      const state = stateCollections(await store.readState());
      const job = state.userImportJobs.find((item) => item.jobId === jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      return userImportPreviewFromJob(job);
    },
    saveUserImportDecisions: (jobId, decisions, actor) => updateState((state) => {
      state.userImportJobs ??= [];
      const job = state.userImportJobs.find((item) => item.jobId === jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      const rowById = new Map(job.rows.map((row) => [row.id, row]));
      for (const patch of decisions) {
        const row = rowById.get(patch.rowId);
        if (!row) throw new Error("User import row was not found");
        row.decision = assertValidUserImportDecision(row, patch.decision);
      }
      job.updatedAt = new Date().toISOString();
    }),
    markUserImportRowsStale: (jobId, rowIds, actor) => updateState((state) => {
      state.userImportJobs ??= [];
      const job = state.userImportJobs.find((item) => item.jobId === jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      markImportRowsStale(job, rowIds);
      job.updatedAt = new Date().toISOString();
    }),
    loadImportJob: async (jobId, actor) => {
      const state = stateCollections(await store.readState());
      const job = state.userImportJobs.find((item) => item.jobId === jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      return userImportPreviewFromJob(job);
    },
    currentUserVersion: async (row) => {
      if (!row.value) return undefined;
      const { users } = await (createFileAppRepository({
        readState: store.readState,
        updateState: store.updateState
      })).listUsers({
        search: row.value.phone,
        page: 1,
        pageSize: 10
      });
      return users.find((user) => user.phone === row.value?.phone)?.updatedAt ?? "missing";
    },
    applyUserImport: (input, actor) => updateState((state) => {
      state.userImportJobs ??= [];
      const job = state.userImportJobs.find((item) => item.jobId === input.jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      let committed = 0;
      for (const row of input.rows) {
        if (!row.value || !row.decision || row.decision.action === "skip") {
          continue;
        }
        const existing = listUsersFromState(state, {
          search: row.value.phone,
          page: 1,
          pageSize: 10
        }).users.find((user) => user.phone === row.value?.phone);
        const mutation = {
          name: row.value.name,
          phone: row.value.phone,
          groupId: row.value.groupId,
          groupLocked: row.value.groupLocked,
          enabled: row.value.enabled
        };
        const user = existing
          ? updateUserInState(state, existing.personId, mutation, actor)
          : createUserInState(state, mutation, actor);
        if (row.value.wechatExternalUserId) {
          bindChatIdentityInState(state, {
            userId: user.personId,
            platform: "wechat",
            externalUserId: row.value.wechatExternalUserId,
            displayName: row.value.name,
            confirmedRebind: row.decision.confirmWechatRebind,
            expectedRebind: expectedImportRebind(row, "wechat", user.personId)
          }, actor);
        }
        if (row.value.wecomExternalUserId) {
          bindChatIdentityInState(state, {
            userId: user.personId,
            platform: "wecom",
            externalUserId: row.value.wecomExternalUserId,
            displayName: row.value.name,
            confirmedRebind: row.decision.confirmWecomRebind,
            expectedRebind: expectedImportRebind(row, "wecom", user.personId)
          }, actor);
        }
        const persisted = job.rows.find((item) => item.id === row.id);
        if (persisted) {
          persisted.decision = row.decision;
        }
        committed += 1;
      }
      const now = new Date().toISOString();
      job.updatedAt = now;
      job.completedAt = now;
      job.summary = summarizeUserImportRows(job.rows);
      state.auditLogs ??= [];
      state.auditLogs.push({
        id: `audit-user-import-${input.jobId}-${now}`,
        actorId: actor.accountId,
        actorName: actor.name,
        action: "user_import.commit",
        targetType: "import_job",
        targetId: input.jobId,
        detail: { committed, sourceName: input.sourceName },
        createdAt: now
      });
      return { committed };
    }),
    userImportReport: async (jobId, actor) => {
      const state = stateCollections(await store.readState());
      const job = state.userImportJobs.find((item) => item.jobId === jobId);
      if (!job || job.ownerAccountId !== actor.accountId) {
        throw new Error("User import preview job was not found");
      }
      return userImportReportFromJob(job);
    }
  };
}

export function createMariaDbAppRepository(
  store: AutoAcceptanceStore = new MariaDbStateStore(),
  rateLimiter: RateLimiter = createMariaDbRateLimiter()
): AppRepository {
  return {
    kind: "mariadb",
    getRateLimiter: () => rateLimiter,
    runAutoAcceptance: (now) => store.runAutoAcceptance?.(now) ?? Promise.resolve(),
    mobileBootstrap: () => store.mobileBootstrap(),
    adminBootstrap: () => store.adminBootstrap(),
    getConfig: () => store.getConfig(),
    saveConfig: (config) => store.saveConfig(config),
    saveKeywordGroups: (keywordGroups) => store.saveKeywordGroups(keywordGroups),
    importBooths: (booths) => store.importBooths(booths),
    listTicketSummaries: async (actor) => visibleTickets(await store.listTicketSummaries(), actor),
    getTicket: async (ticketId, actor) => {
      const ticket = await store.getTicket(ticketId);
      return ticket && (!actor || isTicketVisibleTo(ticket, actor)) ? ticket : undefined;
    },
    saveTicket: (ticket, options) => store.saveTicket(ticket, options),
    submitTicket: (input) => store.submitTicket(input),
    processWechatMessage: (input) => store.processWechatMessage(input),
    claimOutboundMessages: (limit) => store.claimOutboundMessages(limit),
    markOutboundMessage: (messageId, status, error) => store.markOutboundMessage(messageId, status, error),
    listWechatOrderLogs: (limit = 100) => store.listWechatOrderLogs(limit),
    upsertMobileAccount: (input) => store.upsertMobileAccount(input),
    createAccountSession: (accountId, type, tokenHash, expiresAt) => (
      store.createAccountSession(accountId, type, tokenHash, expiresAt)
    ),
    resolveAccountSession: (tokenHash, type) => (
      store.resolveAccountSession(tokenHash, type)
    ),
    revokeAccountSession: (tokenHash) => (
      store.revokeAccountSession(tokenHash)
    ),
    revokeAccountSessions: (accountId) => (
      store.revokeAccountSessions(accountId)
    ),
    adminLoginRecord: (phone) => store.adminLoginRecord(phone),
    recordAdminLoginFailure: (accountId, lockedUntil) => (
      store.recordAdminLoginFailure(accountId, lockedUntil)
    ),
    recordAdminLoginSuccess: (accountId) => (
      store.recordAdminLoginSuccess(accountId)
    ),
    resetExpiredAdminLock: (accountId) => (
      store.resetExpiredAdminLock(accountId)
    ),
    bootstrapStatus: () => store.bootstrapStatus(),
    bootstrapAdmin: (input) => store.bootstrapAdmin(input),
    bootstrapAdminWithSession: (input, tokenHash, expiresAt) => (
      store.bootstrapAdminWithSession(input, tokenHash, expiresAt)
    ),
    listUsers: (query) => store.listUsers(query),
    getUser: (userId) => store.getUser(userId),
    createUser: (input, actor) => store.createUser(input, actor),
    updateUser: (userId, input, actor) => (
      store.updateUser(userId, input, actor)
    ),
    setUserEnabled: (userId, enabled, actor) => (
      store.setUserEnabled(userId, enabled, actor)
    ),
    deleteUser: (userId, actor) => store.deleteUser(userId, actor),
    setUserPassword: (userId, passwordHash, actor) => (
      store.setUserPassword(userId, passwordHash, actor)
    ),
    countUsableAdmins: (excludeUserId) => (
      store.countUsableAdmins(excludeUserId)
    ),
    userDeletionHistory: (userId) => store.userDeletionHistory(userId),
    syncAccessRoles: (userGroups, actor) => (
      store.syncAccessRoles(userGroups, actor)
    ),
    listChatIdentities: (query) => store.listChatIdentities(query),
    identityByExternalId: (platform, externalUserId) => (
      store.identityByExternalId(platform, externalUserId)
    ),
    bindChatIdentity: (input, actor) => (
      store.bindChatIdentity(input, actor)
    ),
    unbindChatIdentity: (input, actor) => (
      store.unbindChatIdentity(input, actor)
    ),
    saveUserImportPreview: (input, actor) => (
      store.saveUserImportPreview(input, actor)
    ),
    getUserImportJobRows: (jobId, actor) => (
      store.getUserImportJobRows(jobId, actor)
    ),
    saveUserImportDecisions: (jobId, decisions, actor) => (
      store.saveUserImportDecisions(jobId, decisions, actor)
    ),
    markUserImportRowsStale: (jobId, rowIds, actor) => (
      store.markUserImportRowsStale(jobId, rowIds, actor)
    ),
    loadImportJob: (jobId, actor) => store.loadImportJob(jobId, actor),
    currentUserVersion: (row) => store.currentUserVersion(row),
    applyUserImport: (input, actor) => store.applyUserImport(input, actor),
    userImportReport: (jobId, actor) => store.userImportReport(jobId, actor)
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
