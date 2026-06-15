import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { ChatIdentity } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import {
  ChatIdentityConflictError,
  createChatIdentityAdminService
} from "@/lib/services/chat-identity-admin-service";

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

function identity(overrides: Partial<ChatIdentity> = {}): ChatIdentity {
  return {
    id: "identity-wxid-1",
    platform: "wechat",
    externalUserId: "wxid-1",
    displayName: "Alice WeChat",
    isTemporary: false,
    firstSeenAt: "2026-06-15T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

function repository(overrides: Partial<AppRepository> = {}) {
  return {
    kind: "file",
    getUser: vi.fn().mockResolvedValue({
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
      updatedAt: "2026-06-15T00:00:00.000Z"
    }),
    identityByExternalId: vi.fn().mockResolvedValue(identity()),
    bindChatIdentity: vi.fn().mockResolvedValue(identity({ personId: "person-1" })),
    ...overrides
  } as unknown as AppRepository;
}

function confirmedBindingInput() {
  return {
    userId: "person-1",
    platform: "wechat" as const,
    externalUserId: "wxid-1",
    displayName: "Alice WeChat",
    confirmationToken: "confirmed-token"
  };
}

describe("chat identity admin service", () => {
  it("requires explicit confirmation before reassigning an occupied identity", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(
      service.bindIdentity(
        { userId: "person-1", platform: "wechat", externalUserId: "wxid-1" },
        adminActor()
      )
    ).rejects.toMatchObject({
      code: "IDENTITY_CONFLICT",
      confirmationToken: expect.any(String)
    });
    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("allows one identity per platform and replaces the user's old binding", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });
    const firstAttempt = service.bindIdentity(
      { userId: "person-1", platform: "wechat", externalUserId: "wxid-1" },
      adminActor()
    );
    await expect(firstAttempt).rejects.toBeInstanceOf(ChatIdentityConflictError);
    const token = await firstAttempt.catch((error: ChatIdentityConflictError) => (
      error.confirmationToken
    ));

    await service.bindIdentity({
      ...confirmedBindingInput(),
      confirmationToken: token
    }, adminActor());

    expect(repo.bindChatIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "person-1",
        platform: "wechat",
        externalUserId: "wxid-1",
        confirmedRebind: true
      }),
      expect.anything()
    );
  });

  it("rejects temporary identities", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ isTemporary: true })
      )
    });
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(
      service.bindIdentity(
        { userId: "person-1", platform: "wechat", externalUserId: "wxid-1" },
        adminActor()
      )
    ).rejects.toMatchObject({ code: "TEMPORARY_IDENTITY" });
  });

  it("allows admins to bind a manual stable external ID", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(undefined)
    });
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await service.bindIdentity({
      userId: "person-1",
      platform: "wecom",
      externalUserId: "wecom-user-1",
      displayName: "Alice WeCom"
    }, adminActor());

    expect(repo.bindChatIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "person-1",
        platform: "wecom",
        externalUserId: "wecom-user-1",
        displayName: "Alice WeCom",
        confirmedRebind: false
      }),
      adminActor()
    );
  });
});
