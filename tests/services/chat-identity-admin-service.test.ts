import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { AppState } from "@/lib/domain/app-state";
import type { ChatIdentity } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { bindChatIdentityInState } from "@/lib/services/access-state-service";
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

async function conflictToken(repo: AppRepository, secret = "test-secret") {
  const service = createChatIdentityAdminService(repo, {
    env: {
      AUTH_CONFIRMATION_SECRET: secret
    } as NodeJS.ProcessEnv
  });
  const attempt = service.bindIdentity(
    { userId: "person-1", platform: "wechat", externalUserId: "wxid-1" },
    adminActor()
  );
  await expect(attempt).rejects.toBeInstanceOf(ChatIdentityConflictError);
  return await attempt.catch((error: ChatIdentityConflictError) => (
    error.confirmationToken
  ));
}

function claimFromToken(token: string) {
  const [payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function signedToken(claim: Record<string, unknown>, secret = "test-secret") {
  const payload = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
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
        confirmedRebind: true,
        expectedRebind: {
          platform: "wechat",
          identityId: "identity-wxid-1",
          fromPersonId: "person-other",
          toPersonId: "person-1"
        }
      }),
      expect.anything()
    );
  });

  it("rejects confirmation tokens with invalid expiry values", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const token = await conflictToken(repo);
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(service.bindIdentity({
      ...confirmedBindingInput(),
      confirmationToken: signedToken({
        ...claimFromToken(token),
        expiresAt: "not-a-date"
      })
    }, adminActor())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("rejects expired confirmation tokens", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const token = await conflictToken(repo);
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(service.bindIdentity({
      ...confirmedBindingInput(),
      confirmationToken: signedToken({
        ...claimFromToken(token),
        expiresAt: new Date(Date.now() - 1000).toISOString()
      })
    }, adminActor())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("rejects confirmation tokens with over-long future expiry", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const token = await conflictToken(repo);
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(service.bindIdentity({
      ...confirmedBindingInput(),
      confirmationToken: signedToken({
        ...claimFromToken(token),
        expiresAt: new Date(Date.now() + 6 * 60 * 1000).toISOString()
      })
    }, adminActor())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
  });

  it("rejects mismatched signed confirmation claims", async () => {
    const repo = repository({
      identityByExternalId: vi.fn().mockResolvedValue(
        identity({ personId: "person-other" })
      )
    });
    const token = await conflictToken(repo);
    const service = createChatIdentityAdminService(repo, {
      env: {
        AUTH_CONFIRMATION_SECRET: "test-secret"
      } as NodeJS.ProcessEnv
    });

    await expect(service.bindIdentity({
      ...confirmedBindingInput(),
      confirmationToken: signedToken({
        ...claimFromToken(token),
        toPersonId: "person-else"
      })
    }, adminActor())).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(repo.bindChatIdentity).not.toHaveBeenCalled();
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

describe("chat identity access-state mutations", () => {
  it("preserves the target user's existing platform binding when unconfirmed rebind is rejected", () => {
    const state: AppState = {
      booths: [],
      tickets: [],
      messageRecords: [],
      people: [
        {
          id: "person-1",
          name: "Alice",
          phone: "13800138000",
          role: "handler",
          groupId: "builder",
          groupName: "Builder",
          enabled: true,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        },
        {
          id: "person-other",
          name: "Bob",
          phone: "13900139000",
          role: "handler",
          groupId: "builder",
          groupName: "Builder",
          enabled: true,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      chatIdentities: [
        identity({
          id: "identity-current",
          externalUserId: "wxid-current",
          displayName: "Alice Current",
          personId: "person-1",
          verifiedBy: "admin",
          verifiedAt: "2026-06-15T00:00:00.000Z"
        }),
        identity({
          id: "identity-occupied",
          externalUserId: "wxid-occupied",
          displayName: "Bob WeChat",
          personId: "person-other",
          verifiedBy: "admin",
          verifiedAt: "2026-06-15T00:00:00.000Z"
        })
      ],
      accounts: [
        {
          id: "account-person-1",
          personId: "person-1",
          loginName: "13800138000",
          enabled: true,
          authVersion: 1,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        },
        {
          id: "account-person-other",
          personId: "person-other",
          loginName: "13900139000",
          enabled: true,
          authVersion: 1,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      accountCredentials: [],
      roles: [],
      accountRoles: [],
      rolePermissions: [],
      accountSessions: [],
      auditLogs: [],
      config: {
        userGroups: []
      } as AppState["config"]
    };

    expect(() => bindChatIdentityInState(state, {
      userId: "person-1",
      platform: "wechat",
      externalUserId: "wxid-occupied",
      confirmedRebind: false
    }, adminActor())).toThrow(/assigned to another user/i);

    expect(state.chatIdentities?.find((item) => item.id === "identity-current")).toMatchObject({
      personId: "person-1",
      verifiedBy: "admin",
      verifiedAt: "2026-06-15T00:00:00.000Z"
    });
    expect(state.chatIdentities?.find((item) => item.id === "identity-occupied")).toMatchObject({
      personId: "person-other"
    });
    expect(state.auditLogs).toEqual([]);
  });

  it("rejects confirmed rebinds when the occupied owner changed after confirmation", () => {
    const state: AppState = {
      booths: [],
      tickets: [],
      messageRecords: [],
      people: [
        {
          id: "person-1",
          name: "Alice",
          phone: "13800138000",
          role: "handler",
          groupId: "builder",
          groupName: "Builder",
          enabled: true,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        },
        {
          id: "person-new-owner",
          name: "Carol",
          phone: "13700137000",
          role: "handler",
          groupId: "builder",
          groupName: "Builder",
          enabled: true,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      chatIdentities: [
        identity({
          id: "identity-current",
          externalUserId: "wxid-current",
          displayName: "Alice Current",
          personId: "person-1",
          verifiedBy: "admin",
          verifiedAt: "2026-06-15T00:00:00.000Z"
        }),
        identity({
          id: "identity-occupied",
          externalUserId: "wxid-occupied",
          displayName: "Carol WeChat",
          personId: "person-new-owner",
          verifiedBy: "admin",
          verifiedAt: "2026-06-15T00:00:00.000Z"
        })
      ],
      accounts: [
        {
          id: "account-person-1",
          personId: "person-1",
          loginName: "13800138000",
          enabled: true,
          authVersion: 1,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        },
        {
          id: "account-person-new-owner",
          personId: "person-new-owner",
          loginName: "13700137000",
          enabled: true,
          authVersion: 1,
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      accountCredentials: [],
      roles: [],
      accountRoles: [],
      rolePermissions: [],
      accountSessions: [],
      auditLogs: [],
      config: {
        userGroups: []
      } as AppState["config"]
    };

    expect(() => bindChatIdentityInState(state, {
      userId: "person-1",
      platform: "wechat",
      externalUserId: "wxid-occupied",
      confirmedRebind: true,
      expectedRebind: {
        platform: "wechat",
        identityId: "identity-occupied",
        fromPersonId: "person-other",
        toPersonId: "person-1"
      }
    }, adminActor())).toThrow(/changed.*retry|retry.*changed/i);

    expect(state.chatIdentities?.find((item) => item.id === "identity-current")).toMatchObject({
      personId: "person-1"
    });
    expect(state.chatIdentities?.find((item) => item.id === "identity-occupied")).toMatchObject({
      personId: "person-new-owner"
    });
    expect(state.auditLogs).toEqual([]);
  });
});
