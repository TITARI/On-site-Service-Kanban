import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedActor, UserListItem } from "@/lib/domain/access-control";
import type { AppState } from "@/lib/domain/app-state";
import type { UserImportPreview, UserImportPreviewRow } from "@/lib/domain/user-import";
import {
  USER_IMPORT_TEMPLATE_COLUMNS
} from "@/lib/domain/user-import";
import type { UserGroup } from "@/lib/domain/types";
import {
  createFileAppRepository,
  type AppRepository
} from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { commitUserImport } from "@/lib/services/user-import-service";

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

function selectedRow(
  id: string,
  phone: string,
  decision: UserImportPreviewRow["decision"] = {
    action: "add",
    confirmWechatRebind: false,
    confirmWecomRebind: false
  }
): UserImportPreviewRow {
  return {
    id,
    rowNumber: Number(id.replace(/\D/g, "")) || 1,
    raw: {},
    value: {
      name: `User ${id}`,
      phone,
      groupId: "builder",
      groupLocked: false,
      enabled: true
    },
    conflicts: [],
    allowedActions: ["add", "skip"],
    category: "add",
    selectable: true,
    decision
  };
}

function jobWithTwoSelectedRows(): UserImportPreview {
  return {
    jobId: "job-1",
    previewVersion: "preview-1",
    sourceName: "users.xlsx",
    sourceHash: "a".repeat(64),
    rows: [
      selectedRow("row-1", "13800138001"),
      selectedRow("row-2", "13800138002")
    ],
    summary: { total: 2, selectable: 2, blocked: 0 }
  };
}

function user(phone: string, updatedAt = "same"): UserListItem {
  return {
    personId: `person-${phone}`,
    accountId: `account-${phone}`,
    name: "Existing",
    phone,
    groupId: "builder",
    groupName: "Builder",
    groupLocked: false,
    enabled: true,
    permissions: ["ticket.claim"],
    hasPassword: false,
    identities: {},
    version: 0,
    updatedAt
  };
}

function repository() {
  const repo = {
    loadImportJob: vi.fn(),
    currentUserVersion: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({
      userGroups: [{
        id: "builder",
        name: "Builder",
        description: "",
        canClaim: true,
        canProcess: false,
        canAccept: false,
        canAdmin: false,
        enabled: true
      }]
    }),
    listUsers: vi.fn().mockResolvedValue({ users: [], total: 0 }),
    identityByExternalId: vi.fn().mockResolvedValue(undefined),
    applyUserImport: vi.fn().mockResolvedValue(undefined),
    markUserImportRowsStale: vi.fn().mockResolvedValue(undefined)
  };
  return repo as unknown as AppRepository & {
    loadImportJob: ReturnType<typeof vi.fn>;
    currentUserVersion: ReturnType<typeof vi.fn>;
    identityByExternalId: ReturnType<typeof vi.fn>;
    applyUserImport: ReturnType<typeof vi.fn>;
    markUserImportRowsStale: ReturnType<typeof vi.fn>;
  };
}

const [
  NAME_COLUMN,
  PHONE_COLUMN,
  GROUP_COLUMN,
  GROUP_LOCKED_COLUMN,
  ENABLED_COLUMN,
  WECHAT_COLUMN
] = USER_IMPORT_TEMPLATE_COLUMNS;

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "Builder",
    description: "",
    canClaim: true,
    canProcess: false,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "business",
    name: "Business",
    description: "",
    canClaim: false,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }
];

function importState(): AppState {
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
    authBootstrap: null,
    userImportJobs: [],
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
    },
    mutate: (operation: (state: AppState) => void) => {
      operation(current);
    },
    snapshot: () => structuredClone(current)
  };
}

async function previewOverwrite(
  repository: AppRepository,
  actor: AuthenticatedActor
) {
  const preview = await repository.saveUserImportPreview({
    sourceName: "users.xlsx",
    sourceHash: "b".repeat(64),
    rows: [{
      [NAME_COLUMN]: "Updated User",
      [PHONE_COLUMN]: "13800138000",
      [GROUP_COLUMN]: "Business",
      [GROUP_LOCKED_COLUMN]: "true",
      [ENABLED_COLUMN]: "true"
    }]
  }, actor);
  await repository.saveUserImportDecisions(preview.jobId, [{
    rowId: preview.rows[0].id,
    decision: {
      action: "overwrite",
      confirmWechatRebind: false,
      confirmWecomRebind: false
    }
  }], actor);
  return preview;
}

describe("commitUserImport", () => {
  it("rejects complete commit when one selected row changed after preview", async () => {
    const repo = repository();
    repo.loadImportJob.mockResolvedValue(jobWithTwoSelectedRows());
    repo.currentUserVersion
      .mockResolvedValueOnce("same")
      .mockResolvedValueOnce("changed");

    await expect(
      commitUserImport(repo, "job-1", adminActor())
    ).rejects.toThrow("导入数据已变化，请重新处理冲突");

    expect(repo.applyUserImport).not.toHaveBeenCalled();
    expect(repo.markUserImportRowsStale).toHaveBeenCalledWith(
      "job-1",
      ["row-2"],
      expect.anything()
    );
  });

  it("commits all selected rows in one repository transaction", async () => {
    const repo = repository();
    repo.loadImportJob.mockResolvedValue(jobWithTwoSelectedRows());
    repo.currentUserVersion.mockResolvedValue("same");

    await commitUserImport(repo, "job-1", adminActor());

    expect(repo.applyUserImport).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        rows: expect.arrayContaining([
          expect.objectContaining({
            decision: { action: "add", confirmWechatRebind: false, confirmWecomRebind: false }
          })
        ])
      }),
      expect.anything()
    );
  });

  it("requires explicit identity rebind confirmations during commit revalidation", async () => {
    const repo = repository();
    const job = jobWithTwoSelectedRows();
    job.rows = [{
      ...selectedRow("row-1", "13800138001", {
        action: "add",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      }),
      value: {
        ...selectedRow("row-1", "13800138001").value!,
        wechatExternalUserId: "wxid-occupied"
      },
      conflicts: ["wechat-occupied"]
    }];
    repo.loadImportJob.mockResolvedValue(job);
    repo.currentUserVersion.mockResolvedValue("same");
    repo.identityByExternalId.mockResolvedValue({
      id: "chat-occupied",
      platform: "wechat",
      externalUserId: "wxid-occupied",
      displayName: "Occupied",
      personId: "person-other",
      firstSeenAt: "2026-06-15T00:00:00.000Z",
      lastSeenAt: "2026-06-15T00:00:00.000Z"
    });

    await expect(
      commitUserImport(repo, "job-1", adminActor())
    ).rejects.toThrow("导入数据已变化，请重新处理冲突");

    expect(repo.applyUserImport).not.toHaveBeenCalled();
  });

  it("overwrites a real unchanged existing user using the preview-time person baseline", async () => {
    const store = memoryStore();
    const repo = createFileAppRepository(store);
    const actor = adminActor();
    const existing = await repo.createUser({
      name: "Existing User",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor);
    const preview = await previewOverwrite(repo, actor);

    await expect(commitUserImport(repo, preview.jobId, actor)).resolves.toEqual({
      committed: 1
    });

    await expect(repo.getUser(existing.personId)).resolves.toMatchObject({
      name: "Updated User",
      groupId: "business",
      groupLocked: true
    });
  });

  it("rejects a changed existing user against the preview baseline and persists stale row conflicts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
    try {
      const store = memoryStore();
      const repo = createFileAppRepository(store);
      const actor = adminActor();
      const existing = await repo.createUser({
        name: "Existing User",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: false,
        enabled: true
      }, actor);
      const preview = await previewOverwrite(repo, actor);

      await repo.updateUser(existing.personId, { name: "Changed Elsewhere" }, actor);
      await expect(repo.getUser(existing.personId)).resolves.toMatchObject({
        updatedAt: existing.updatedAt
      });

      await expect(commitUserImport(repo, preview.jobId, actor)).rejects.toThrow(
        "导入数据已变化，请重新处理冲突"
      );
      const saved = await repo.getUserImportJobRows(preview.jobId, actor);
      expect(saved.rows[0]).toMatchObject({
        category: "blocked",
        allowedActions: ["skip"],
        conflicts: expect.arrayContaining(["stale-preview"])
      });
      await expect(repo.getUser(existing.personId)).resolves.toMatchObject({
        name: "Changed Elsewhere",
        groupId: "builder"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a confirmed identity rebind when the identity owner version changed after preview", async () => {
    const store = memoryStore();
    const repo = createFileAppRepository(store);
    const actor = adminActor();
    const owner = await repo.createUser({
      name: "Identity Owner",
      phone: "13900139000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    }, actor);
    await repo.bindChatIdentity({
      userId: owner.personId,
      platform: "wechat",
      externalUserId: "wxid-occupied",
      displayName: "Occupied",
      confirmedRebind: false
    }, actor);
    const preview = await repo.saveUserImportPreview({
      sourceName: "users.xlsx",
      sourceHash: "c".repeat(64),
      rows: [{
        [NAME_COLUMN]: "New User",
        [PHONE_COLUMN]: "13800138001",
        [GROUP_COLUMN]: "Builder",
        [GROUP_LOCKED_COLUMN]: "false",
        [ENABLED_COLUMN]: "true",
        [WECHAT_COLUMN]: "wxid-occupied"
      }]
    }, actor);
    await repo.saveUserImportDecisions(preview.jobId, [{
      rowId: preview.rows[0].id,
      decision: {
        action: "add",
        confirmWechatRebind: true,
        confirmWecomRebind: false
      }
    }], actor);
    store.mutate((state) => {
      const identity = state.chatIdentities?.find(
        (item) => item.externalUserId === "wxid-occupied"
      );
      if (identity) {
        identity.lastSeenAt = "2099-01-01T00:00:00.000Z";
      }
    });

    await expect(commitUserImport(repo, preview.jobId, actor)).rejects.toThrow(
      "导入数据已变化，请重新处理冲突"
    );
    const saved = await repo.getUserImportJobRows(preview.jobId, actor);
    expect(saved.rows[0]).toMatchObject({
      category: "blocked",
      allowedActions: ["skip"],
      conflicts: expect.arrayContaining(["stale-preview"])
    });
    await expect(repo.identityByExternalId("wechat", "wxid-occupied")).resolves.toMatchObject({
      personId: owner.personId
    });
  });
});
