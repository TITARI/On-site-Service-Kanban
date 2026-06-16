import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSession,
  AuthenticatedActor
} from "@/lib/domain/access-control";
import type { UserImportDecision } from "@/lib/domain/user-import";
import type { AppRepository } from "@/lib/repositories/app-repository";
import {
  SESSION_COOKIE_NAMES,
  sessionTokenHash
} from "@/lib/services/session-service";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  saveUserImportPreview: vi.fn(),
  getUserImportJobRows: vi.fn(),
  saveUserImportDecisions: vi.fn(),
  loadImportJob: vi.fn(),
  currentUserVersion: vi.fn(),
  getConfig: vi.fn(),
  listUsers: vi.fn(),
  identityByExternalId: vi.fn(),
  applyUserImport: vi.fn(),
  userImportReport: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    resolveAccountSession: store.resolveAccountSession,
    saveUserImportPreview: store.saveUserImportPreview,
    getUserImportJobRows: store.getUserImportJobRows,
    saveUserImportDecisions: store.saveUserImportDecisions,
    loadImportJob: store.loadImportJob,
    currentUserVersion: store.currentUserVersion,
    getConfig: store.getConfig,
    listUsers: store.listUsers,
    identityByExternalId: store.identityByExternalId,
    applyUserImport: store.applyUserImport,
    userImportReport: store.userImportReport
  } as unknown as AppRepository)
}));

function actor(): AuthenticatedActor {
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

function session(tokenHash: string): AccountSession {
  return {
    id: "session-admin",
    accountId: "account-admin",
    sessionType: "admin",
    tokenHash,
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

const adminToken = Buffer.alloc(32, 7).toString("base64url");

function request(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      Cookie: `${SESSION_COOKIE_NAMES.admin}=${adminToken}`
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(store)) mock.mockReset();
  store.resolveAccountSession.mockResolvedValue({
    session: session(sessionTokenHash(adminToken)),
    actor: actor()
  });
  store.saveUserImportPreview.mockResolvedValue({
    jobId: "import-job-1",
    previewVersion: "preview-1",
    rows: [
      {
        id: "row-1",
        rowNumber: 1,
        raw: { 姓名: "张三" },
        value: {
          name: "张三",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        },
        conflicts: [],
        allowedActions: ["add"],
        category: "add",
        selectable: true
      }
    ],
    summary: { total: 1, selectable: 1, blocked: 0 }
  });
  store.getUserImportJobRows.mockResolvedValue({
    jobId: "import-job-1",
    previewVersion: "preview-1",
    rows: [
      {
        id: "row-1",
        rowNumber: 1,
        raw: { 姓名: "张三" },
        value: {
          name: "张三",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        },
        conflicts: [],
        allowedActions: ["add"],
        category: "add",
        selectable: true
      }
    ],
    summary: { total: 1, selectable: 1, blocked: 0 }
  });
  store.saveUserImportDecisions.mockResolvedValue(undefined);
  store.loadImportJob.mockResolvedValue({
    jobId: "import-job-1",
    previewVersion: "preview-1",
    sourceName: "users.xlsx",
    sourceHash: "a".repeat(64),
    rows: [
      {
        id: "row-1",
        rowNumber: 1,
        raw: { 濮撳悕: "寮犱笁" },
        value: {
          name: "寮犱笁",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        },
        conflicts: [],
        allowedActions: ["add"],
        category: "add",
        selectable: true,
        decision: {
          action: "add",
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }
      }
    ],
    summary: { total: 1, selectable: 1, blocked: 0 }
  });
  store.currentUserVersion.mockResolvedValue("same");
  store.getConfig.mockResolvedValue({
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
  });
  store.listUsers.mockResolvedValue({ users: [], total: 0 });
  store.identityByExternalId.mockResolvedValue(undefined);
  store.applyUserImport.mockResolvedValue({ committed: 1 });
  store.userImportReport.mockResolvedValue([
    {
      rowNumber: 1,
      name: "寮犱笁",
      phone: "13800138000",
      action: "add",
      status: "success",
      message: "导入成功"
    }
  ]);
});

describe("admin user import routes", () => {
  it("creates preview jobs from parsed rows and source hashes", async () => {
    const route = await import("@/app/api/admin/user-imports/preview/route");

    const response = await route.POST(request(
      "https://board.example/api/admin/user-imports/preview",
      "POST",
      {
        sourceName: "users.xlsx",
        sourceHash: "a".repeat(64),
        rows: [{ 姓名: "张三", 手机号: "13800138000", 分组: "搭建组" }]
      }
    ));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(store.saveUserImportPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceName: "users.xlsx",
        sourceHash: "a".repeat(64)
      }),
      actor()
    );
    expect(payload).toMatchObject({
      jobId: "import-job-1",
      rows: [expect.objectContaining({ rowNumber: 1, category: "add" })]
    });
  });

  it("lists preview rows and saves row decisions without committing users", async () => {
    const route = await import("@/app/api/admin/user-imports/[jobId]/rows/route");
    const params = Promise.resolve({ jobId: "import-job-1" });
    const decision: UserImportDecision = {
      action: "add",
      confirmWechatRebind: false,
      confirmWecomRebind: false
    };

    const listed = await route.GET(request(
      "https://board.example/api/admin/user-imports/import-job-1/rows",
      "GET"
    ), { params });
    const patched = await route.PATCH(request(
      "https://board.example/api/admin/user-imports/import-job-1/rows",
      "PATCH",
      {
        decisions: [{ rowId: "row-1", decision }]
      }
    ), { params });

    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: "row-1", category: "add" })]
    });
    expect(patched.status).toBe(204);
    expect(store.saveUserImportDecisions).toHaveBeenCalledWith(
      "import-job-1",
      [{ rowId: "row-1", decision }],
      actor()
    );
  });

  it("rejects malformed decision payloads before repository persistence", async () => {
    const route = await import("@/app/api/admin/user-imports/[jobId]/rows/route");
    const params = Promise.resolve({ jobId: "import-job-1" });

    for (const body of [
      { decisions: [{ rowId: "row-1", decision: { action: "add" } }] },
      { decisions: [{ rowId: "row-1", decision: {
        action: "skip",
        confirmWechatRebind: false
      } }] },
      { decisions: [{ rowId: "row-1", decision: {
        action: "overwrite",
        confirmWechatRebind: "false",
        confirmWecomRebind: false
      } }] },
      { decisions: [{ rowId: "row-1", decision: {
        action: "delete",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      } }] },
      { decisions: [{ rowId: " ", decision: {
        action: "add",
        confirmWechatRebind: false,
        confirmWecomRebind: false
      } }] }
    ]) {
      const response = await route.PATCH(request(
        "https://board.example/api/admin/user-imports/import-job-1/rows",
        "PATCH",
        body
      ), { params });

      expect(response.status).toBe(400);
    }
    expect(store.saveUserImportDecisions).not.toHaveBeenCalled();
  });

  it("loads import job details from the job route", async () => {
    const route = await import("@/app/api/admin/user-imports/[jobId]/route");
    const params = Promise.resolve({ jobId: "import-job-1" });

    const response = await route.GET(request(
      "https://board.example/api/admin/user-imports/import-job-1",
      "GET"
    ), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "import-job-1",
      rows: [expect.objectContaining({ id: "row-1" })]
    });
    expect(store.getUserImportJobRows).toHaveBeenCalledWith(
      "import-job-1",
      actor()
    );
  });

  it("commits selected import rows through the commit route", async () => {
    const route = await import("@/app/api/admin/user-imports/[jobId]/commit/route");
    const params = Promise.resolve({ jobId: "import-job-1" });

    const response = await route.POST(request(
      "https://board.example/api/admin/user-imports/import-job-1/commit",
      "POST"
    ), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      committed: 1
    });
    expect(store.applyUserImport).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({
          decision: {
            action: "add",
            confirmWechatRebind: false,
            confirmWecomRebind: false
          }
        })]
      }),
      actor()
    );
  });

  it("returns an xlsx import report download", async () => {
    const route = await import("@/app/api/admin/user-imports/[jobId]/report/route");
    const params = Promise.resolve({ jobId: "import-job-1" });

    const response = await route.GET(request(
      "https://board.example/api/admin/user-imports/import-job-1/report",
      "GET"
    ), { params });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="user-import-import-job-1.xlsx"'
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect(store.userImportReport).toHaveBeenCalledWith(
      "import-job-1",
      actor()
    );
  });
});
