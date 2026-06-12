import { describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import {
  bindIdentity,
  listManagedIdentities,
  unbindIdentity
} from "@/lib/services/chat-identity-admin-service";

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

const targetUser = {
  personId: "person-1",
  accountId: "account-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  groupLocked: false,
  enabled: true,
  permissions: ["ticket.process"] as const,
  hasPassword: false,
  identities: {},
  updatedAt: "2026-06-12T00:00:00.000Z"
};

const occupiedIdentity = {
  id: "identity-wechat-1",
  platform: "wechat" as const,
  externalUserId: "wxid-occupied",
  displayName: "李四微信",
  isTemporary: false,
  personId: "person-other",
  personName: "李四",
  personPhone: "13900139000",
  firstSeenAt: "2026-06-10T00:00:00.000Z",
  lastSeenAt: "2026-06-12T00:00:00.000Z"
};

function repository(overrides: Partial<AppRepository> = {}) {
  return {
    getUser: vi.fn(async () => targetUser),
    listChatIdentities: vi.fn(async () => [occupiedIdentity]),
    getChatIdentity: vi.fn(async () => occupiedIdentity),
    identityByExternalId: vi.fn(async () => occupiedIdentity),
    bindChatIdentity: vi.fn(async () => ({
      ...targetUser,
      identities: {
        wechat: {
          id: occupiedIdentity.id,
          externalUserId: occupiedIdentity.externalUserId,
          displayName: occupiedIdentity.displayName
        }
      }
    })),
    unbindChatIdentity: vi.fn(async () => targetUser),
    ...overrides
  } as unknown as AppRepository;
}

const options = {
  env: {
    NODE_ENV: "test",
    AUTH_CONFIRMATION_SECRET: "test-confirmation-secret"
  },
  now: new Date("2026-06-12T01:00:00.000Z")
};

describe("chat identity admin service", () => {
  it("requires explicit confirmation before reassigning an occupied identity", async () => {
    const repo = repository();

    await expect(bindIdentity(repo, {
      userId: "person-1",
      platform: "wechat",
      externalUserId: "wxid-occupied",
      displayName: "张三微信"
    }, actor, options)).rejects.toMatchObject({
      code: "IDENTITY_CONFLICT",
      confirmationToken: expect.any(String),
      conflict: {
        personId: "person-other",
        personName: "李四"
      }
    });

    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("verifies the confirmation token before replacing an occupied binding", async () => {
    const repo = repository();
    let token = "";
    try {
      await bindIdentity(repo, {
        userId: "person-1",
        platform: "wechat",
        identityId: occupiedIdentity.id
      }, actor, options);
    } catch (error) {
      token = (error as { confirmationToken: string }).confirmationToken;
    }

    await bindIdentity(repo, {
      userId: "person-1",
      platform: "wechat",
      identityId: occupiedIdentity.id,
      confirmationToken: token
    }, actor, options);

    expect(repo.bindChatIdentity).toHaveBeenCalledWith({
      userId: "person-1",
      platform: "wechat",
      identityId: occupiedIdentity.id,
      externalUserId: occupiedIdentity.externalUserId,
      displayName: occupiedIdentity.displayName,
      confirmedRebindFromPersonId: "person-other"
    }, actor);
  });

  it("rejects temporary identities and lists only stable discovered identities", async () => {
    const temporary = {
      ...occupiedIdentity,
      id: "temporary-1",
      externalUserId: "temporary-wechat-group-user",
      isTemporary: true
    };
    const repo = repository({
      listChatIdentities: vi.fn(async () => [occupiedIdentity, temporary]),
      getChatIdentity: vi.fn(async () => temporary)
    });

    await expect(bindIdentity(repo, {
      userId: "person-1",
      platform: "wechat",
      identityId: temporary.id
    }, actor, options)).rejects.toThrow("临时身份不能绑定");

    await expect(listManagedIdentities(repo, "wechat")).resolves.toEqual([occupiedIdentity]);
  });

  it("passes unbinding through the authenticated actor", async () => {
    const repo = repository();

    await unbindIdentity(repo, "person-1", "wechat", actor);

    expect(repo.unbindChatIdentity).toHaveBeenCalledWith("person-1", "wechat", actor);
  });
});
