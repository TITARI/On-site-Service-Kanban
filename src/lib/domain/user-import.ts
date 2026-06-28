import { createHash, randomUUID } from "node:crypto";
import type {
  AuthenticatedActor,
  UserListItem
} from "./access-control";
import type { ChatIdentity, MessageChannel, UserGroup } from "./types";

export const TRUE_VALUES = new Set(["是", "启用", "true", "1"]);
export const FALSE_VALUES = new Set(["否", "停用", "false", "0"]);

export const USER_IMPORT_TEMPLATE_COLUMNS = [
  "姓名",
  "手机号",
  "分组",
  "分组锁定",
  "启用状态",
  "微信账号标识",
  "企微账号标识"
] as const;

export const STALE_IMPORT_MESSAGE =
  "\u5bfc\u5165\u6570\u636e\u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u5904\u7406\u51b2\u7a81";

export type UserImportTemplateColumn =
  typeof USER_IMPORT_TEMPLATE_COLUMNS[number];

export type UserImportRawRow = Record<string, unknown>;

export type NormalizedUserImportRow = {
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  enabled: boolean;
  wechatExternalUserId?: string;
  wecomExternalUserId?: string;
};

export type UserImportConflictCode =
  | "missing-name"
  | "invalid-phone"
  | "missing-group"
  | "unknown-group"
  | "disabled-group"
  | "invalid-group-locked"
  | "invalid-enabled"
  | "file-phone-duplicate"
  | "wechat-file-duplicate"
  | "wecom-file-duplicate"
  | "phone-occupied"
  | "wechat-occupied"
  | "wecom-occupied"
  | "stale-preview";

export type UserImportAction = "add" | "overwrite" | "skip";
export type UserImportCategory = "add" | "overwrite" | "blocked";

export type UserImportDecision =
  | {
      action: "add";
      confirmWechatRebind: boolean;
      confirmWecomRebind: boolean;
    }
  | {
      action: "overwrite";
      confirmWechatRebind: boolean;
      confirmWecomRebind: boolean;
    }
  | {
      action: "skip";
      confirmWechatRebind: false;
      confirmWecomRebind: false;
    };

export type UserImportPreviewInput = {
  sourceName: string;
  sourceHash: string;
  rows: UserImportRawRow[];
};

export type UserImportPreviewRow = {
  id: string;
  rowNumber: number;
  raw: Partial<Record<UserImportTemplateColumn, string>>;
  value?: NormalizedUserImportRow;
  conflicts: UserImportConflictCode[];
  allowedActions: UserImportAction[];
  category: UserImportCategory;
  selectable: boolean;
  decision?: UserImportDecision;
  baseline?: UserImportRowBaseline;
};

export type UserImportRowBaseline = {
  person?: {
    personId: string;
    version?: number;
    updatedAt: string;
  };
  group?: {
    groupId: string;
    enabled: boolean;
  };
  identities?: Partial<Record<MessageChannel, {
    identityId: string;
    personId?: string;
    updatedAt: string;
  }>>;
};

type UserImportIdentityBaseline =
  NonNullable<UserImportRowBaseline["identities"]>[MessageChannel];

export type UserImportPreviewSummary = {
  total: number;
  selectable: number;
  blocked: number;
};

export type UserImportPreview = {
  jobId: string;
  previewVersion: string;
  sourceName: string;
  sourceHash: string;
  rows: UserImportPreviewRow[];
  summary: UserImportPreviewSummary;
};

export type PersistedUserImportPreview = UserImportPreview & {
  ownerAccountId: string;
};

export type UserImportDecisionPatch = {
  rowId: string;
  decision: UserImportDecision;
};

export type UserImportCommitInput = {
  jobId: string;
  previewVersion: string;
  sourceName: string;
  sourceHash: string;
  rows: UserImportPreviewRow[];
};

export type UserImportCommitResult = {
  committed: number;
};

export type UserImportReportRow = {
  rowNumber: number;
  name: string;
  phone: string;
  action: UserImportAction | "blocked" | "";
  status: "success" | "skipped" | "failed" | "pending";
  message: string;
};

export class UserImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserImportValidationError";
  }
}

type UserImportPreviewRepository = {
  getConfig(): Promise<{ userGroups?: UserGroup[] }>;
  listUsers(query: {
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<{ users: UserListItem[]; total: number }>;
  identityByExternalId(
    platform: MessageChannel,
    externalUserId: string
  ): Promise<ChatIdentity | undefined>;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeName(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePhone(value: unknown) {
  const normalized = String(value ?? "").replace(/\D/g, "");
  return /^1[3-9]\d{9}$/.test(normalized) ? normalized : undefined;
}

function normalizeBoolean(
  value: unknown,
  fallback: boolean
): { value: boolean; valid: boolean } {
  const normalized = text(value);
  if (!normalized) return { value: fallback, valid: true };
  if (TRUE_VALUES.has(normalized)) return { value: true, valid: true };
  if (FALSE_VALUES.has(normalized)) return { value: false, valid: true };
  return { value: fallback, valid: false };
}

function groupFor(value: unknown, groups: UserGroup[]) {
  const normalized = text(value);
  if (!normalized) return { missing: true };
  const group = groups.find((item) =>
    item.id === normalized ||
    item.name === normalized
  );
  if (!group) return { unknown: true };
  if (!group.enabled) return { group, disabled: true };
  return { group };
}

export function supportedUserImportRaw(row: UserImportRawRow) {
  return Object.fromEntries(
    USER_IMPORT_TEMPLATE_COLUMNS
      .map((column) => [column, text(row[column])])
      .filter(([, value]) => value)
  ) as Partial<Record<UserImportTemplateColumn, string>>;
}

function uniqueConflicts(conflicts: UserImportConflictCode[]) {
  return [...new Set(conflicts)];
}

export function normalizeUserImportRow(
  raw: UserImportRawRow,
  groups: UserGroup[]
): {
  raw: Partial<Record<UserImportTemplateColumn, string>>;
  candidates: {
    phone?: string;
    wechatExternalUserId?: string;
    wecomExternalUserId?: string;
  };
  value?: NormalizedUserImportRow;
  conflicts: UserImportConflictCode[];
} {
  const conflicts: UserImportConflictCode[] = [];
  const name = normalizeName(raw["姓名"]);
  if (!name) conflicts.push("missing-name");

  const phone = normalizePhone(raw["手机号"]);
  if (!phone) conflicts.push("invalid-phone");

  const groupResult = groupFor(raw["分组"], groups);
  if (groupResult.missing) conflicts.push("missing-group");
  if (groupResult.unknown) conflicts.push("unknown-group");
  if (groupResult.disabled) conflicts.push("disabled-group");

  const groupLocked = normalizeBoolean(raw["分组锁定"], false);
  if (!groupLocked.valid) conflicts.push("invalid-group-locked");

  const enabled = normalizeBoolean(raw["启用状态"], true);
  if (!enabled.valid) conflicts.push("invalid-enabled");

  const wechatExternalUserId = text(raw["微信账号标识"]);
  const wecomExternalUserId = text(raw["企微账号标识"]);
  const valid =
    name &&
    phone &&
    groupResult.group &&
    !groupResult.disabled &&
    groupLocked.valid &&
    enabled.valid;

  return {
    raw: supportedUserImportRaw(raw),
    candidates: {
      ...(phone ? { phone } : {}),
      ...(wechatExternalUserId ? { wechatExternalUserId } : {}),
      ...(wecomExternalUserId ? { wecomExternalUserId } : {})
    },
    value: valid
      ? {
          name,
          phone,
          groupId: groupResult.group.id,
          groupLocked: groupLocked.value,
          enabled: enabled.value,
          ...(wechatExternalUserId ? { wechatExternalUserId } : {}),
          ...(wecomExternalUserId ? { wecomExternalUserId } : {})
        }
      : undefined,
    conflicts: uniqueConflicts(conflicts)
  };
}

export function canonicalSourceHash(input: UserImportPreviewInput) {
  const sourceHash = text(input.sourceHash).toLowerCase();
  if (/^[a-f0-9]{64}$/.test(sourceHash)) return sourceHash;
  throw new Error(
    "文件指纹必须是64位小写十六进制 SHA-256 摘要"
  );
}

function previewId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

function countBy<T>(values: T[]) {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

async function exactUserByPhone(
  repository: UserImportPreviewRepository,
  phone: string
) {
  const { users } = await repository.listUsers({
    search: phone,
    page: 1,
    pageSize: 10
  });
  return users.find((user) => user.phone === phone);
}

async function identityConflict(
  repository: UserImportPreviewRepository,
  platform: MessageChannel,
  externalUserId: string | undefined,
  targetUser: UserListItem | undefined
) {
  if (!externalUserId) return false;
  const identity = await repository.identityByExternalId(
    platform,
    externalUserId
  );
  return Boolean(
    identity?.personId &&
    identity.personId !== targetUser?.personId
  );
}

async function identityBaseline(
  repository: UserImportPreviewRepository,
  platform: MessageChannel,
  externalUserId: string | undefined
) {
  if (!externalUserId) return undefined;
  const identity = await repository.identityByExternalId(
    platform,
    externalUserId
  );
  if (!identity) return undefined;
  return {
    identityId: identity.id,
    ...(identity.personId ? { personId: identity.personId } : {}),
    updatedAt: identity.lastSeenAt
  };
}

function blockingConflicts(conflicts: UserImportConflictCode[]) {
  return conflicts.some((conflict) =>
    [
      "missing-name",
      "invalid-phone",
      "missing-group",
      "unknown-group",
      "disabled-group",
      "invalid-group-locked",
      "invalid-enabled",
      "file-phone-duplicate",
      "wechat-file-duplicate",
      "wecom-file-duplicate"
    ].includes(conflict)
  );
}

function allowedActions(
  conflicts: UserImportConflictCode[],
  existingUser: UserListItem | undefined
): UserImportAction[] {
  if (blockingConflicts(conflicts)) return ["skip"];
  return existingUser ? ["overwrite", "skip"] : ["add", "skip"];
}

function categoryFor(actions: UserImportAction[]): UserImportCategory {
  if (actions.includes("overwrite")) return "overwrite";
  if (actions.includes("add")) return "add";
  return "blocked";
}

export async function previewUserImport(
  repository: UserImportPreviewRepository,
  input: UserImportPreviewInput,
  _actor: AuthenticatedActor
): Promise<UserImportPreview> {
  const sourceName = text(input.sourceName);
  if (!sourceName) throw new Error("请提供导入文件名");
  if (!Array.isArray(input.rows)) throw new Error("导入行必须是数组");
  const sourceHash = canonicalSourceHash(input);
  const groups = (await repository.getConfig()).userGroups ?? [];
  const normalized = input.rows.map((row, index) => ({
    rowNumber: index + 1,
    ...normalizeUserImportRow(row, groups)
  }));
  const phoneCounts = countBy(
    normalized.flatMap((row) =>
      row.candidates.phone ? [row.candidates.phone] : []
    )
  );
  const wechatCounts = countBy(
    normalized.flatMap((row) =>
      row.candidates.wechatExternalUserId
        ? [row.candidates.wechatExternalUserId]
        : []
    )
  );
  const wecomCounts = countBy(
    normalized.flatMap((row) =>
      row.candidates.wecomExternalUserId
        ? [row.candidates.wecomExternalUserId]
        : []
    )
  );

  const rows: UserImportPreviewRow[] = [];
  for (const row of normalized) {
    const conflicts = [...row.conflicts];
    let existingUser: UserListItem | undefined;
    let wechatBaseline: UserImportIdentityBaseline | undefined;
    let wecomBaseline: UserImportIdentityBaseline | undefined;
    if (
      row.candidates.phone &&
      (phoneCounts.get(row.candidates.phone) ?? 0) > 1
    ) {
      conflicts.push("file-phone-duplicate");
    }
    if (
      row.candidates.wechatExternalUserId &&
      (wechatCounts.get(row.candidates.wechatExternalUserId) ?? 0) > 1
    ) {
      conflicts.push("wechat-file-duplicate");
    }
    if (
      row.candidates.wecomExternalUserId &&
      (wecomCounts.get(row.candidates.wecomExternalUserId) ?? 0) > 1
    ) {
      conflicts.push("wecom-file-duplicate");
    }
    if (row.value) {
      existingUser = await exactUserByPhone(repository, row.value.phone);
      if (existingUser) conflicts.push("phone-occupied");
      wechatBaseline = await identityBaseline(
        repository,
        "wechat",
        row.value.wechatExternalUserId
      );
      wecomBaseline = await identityBaseline(
        repository,
        "wecom",
        row.value.wecomExternalUserId
      );
      if (await identityConflict(
        repository,
        "wechat",
        row.value.wechatExternalUserId,
        existingUser
      )) {
        conflicts.push("wechat-occupied");
      }
      if (await identityConflict(
        repository,
        "wecom",
        row.value.wecomExternalUserId,
        existingUser
      )) {
        conflicts.push("wecom-occupied");
      }
    }

    const unique = uniqueConflicts(conflicts);
    const actions = allowedActions(unique, existingUser);
    const category = categoryFor(actions);
    const groupBaseline = row.value
      ? groups.find((group) => group.id === row.value?.groupId)
      : undefined;
    rows.push({
      id: previewId("import-row"),
      rowNumber: row.rowNumber,
      raw: row.raw,
      value: row.value,
      conflicts: unique,
      allowedActions: actions,
      category,
      selectable: actions.some((action) => action !== "skip"),
      baseline: {
        ...(existingUser ? {
          person: {
            personId: existingUser.personId,
            version: existingUser.version,
            updatedAt: existingUser.updatedAt
          }
        } : {}),
        ...(groupBaseline ? {
          group: {
            groupId: groupBaseline.id,
            enabled: groupBaseline.enabled
          }
        } : {}),
        ...(
          wechatBaseline || wecomBaseline
            ? {
                identities: {
                  ...(wechatBaseline ? { wechat: wechatBaseline } : {}),
                  ...(wecomBaseline ? { wecom: wecomBaseline } : {})
                }
              }
            : {}
        )
      }
    });
  }

  const selectable = rows.filter((row) => row.selectable).length;
  return {
    jobId: previewId("import"),
    previewVersion: createHash("sha256")
      .update(`${sourceHash}:${randomUUID()}`)
      .digest("base64url"),
    sourceName,
    sourceHash,
    rows,
    summary: {
      total: rows.length,
      selectable,
      blocked: rows.length - selectable
    }
  };
}

export function summarizeUserImportRows(rows: UserImportPreviewRow[]) {
  const selectable = rows.filter((row) => row.selectable).length;
  return {
    total: rows.length,
    selectable,
    blocked: rows.length - selectable
  };
}

export function assertValidUserImportDecision(
  row: UserImportPreviewRow,
  decisionInput: unknown
) {
  const decision = parseUserImportDecision(decisionInput);
  if (!row.selectable) {
    throw new Error("阻塞行不能保存导入处理方式");
  }
  if (!row.allowedActions.includes(decision.action)) {
    throw new Error("该导入行不允许使用当前处理方式");
  }
  if (
    decision.action === "skip" &&
    (decision.confirmWechatRebind || decision.confirmWecomRebind)
  ) {
    throw new Error("跳过行不能确认身份换绑");
  }
  if (
    row.conflicts.includes("wechat-occupied") &&
    decision.action !== "skip" &&
    decision.confirmWechatRebind !== true
  ) {
    throw new Error("需要确认微信身份换绑");
  }
  if (
    row.conflicts.includes("wecom-occupied") &&
    decision.action !== "skip" &&
    decision.confirmWecomRebind !== true
  ) {
    throw new Error("需要确认企业微信身份换绑");
  }
  return decision;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseUserImportDecision(input: unknown): UserImportDecision {
  if (!isObject(input)) {
    throw new UserImportValidationError(
      "导入行处理方式必须是对象"
    );
  }
  const {
    action,
    confirmWechatRebind,
    confirmWecomRebind
  } = input;
  if (
    action !== "add" &&
    action !== "overwrite" &&
    action !== "skip"
  ) {
    throw new UserImportValidationError(
      "导入行处理方式不允许"
    );
  }
  if (
    typeof confirmWechatRebind !== "boolean" ||
    typeof confirmWecomRebind !== "boolean"
  ) {
    throw new UserImportValidationError(
      "导入行确认项必须为布尔值"
    );
  }
  if (
    action === "skip" &&
    (confirmWechatRebind !== false || confirmWecomRebind !== false)
  ) {
    throw new UserImportValidationError(
      "跳过行的确认项必须关闭"
    );
  }
  return {
    action,
    confirmWechatRebind,
    confirmWecomRebind
  } as UserImportDecision;
}

export function parseUserImportDecisionPatches(
  input: unknown
): UserImportDecisionPatch[] {
  if (!Array.isArray(input)) {
    throw new UserImportValidationError("导入行处理方式必须是数组");
  }
  return input.map((item): UserImportDecisionPatch => {
    if (!isObject(item)) {
      throw new UserImportValidationError(
        "导入行处理方式更新必须是对象"
      );
    }
    const rowId = typeof item.rowId === "string" ? item.rowId.trim() : "";
    if (!rowId) {
      throw new UserImportValidationError(
        "缺少导入行ID"
      );
    }
    return {
      rowId,
      decision: parseUserImportDecision(item.decision)
    };
  });
}
