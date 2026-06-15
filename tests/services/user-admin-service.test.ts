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
    }, actor())).rejects.toThrow(/invalid/i);

    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it("maps duplicate phone errors to conflict errors", async () => {
    const repo = repository({
      createUser: vi.fn().mockRejectedValue(
        new Error("Mobile phone is already assigned to another user")
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
      updateUser: vi.fn().mockRejectedValue(new Error("User was not found"))
    });
    const service = createUserAdminService(repo);

    await expect(
      service.updateUser("missing", validMutation, actor())
    ).rejects.toBeInstanceOf(UserAdminNotFoundError);
  });

  it("protects the final usable administrator", async () => {
    const repo = repository({
      setUserEnabled: vi.fn().mockRejectedValue(
        new Error("At least one usable admin account is required")
      )
    });
    const service = createUserAdminService(repo);

    await expect(
      service.disableUser("person-admin", actor())
    ).rejects.toBeInstanceOf(UserAdminConflictError);
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
