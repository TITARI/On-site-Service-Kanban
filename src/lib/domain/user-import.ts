import type { UserGroup } from "./types";

export const USER_IMPORT_COLUMNS = [
  "姓名",
  "手机号",
  "分组",
  "分组锁定",
  "启用状态",
  "微信账号标识",
  "企微账号标识"
] as const;

export type UserImportNormalized = {
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  enabled: boolean;
  wechatExternalUserId?: string;
  wecomExternalUserId?: string;
};

export type UserImportAction = "add" | "overwrite" | "skip";

export type UserImportDecision = {
  action: UserImportAction;
  confirmWechatRebind: boolean;
  confirmWecomRebind: boolean;
};

export type UserImportSnapshot = {
  existingUser?: {
    personId: string;
    updatedAt: string;
  };
  wechatIdentity?: {
    id: string;
    personId?: string;
    lastSeenAt: string;
  };
  wecomIdentity?: {
    id: string;
    personId?: string;
    lastSeenAt: string;
  };
};

export type UserImportRow = {
  id: string;
  rowNumber: number;
  raw: Record<string, unknown>;
  normalized: UserImportNormalized;
  errors: string[];
  conflicts: string[];
  allowedActions: UserImportAction[];
  snapshot?: UserImportSnapshot;
  decision?: UserImportDecision;
  resultAction?: string;
  resultMessage?: string;
};

export type UserImportJob = {
  id: string;
  type: "people";
  ownerAccountId: string;
  sourceName: string;
  sourceHash: string;
  previewVersion: string;
  status: "preview" | "committing" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  rows: UserImportRow[];
};

export type UserImportApplyResult = {
  job: UserImportJob;
  stale: boolean;
};

type ParsedRow = Omit<UserImportRow, "id" | "conflicts" | "allowedActions">;

const TRUE_VALUES = new Set(["是", "启用", "true", "1"]);
const FALSE_VALUES = new Set(["否", "停用", "false", "0"]);

function text(row: Record<string, unknown>, key: typeof USER_IMPORT_COLUMNS[number]) {
  return String(row[key] ?? "").trim();
}

function booleanValue(
  value: string,
  defaultValue: boolean,
  errorCode: string,
  errors: string[]
) {
  if (!value) return defaultValue;
  const normalized = value.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  errors.push(errorCode);
  return defaultValue;
}

function duplicateValues(
  rows: ParsedRow[],
  valueOf: (row: ParsedRow) => string | undefined,
  errorCode: string
) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = valueOf(row);
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  for (const row of rows) {
    const value = valueOf(row);
    if (value && (counts.get(value) ?? 0) > 1 && !row.errors.includes(errorCode)) {
      row.errors.push(errorCode);
    }
  }
}

export function parseUserImportRows(
  inputRows: unknown[],
  groups: UserGroup[]
) {
  const rows = inputRows.map((value, index): ParsedRow => {
    const raw = value && typeof value === "object"
      ? value as Record<string, unknown>
      : {};
    const errors: string[] = [];
    const name = text(raw, "姓名");
    const phone = text(raw, "手机号").replace(/\D/g, "");
    const groupValue = text(raw, "分组");
    const group = groups.find((item) => item.id === groupValue || item.name === groupValue);
    if (!name) errors.push("missing-name");
    if (!/^1[3-9]\d{9}$/.test(phone)) errors.push("invalid-phone");
    if (!groupValue || !group) errors.push("unknown-group");
    else if (!group.enabled) errors.push("group-disabled");
    const groupLocked = booleanValue(
      text(raw, "分组锁定"),
      false,
      "invalid-group-locked",
      errors
    );
    const enabled = booleanValue(
      text(raw, "启用状态"),
      true,
      "invalid-enabled",
      errors
    );
    const wechatExternalUserId = text(raw, "微信账号标识") || undefined;
    const wecomExternalUserId = text(raw, "企微账号标识") || undefined;
    return {
      rowNumber: index + 2,
      raw,
      normalized: {
        name,
        phone,
        groupId: group?.id ?? "",
        groupLocked,
        enabled,
        ...(wechatExternalUserId ? { wechatExternalUserId } : {}),
        ...(wecomExternalUserId ? { wecomExternalUserId } : {})
      },
      errors
    };
  });

  duplicateValues(rows, (row) => row.normalized.phone || undefined, "file-phone-duplicate");
  duplicateValues(rows, (row) => row.normalized.wechatExternalUserId, "file-wechat-duplicate");
  duplicateValues(rows, (row) => row.normalized.wecomExternalUserId, "file-wecom-duplicate");
  return { rows };
}

export function isUserImportDecision(value: unknown): value is UserImportDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Partial<UserImportDecision>;
  return (
    (decision.action === "add" || decision.action === "overwrite" || decision.action === "skip")
    && typeof decision.confirmWechatRebind === "boolean"
    && typeof decision.confirmWecomRebind === "boolean"
    && (
      decision.action !== "skip"
      || (!decision.confirmWechatRebind && !decision.confirmWecomRebind)
    )
  );
}
