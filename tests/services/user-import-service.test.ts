import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedActor, UserListItem } from "@/lib/domain/access-control";
import type { UserImportPreview, UserImportPreviewRow } from "@/lib/domain/user-import";
import type { AppRepository } from "@/lib/repositories/app-repository";
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
    applyUserImport: vi.fn().mockResolvedValue(undefined)
  };
  return repo as unknown as AppRepository & {
    loadImportJob: ReturnType<typeof vi.fn>;
    currentUserVersion: ReturnType<typeof vi.fn>;
    identityByExternalId: ReturnType<typeof vi.fn>;
    applyUserImport: ReturnType<typeof vi.fn>;
  };
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
});
