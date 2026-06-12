import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import type { UserImportJob } from "@/lib/domain/user-import";
import { commitUserImport } from "@/lib/services/user-import-service";

const actor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "Root Admin",
  phone: "13700137000",
  groupId: "admin",
  groupName: "Administrators",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

function selectedJob(): UserImportJob {
  return {
    id: "import-job-1",
    type: "people",
    ownerAccountId: actor.accountId,
    sourceName: "users.xlsx",
    sourceHash: "a".repeat(64),
    previewVersion: "preview-1",
    status: "preview",
    createdAt: "2026-06-12T00:00:00.000Z",
    updatedAt: "2026-06-12T00:00:00.000Z",
    rows: [{
      id: "row-1",
      rowNumber: 2,
      raw: {},
      normalized: {
        name: "张三",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: false,
        enabled: true
      },
      errors: [],
      conflicts: [],
      allowedActions: ["add", "skip"],
      decision: {
        action: "add",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      }
    }]
  };
}

function repository(job: UserImportJob, stale = false) {
  return {
    loadUserImportJob: vi.fn(async () => job),
    applyUserImport: vi.fn(async () => ({
      job: stale
        ? {
            ...job,
            rows: job.rows.map((row) => ({
              ...row,
              conflicts: [...row.conflicts, "stale-preview"],
              resultMessage: "导入数据已变化，请重新处理冲突"
            }))
          }
        : { ...job, status: "completed" as const },
      stale
    }))
  } as unknown as AppRepository;
}

describe("user import commit service", () => {
  it("rejects the complete commit when repository revalidation finds a stale row", async () => {
    const job = selectedJob();
    const repo = repository(job, true);

    await expect(commitUserImport(repo, job.id, actor)).rejects.toThrow("导入数据已变化，请重新处理冲突");
    expect(repo.applyUserImport).toHaveBeenCalledWith(job.id, actor.accountId, actor);
  });

  it("commits every selected row through one repository atomic operation", async () => {
    const job = selectedJob();
    const repo = repository(job);

    const result = await commitUserImport(repo, job.id, actor);

    expect(result.status).toBe("completed");
    expect(repo.applyUserImport).toHaveBeenCalledTimes(1);
  });

  it("requires decisions for every valid row before commit", async () => {
    const job = selectedJob();
    job.rows[0].decision = undefined;
    const repo = repository(job);

    await expect(commitUserImport(repo, job.id, actor)).rejects.toThrow("请先为所有可处理行选择导入操作");
    expect(repo.applyUserImport).not.toHaveBeenCalled();
  });
});
