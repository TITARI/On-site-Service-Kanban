import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import {
  bindWechatIdentityFromRegistration,
  ensureConversationAndIdentity,
  identityPromptText,
  parseRegistrationCommand
} from "@/lib/services/wechat-identity-service";

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: {
      ...defaultConfig(),
      userGroups: [
        { id: "builder", name: "搭建组", description: "搭建", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true },
        { id: "business", name: "业务组", description: "业务", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
        { id: "organizer", name: "主场组", description: "主场", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true }
      ]
    }
  };
}

describe("wechat identity service", () => {
  it("parses registration commands", () => {
    expect(parseRegistrationCommand("注册 搭建组 张三 13800138000")).toEqual({
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });
    expect(parseRegistrationCommand("绑定 业务组 李四 13900139000")).toEqual({
      identityGroup: "业务组",
      name: "李四",
      phone: "13900139000"
    });
    expect(parseRegistrationCommand("注册主场组 刘基鑫，18638638860")).toEqual({
      identityGroup: "主场组",
      name: "刘基鑫",
      phone: "18638638860"
    });
    expect(parseRegistrationCommand("A01 网络断了")).toBeUndefined();
  });

  it("creates conversation and chat identity from inbound message fields", () => {
    const appState = state();

    const result = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    expect(result.identity).toMatchObject({
      platform: "wechat",
      externalUserId: "wxid-zhangsan",
      displayName: "张三微信"
    });
    expect(result.conversation).toMatchObject({
      platform: "wechat",
      externalConversationId: "conv-builder",
      title: "搭建群"
    });
  });

  it("marks group identities without sender id as temporary and refuses to bind them", () => {
    const appState = state();
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    expect(identity).toMatchObject({
      isTemporary: true,
      displayName: "张三微信"
    });
    expect(identity.externalUserId).not.toBe("conv-builder");
    expect(() => bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    })).toThrow("缺少稳定微信用户标识，无法绑定");
  });

  it("keeps short temporary identity ids compatible with the legacy format", () => {
    const appState = state();

    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    expect(identity.externalUserId).toBe("temporary-wechat-conv-builder-张三微信");
  });

  it("keeps temporary external user ids within the database column limit", () => {
    const appState = state();
    const longName = "超长微信昵称".repeat(30);
    const longConversation = "超长微信会话".repeat(30);

    const { conversation, identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderName: longName,
      sourceConversationId: longConversation
    });

    expect(identity.isTemporary).toBe(true);
    expect(identity.externalUserId).toMatch(/^temporary-wechat-/);
    expect(identity.externalUserId.length).toBeLessThanOrEqual(160);
    expect(identity.displayName.length).toBeLessThanOrEqual(160);
    expect(conversation.externalConversationId.length).toBeLessThanOrEqual(160);
  });

  it("auto-registers and immediately binds a wechat identity", () => {
    const appState = state();
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    const person = bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });

    expect(person).toMatchObject({
      name: "张三",
      phone: "13800138000",
      groupName: "搭建组",
      enabled: true
    });
    expect(appState.chatIdentities?.[0].personId).toBe(person.id);
  });

  it("registers a WeChat person into the RBAC account and role model", () => {
    const appState = state();
    const builderGroup = appState.config.userGroups?.find(
      (group) => group.id === "builder"
    );
    expect(builderGroup).toBeDefined();
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "Alice WeChat",
      senderGroup: "Builder Chat",
      sourceConversationId: "conv-builder"
    });

    const person = bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: builderGroup?.name ?? "",
      name: "Alice",
      phone: "13800138000"
    });

    expect(person).toMatchObject({
      id: expect.any(String),
      groupId: "builder",
      groupName: builderGroup?.name
    });
    expect(appState.accounts).toContainEqual(expect.objectContaining({
      id: `account-${person.id}`,
      personId: person.id,
      loginName: "13800138000",
      enabled: true
    }));
    expect(appState.roles).toContainEqual(expect.objectContaining({
      id: "role-builder",
      sourceGroupId: "builder"
    }));
    expect(appState.rolePermissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleId: "role-builder",
        permissionCode: "ticket.claim"
      }),
      expect.objectContaining({
        roleId: "role-builder",
        permissionCode: "ticket.process"
      })
    ]));
    expect(appState.accountRoles).toContainEqual(expect.objectContaining({
      accountId: `account-${person.id}`,
      roleId: "role-builder"
    }));
  });

  it("does not link the registered person to unrelated conversations", () => {
    const appState = state();
    appState.conversations = [{
      id: "conversation-other",
      platform: "wechat",
      type: "group",
      externalConversationId: "conv-other",
      title: "其他群",
      linkedPersonIds: [],
      defaultNotify: true,
      createdAt: "2026-05-27T12:00:00.000Z",
      updatedAt: "2026-05-27T12:00:00.000Z"
    }];
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });

    expect(appState.conversations.find((item) => item.id === "conversation-other")?.linkedPersonIds).toEqual([]);
  });

  it("keeps an existing phone owner's name and records name conflicts", () => {
    const appState = state();
    appState.people = [{
      id: "person-existing",
      name: "原姓名",
      phone: "13800138000",
      role: "handler",
      groupName: "搭建组",
      enabled: true,
      createdAt: "2026-05-27T12:00:00.000Z",
      updatedAt: "2026-05-27T12:00:00.000Z"
    }];
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      sourceConversationId: "conv-direct"
    });

    const person = bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });

    expect(person.name).toBe("原姓名");
    expect(person.nameConflict).toMatchObject({ attemptedName: "张三" });
    expect(identity.personId).toBe("person-existing");
  });

  it("derives and synchronizes person role from group permissions", () => {
    const appState = state();
    appState.people = [{
      id: "person-existing",
      name: "张三",
      phone: "13800138000",
      role: "handler",
      groupName: "搭建组",
      enabled: true,
      createdAt: "2026-05-27T12:00:00.000Z",
      updatedAt: "2026-05-27T12:00:00.000Z"
    }];
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      sourceConversationId: "conv-direct"
    });

    const person = bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "主场组",
      name: "张三",
      phone: "13800138000"
    });

    expect(person.groupName).toBe("主场组");
    expect(person.role).toBe("manager");
  });

  it("rejects disabled groups, invalid phones and blank names", () => {
    const appState = state();
    appState.config.userGroups = [
      { id: "disabled", name: "停用组", description: "停用", canClaim: false, canProcess: false, canAccept: false, canAdmin: false, enabled: false }
    ];
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      sourceConversationId: "conv-direct"
    });

    expect(() => bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "停用组",
      name: "张三",
      phone: "13800138000"
    })).toThrow("身份组不存在");
    expect(() => bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "",
      phone: "13800138000"
    })).toThrow("真实姓名不能为空");
    expect(() => bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "123"
    })).toThrow("手机号格式不正确");
  });

  it("returns a useful prompt for missing identity fields", () => {
    expect(identityPromptText(["identityGroup", "name", "phone"], ["搭建组", "业务组"])).toBe(
      "请补充身份组、真实姓名、手机号，例如：注册 搭建组 张三 13800138000。可选身份组：搭建组、业务组"
    );
  });
});
