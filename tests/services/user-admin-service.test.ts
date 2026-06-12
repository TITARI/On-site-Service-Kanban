import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import {
  createUser,
  deleteUser,
  disableUser,
  setUserPassword,
  updateUser
} from "@/lib/services/user-admin-service";
import { verifyPassword } from "@/lib/services/password-service";

const admin = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "Root Admin",
  phone: "13700137000",
  groupId: "admin",
  groupName: "Administrators",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

const managedUser = {
  personId: "person-1",
  accountId: "account-1",
  name: "张三",
  phone: "13800138000",
  groupId: "ops",
  groupName: "Operations",
  groupLocked: false,
  enabled: true,
  permissions: ["ticket.process" as const],
  hasPassword: false,
  identities: {},
  updatedAt: "2026-06-12T00:00:00.000Z"
};

function repository(overrides: Partial<AppRepository> = {}) {
  return {
    getConfig: vi.fn(async () => ({
      issueTypes: [],
      aiModels: [],
      assignmentRules: [],
      userGroups: [
        {
          id: "ops",
          name: "Operations",
          description: "",
          canClaim: false,
          canProcess: true,
          canAccept: false,
          canAdmin: false,
          enabled: true
        },
        {
          id: "admin",
          name: "Administrators",
          description: "",
          canClaim: false,
          canProcess: false,
          canAccept: false,
          canAdmin: true,
          enabled: true
        }
      ]
    })),
    getUser: vi.fn(async () => managedUser),
    createUser: vi.fn(async () => managedUser),
    updateUser: vi.fn(async () => managedUser),
    setUserEnabled: vi.fn(async () => managedUser),
    deleteUser: vi.fn(async () => undefined),
    setUserPassword: vi.fn(async () => undefined),
    userDeletionHistory: vi.fn(async () => ({ deletable: true, reasons: [] })),
    usableAdminCount: vi.fn(async () => 2),
    ...overrides
  } as unknown as AppRepository;
}

describe("user admin service", () => {
  it("validates and normalizes user creation", async () => {
    const repo = repository();
    await createUser(repo, {
      name: " 张三 ",
      phone: "138 0013 8000",
      groupId: "ops",
      groupLocked: true,
      enabled: true
    }, admin);

    expect(repo.createUser).toHaveBeenCalledWith({
      name: "张三",
      phone: "13800138000",
      groupId: "ops",
      groupLocked: true,
      enabled: true
    }, admin);
  });

  it("blocks deletion when the person has business history", async () => {
    const repo = repository({
      userDeletionHistory: vi.fn(async () => ({
        deletable: false,
        reasons: ["tickets"]
      }))
    });

    await expect(deleteUser(repo, "person-1", admin)).rejects.toThrow("该用户已有历史记录，仅可停用");
    expect(repo.deleteUser).not.toHaveBeenCalled();
  });

  it("allows deletion when only target maintenance audits exist", async () => {
    const repo = repository();

    await deleteUser(repo, "person-1", admin);

    expect(repo.deleteUser).toHaveBeenCalledWith("person-1", admin);
  });

  it("protects the final usable administrator", async () => {
    const adminUser = {
      ...managedUser,
      personId: "person-admin",
      accountId: "account-admin",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access" as const],
      hasPassword: true
    };
    const repo = repository({
      getUser: vi.fn(async () => adminUser),
      usableAdminCount: vi.fn(async () => 1)
    });

    await expect(disableUser(repo, "person-admin", admin)).rejects.toThrow("必须保留至少一位可用后台管理员");
    expect(repo.setUserEnabled).not.toHaveBeenCalled();
  });

  it("protects the final admin when an edit removes admin access", async () => {
    const adminUser = {
      ...managedUser,
      personId: "person-admin",
      accountId: "account-admin",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access" as const],
      hasPassword: true
    };
    const repo = repository({
      getUser: vi.fn(async () => adminUser),
      usableAdminCount: vi.fn(async () => 1)
    });

    await expect(updateUser(repo, "person-admin", {
      groupId: "ops"
    }, admin)).rejects.toThrow("必须保留至少一位可用后台管理员");
  });

  it("hashes a new backend password before persistence", async () => {
    const repo = repository({
      getUser: vi.fn(async () => ({
        ...managedUser,
        permissions: ["admin.access" as const]
      }))
    });

    await setUserPassword(repo, "person-1", "StrongPass123!", admin);

    const passwordHash = vi.mocked(repo.setUserPassword).mock.calls[0][1];
    expect(passwordHash).not.toBe("StrongPass123!");
    await expect(verifyPassword("StrongPass123!", passwordHash)).resolves.toBe(true);
  });
});
