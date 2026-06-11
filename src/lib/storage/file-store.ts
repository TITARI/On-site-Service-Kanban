import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  BoothRecord,
  ChatIdentity,
  Conversation,
  InboundMessageRecord,
  OutboundMessage,
  PendingWorkOrderSession,
  Person,
  Ticket
} from "../domain/types";
import type {
  Account,
  AccountCredential,
  AccountRole,
  AccountSession,
  AuditLogEntry,
  AuthBootstrapState,
  Role,
  RolePermission
} from "../domain/access-control";
import { normalizeKeywordGroups } from "../domain/keyword-config";
import { defaultConfig, type AppConfig } from "../seed";
import { normalizeAutoAcceptanceConfig } from "../services/auto-acceptance-service";
import { normalizeWxautoMcpConfig, syncWxautoMcpMessageIntegration } from "../integrations/wxauto/config";

export type AppState = {
  booths: BoothRecord[];
  tickets: Ticket[];
  messageRecords: InboundMessageRecord[];
  people?: Person[];
  chatIdentities?: ChatIdentity[];
  conversations?: Conversation[];
  pendingWorkOrderSessions?: PendingWorkOrderSession[];
  outboundMessages?: OutboundMessage[];
  accounts?: Account[];
  accountCredentials?: AccountCredential[];
  roles?: Role[];
  accountRoles?: AccountRole[];
  rolePermissions?: RolePermission[];
  accountSessions?: AccountSession[];
  auditLogs?: AuditLogEntry[];
  authBootstrap?: AuthBootstrapState;
  config: AppConfig;
};

const dataDir = path.join(process.cwd(), "data");
const dataFile = path.join(dataDir, "app-state.json");
let writeQueue = Promise.resolve();
const REPLACE_RETRY_DELAYS_MS = [40, 80, 160, 320, 640];

function isNotFoundError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRetryableReplaceError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "EPERM" || error.code === "EACCES");
}

async function replaceStateFile(tempFile: string) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, dataFile);
      return;
    } catch (error) {
      const delayMs = REPLACE_RETRY_DELAYS_MS[attempt];
      if (!isRetryableReplaceError(error) || delayMs === undefined) throw error;
      await delay(delayMs);
    }
  }
}

export function initialState(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    accounts: [],
    accountCredentials: [],
    roles: [],
    accountRoles: [],
    rolePermissions: [],
    accountSessions: [],
    auditLogs: [],
    authBootstrap: {},
    config: defaultConfig()
  };
}

export function parseStoredState(raw: string): AppState {
  try {
    const parsed = JSON.parse(raw) as AppState;
    const defaults = defaultConfig();
    const parsedConfig: Partial<AppConfig> = parsed.config ?? {};
    const wxautoMcp = normalizeWxautoMcpConfig(parsedConfig.wxautoMcp, parsedConfig.messageIntegrations);
    const messageIntegrations = syncWxautoMcpMessageIntegration(
      parsedConfig.messageIntegrations?.length ? parsedConfig.messageIntegrations : defaults.messageIntegrations,
      wxautoMcp
    );
    return {
      ...parsed,
      messageRecords: parsed.messageRecords ?? [],
      people: parsed.people ?? [],
      chatIdentities: parsed.chatIdentities ?? [],
      conversations: parsed.conversations ?? [],
      pendingWorkOrderSessions: parsed.pendingWorkOrderSessions ?? [],
      outboundMessages: parsed.outboundMessages ?? [],
      accounts: parsed.accounts ?? [],
      accountCredentials: parsed.accountCredentials ?? [],
      roles: parsed.roles ?? [],
      accountRoles: parsed.accountRoles ?? [],
      rolePermissions: parsed.rolePermissions ?? [],
      accountSessions: parsed.accountSessions ?? [],
      auditLogs: parsed.auditLogs ?? [],
      authBootstrap: parsed.authBootstrap ?? {},
      config: {
        ...defaults,
        ...parsedConfig,
        messageIntegrations,
        wxautoMcp,
        userGroups: parsedConfig.userGroups?.length ? parsedConfig.userGroups : defaults.userGroups,
        keywordGroups: normalizeKeywordGroups(parsedConfig.keywordGroups?.length ? parsedConfig.keywordGroups : defaults.keywordGroups),
        autoAcceptance: normalizeAutoAcceptanceConfig(parsedConfig.autoAcceptance)
      }
    };
  } catch (error) {
    throw new Error(`状态文件损坏，已停止覆盖数据：${error instanceof Error ? error.message : "无法解析JSON"}`);
  }
}

async function readStateUnlocked(): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(dataFile, "utf-8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const state = initialState();
    await writeStateUnlocked(state);
    return state;
  }

  return parseStoredState(raw);
}

async function writeStateUnlocked(state: AppState) {
  await mkdir(dataDir, { recursive: true });
  const tempFile = path.join(dataDir, `app-state.${crypto.randomUUID()}.tmp`);
  await writeFile(tempFile, JSON.stringify(state, null, 2), "utf-8");
  await replaceStateFile(tempFile);
}

function enqueue<T>(operation: () => Promise<T>) {
  const queued = writeQueue.catch(() => undefined).then(operation);
  writeQueue = queued.then(() => undefined, () => undefined);
  return queued;
}

export async function readState(): Promise<AppState> {
  return enqueue(() => readStateUnlocked());
}

export async function writeState(state: AppState) {
  return enqueue(() => writeStateUnlocked(state));
}

export async function updateState<T>(operation: (state: AppState) => Promise<T> | T) {
  return enqueue(async () => {
    const state = await readStateUnlocked();
    const result = await operation(state);
    await writeStateUnlocked(state);
    return result;
  });
}
