import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  getConfig: vi.fn(),
  listUsers: vi.fn(),
  identityByExternalId: vi.fn(),
  saveUserImportPreview: vi.fn(),
  loadUserImportJob: vi.fn(),
  updateUserImportDecisions: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => store as unknown as AppRepository
}));

const previewRoute = await import("@/app/api/admin/user-imports/preview/route");
const rowsRoute = await import("@/app/api/admin/user-imports/[jobId]/rows/route");

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

const existingUser = {
  personId: "person-existing",
  accountId: "account-existing",
  name: "现有张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  groupLocked: false,
  enabled: true,
  permissions: [],
  hasPassword: false,
  identities: {},
  updatedAt: "2026-06-11T00:00:00.000Z"
};

function request(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `board_admin_session=${"A".repeat(43)}`
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  Object.values(store).forEach((mock) => mock.mockReset());
  store.resolveAccountSession.mockResolvedValue({
    actor,
    session: {
      id: "session-admin",
      accountId: actor.accountId,
      sessionType: "admin",
      tokenHash: "stored-hash",
      authVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastSeenAt: "2026-06-12T00:00:00.000Z",
      createdAt: "2026-06-12T00:00:00.000Z"
    }
  });
  store.getConfig.mockResolvedValue({
    ...defaultConfig(),
    userGroups: [{
      id: "builder",
      name: "搭建组",
      description: "",
      canClaim: true,
      canProcess: true,
      canAccept: false,
      canAdmin: false,
      enabled: true
    }]
  });
  store.listUsers.mockImplementation(async (query: { search?: string }) => ({
    users: query.search === "13800138000" ? [existingUser] : [],
    total: query.search === "13800138000" ? 1 : 0
  }));
  store.identityByExternalId.mockImplementation(async (platform: string, externalUserId: string) => (
    platform === "wechat" && externalUserId === "wxid-occupied"
      ? {
          id: "identity-occupied",
          platform: "wechat",
          externalUserId,
          displayName: "李四微信",
          isTemporary: false,
          personId: "person-other",
          personName: "李四",
          personPhone: "13900139000",
          firstSeenAt: "2026-06-10T00:00:00.000Z",
          lastSeenAt: "2026-06-12T00:00:00.000Z"
        }
      : undefined
  ));
  store.saveUserImportPreview.mockImplementation(async (job) => job);
  store.updateUserImportDecisions.mockImplementation(async (_jobId, _ownerId, decisions) => ({
    ...store.loadUserImportJob.mock.results.at(-1)?.value,
    decisions
  }));
});

describe("admin user import routes", () => {
  it("previews rows, existing phones, and occupied identities without mutating users", async () => {
    const response = await previewRoute.POST(request(
      "http://localhost/api/admin/user-imports/preview",
      {
        sourceName: "users.xlsx",
        sourceHash: "a".repeat(64),
        rows: [
          {
            姓名: "张三",
            手机号: "13800138000",
            分组: "搭建组",
            分组锁定: "是",
            启用状态: "启用",
            微信账号标识: "wxid-occupied"
          },
          {
            姓名: "重复张三",
            手机号: "13800138000",
            分组: "搭建组",
            分组锁定: "否",
            启用状态: "启用"
          }
        ]
      }
    ));

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conflicts: expect.arrayContaining(["phone-exists", "wechat-occupied"]),
        errors: expect.arrayContaining(["file-phone-duplicate"])
      })
    ]));
    expect(store.saveUserImportPreview).toHaveBeenCalledWith(expect.objectContaining({
      type: "people",
      ownerAccountId: actor.accountId,
      status: "preview"
    }));
    expect(store.updateUser).toBeUndefined();
  });

  it("saves allowed row decisions only for the owning administrator", async () => {
    const job = {
      id: "import-job-1",
      type: "people",
      ownerAccountId: actor.accountId,
      sourceName: "users.xlsx",
      sourceHash: "b".repeat(64),
      previewVersion: "preview-1",
      status: "preview",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      rows: [{
        id: "row-1",
        rowNumber: 2,
        raw: {},
        normalized: {
          name: "王五",
          phone: "13700137001",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        },
        errors: [],
        conflicts: [],
        allowedActions: ["add", "skip"]
      }]
    };
    store.loadUserImportJob.mockResolvedValue(job);
    store.updateUserImportDecisions.mockResolvedValue({
      ...job,
      rows: [{
        ...job.rows[0],
        decision: {
          action: "add",
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }
      }]
    });

    const response = await rowsRoute.PATCH(request(
      "http://localhost/api/admin/user-imports/import-job-1/rows",
      {
        rows: [{
          rowId: "row-1",
          decision: {
            action: "add",
            confirmWechatRebind: false,
            confirmWecomRebind: false
          }
        }]
      },
      "PATCH"
    ), { params: Promise.resolve({ jobId: "import-job-1" }) });

    expect(response.status).toBe(200);
    expect(store.updateUserImportDecisions).toHaveBeenCalledWith(
      "import-job-1",
      actor.accountId,
      expect.any(Array)
    );
  });
});
