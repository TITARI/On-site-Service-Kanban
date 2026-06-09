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

export async function readState(): Promise<AppState> {
  let raw: string;
  try {
    raw = await readFile(dataFile, "utf-8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    const state = initialState();
    await writeState(state);
    return state;
  }

  return parseStoredState(raw);
}

export async function writeState(state: AppState) {
  const operation = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(dataDir, { recursive: true });
    const tempFile = path.join(dataDir, `app-state.${crypto.randomUUID()}.tmp`);
    await writeFile(tempFile, JSON.stringify(state, null, 2), "utf-8");
    await replaceStateFile(tempFile);
  });
  writeQueue = operation.catch(() => undefined);

  return operation;
}
