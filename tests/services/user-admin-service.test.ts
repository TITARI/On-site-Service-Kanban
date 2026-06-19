import { describe, expect, it, vi } from "vitest";
import type {
  AuthenticatedActor,
  UserListItem,
  UserMutation
} from "@/lib/domain/access-control";
import type { AppRepository } from "@/lib/repositories/app-repository";
import {
  UserAdminConflictError,
  UserAdminNotFoundError,
  UserAdminValidationError,
  createUserAdminService
} from "@/lib/services/user-admin-service";

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

function user(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    personId: "person-1",
    accountId: "account-person-1",
    name: "Alice",
    phone: "13800138000",
    groupId: "builder",
    groupName: "Builder",
    groupLocked: false,
    enabled: true,
    permissions: ["ticket.process"],
    hasPassword: false,
    identities: {},
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

const validMutation: UserMutation = {
  name: "Alice",
  phone: "13800138000",
  groupId: "builder",
  groupLocked: false,
  enabled: true
};

function repository(overrides: Partial<AppRepository> = {}) {
  return {
    kind: "file",
    listUsers: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    setUserEnabled: vi.fn(),
    deleteUser: vi.fn(),
    setUserPassword: vi.fn(),
    ...overrides
  } as unknown as AppRepository;
}

describe("user admin service", () => {
  it("validates create mutations before writing", async () => {
    const repo = repository();
    const service = createUserAdminService(repo);

    await expect(service.createUser({
      ...validMutation,
      phone: "12345"
    }, actor())).rejects.toThrow(/手机号/);

    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it("maps duplicate phone errors to conflict errors", async () => {
    const repo = repository({
      createUser: vi.fn().mockRejectedValue(
        new Error("手机号已被其他用户占用")
      )
    });
    const service = createUserAdminService(repo);

    await expect(
      service.createUser(validMutation, actor())
    ).rejects.toBeInstanceOf(UserAdminConflictError);
  });

  it("hashes password changes and delegates without exposing plaintext", async () => {
    const repo = repository({
      setUserPassword: vi.fn().mockResolvedValue(undefined)
    });
    const service = createUserAdminService(repo);

    await service.setPassword(
      "person-1",
      "StrongPassword123!",
      actor()
    );

    expect(repo.setUserPassword).toHaveBeenCalledWith(
      "person-1",
      expect.stringMatching(/^scrypt\$/),
      actor()
    );
    expect(repo.setUserPassword).not.toHaveBeenCalledWith(
      "person-1",
      "StrongPassword123!",
      actor()
    );
  });

  it("maps missing users to not found errors", async () => {
    const repo = repository({
      updateUser: vi.fn().mockRejectedValue(new Error("未找到用户"))
    });
    const service = createUserAdminService(repo);

    await expect(
      service.updateUser("missing", validMutation, actor())
    ).rejects.toBeInstanceOf(UserAdminNotFoundError);
  });

  it("protects the final usable administrator", async () => {
    const repo = repository({
      setUserEnabled: vi.fn().mockRejectedValue(
        new Error("至少需要保留一个可用管理员账号")
      )
    });
    const service = createUserAdminService(repo);

    await expect(
      service.disableUser("person-admin", actor())
    ).rejects.toBeInstanceOf(UserAdminConflictError);
  });

  it("allows repository to evaluate final admin moves between admin-capable groups", async () => {
    const moved = user({
      personId: "person-admin",
      accountId: "account-person-admin",
      groupId: "admin-b",
      groupName: "Admin B",
      permissions: ["admin.access"],
      hasPassword: true
    });
    const repo = repository({
      getUser: vi.fn().mockResolvedValue(user({
        personId: "person-admin",
        accountId: "account-person-admin",
        groupId: "admin-a",
        groupName: "Admin A",
        permissions: ["admin.access"],
        hasPassword: true
      })),
      countUsableAdmins: vi.fn().mockResolvedValue(1),
      updateUser: vi.fn().mockResolvedValue(moved)
    });
    const service = createUserAdminService(repo);
    const input = {
      ...validMutation,
      groupId: "admin-b",
      groupLocked: true
    };

    await expect(
      service.updateUser("person-admin", input, actor())
    ).resolves.toBe(moved);
    expect(repo.updateUser).toHaveBeenCalledWith(
      "person-admin",
      input,
      actor()
    );
  });

  it("validates empty password before last-admin protection", async () => {
    const repo = repository({
      getUser: vi.fn().mockResolvedValue(user({
        personId: "person-admin",
        accountId: "account-person-admin",
        permissions: ["admin.access"],
        hasPassword: true
      })),
      countUsableAdmins: vi.fn().mockResolvedValue(1),
      setUserPassword: vi.fn()
    });
    const service = createUserAdminService(repo);

    await expect(
      service.setPassword("person-admin", { password: "" }, actor())
    ).rejects.toBeInstanceOf(UserAdminValidationError);
    expect(repo.setUserPassword).not.toHaveBeenCalled();
  });

  it("returns paged user lists with the requested page metadata", async () => {
    const repo = repository({
      listUsers: vi.fn().mockResolvedValue({
        users: [user()],
        total: 1
      })
    });
    const service = createUserAdminService(repo);

    await expect(
      service.listUsers({ page: 2, pageSize: 10 })
    ).resolves.toEqual({
      users: [user()],
      total: 1,
      page: 2,
      pageSize: 10
    });
  });
});
