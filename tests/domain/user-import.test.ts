import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";
import {
  normalizeUserImportRow,
  previewUserImport
} from "@/lib/domain/user-import";
import { createFileAppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "搭建组",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }
];

function adminActor(): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin"
  };
}

function importState(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [
      {
        id: "person-occupied",
        name: "Occupied",
        phone: "13900139000",
        role: "handler",
        groupId: "builder",
        groupName: "搭建组",
        groupLocked: false,
        enabled: true,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z"
      }
    ],
    chatIdentities: [
      {
        id: "chat-wxid-occupied",
        platform: "wechat",
        externalUserId: "wxid-occupied",
        displayName: "Occupied WeChat",
        isTemporary: false,
        personId: "person-occupied",
        firstSeenAt: "2026-06-15T00:00:00.000Z",
        lastSeenAt: "2026-06-15T00:00:00.000Z"
      }
    ],
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
    authBootstrap: null,
    config: {
      ...defaultConfig(),
      userGroups: structuredClone(groups)
    }
  };
}

function memoryStore(initial = importState()) {
  let current = structuredClone(initial);
  return {
    readState: async () => structuredClone(current) as AppState,
    updateState: async <T>(operation: (state: AppState) => Promise<T> | T) => {
      const draft = structuredClone(current);
      const result = await operation(draft);
      current = draft;
      return result;
    }
  };
}

function importInputWithDuplicates() {
  return {
    sourceName: "users.xlsx",
    sourceHash: "a".repeat(64),
    rows: [
      {
        姓名: "张三",
        手机号: "13800138000",
        分组: "搭建组",
        分组锁定: "否",
        启用状态: "启用",
        微信账号标识: "wxid-occupied"
      },
      {
        姓名: "李四",
        手机号: "13800138000",
        分组: "搭建组",
        分组锁定: "否",
        启用状态: "启用"
      }
    ]
  };
}

describe("user import parsing and preview", () => {
  it("normalizes the seven supported template columns", () => {
    const normalized = normalizeUserImportRow({
      姓名: " 张三 ",
      手机号: "138 0013 8000",
      分组: "搭建组",
      分组锁定: "是",
      启用状态: "启用",
      微信账号标识: "wxid-zhang",
      企微账号标识: "wecom-zhang"
    }, groups);

    expect(normalized.value).toEqual({
      name: "张三",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: true,
      enabled: true,
      wechatExternalUserId: "wxid-zhang",
      wecomExternalUserId: "wecom-zhang"
    });
  });

  it("marks duplicate file phones and occupied chat identities", async () => {
    const repository = createFileAppRepository(memoryStore());

    const preview = await previewUserImport(
      repository,
      importInputWithDuplicates(),
      adminActor()
    );

    expect(preview.rows.map((row) => row.conflicts)).toEqual([
      expect.arrayContaining(["file-phone-duplicate", "wechat-occupied"]),
      expect.arrayContaining(["file-phone-duplicate"])
    ]);
    expect(preview.rows.every((row) => !row.selectable)).toBe(true);
  });
});
