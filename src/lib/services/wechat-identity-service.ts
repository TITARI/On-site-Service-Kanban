import type { ChatIdentity, Conversation, MessageChannel, PendingWorkOrderField, Person, PersonRole, UserGroup } from "../domain/types";
import { userGroupsOf } from "../seed";
import type { AppState } from "../domain/app-state";

export type IdentitySource = {
  channel: MessageChannel;
  senderId?: string;
  senderName?: string;
  senderGroup?: string;
  sourceConversationId?: string;
};

export type RegistrationDraft = {
  identityGroup: string;
  name: string;
  phone: string;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseRegistrationCommand(text: string): RegistrationDraft | undefined {
  const normalized = normalizeText(text).replace(/[，,、;；:：]/g, " ");
  const match = normalized.match(/^(?:注册|绑定)\s*(\S+)\s+(\S+)\s+(1[3-9]\d{9})$/);
  if (!match) return undefined;
  return { identityGroup: match[1], name: match[2], phone: match[3] };
}

export function isValidPhone(phone: string) {
  return /^1[3-9]\d{9}$/.test(phone);
}

export function enabledIdentityGroups(state: AppState) {
  return userGroupsOf(state.config).filter((group) => group.enabled).map((group) => group.name);
}

function enabledIdentityGroup(state: AppState, groupName: string): UserGroup | undefined {
  return userGroupsOf(state.config).find((group) => group.enabled && group.name === groupName);
}

function roleForGroup(group: UserGroup): PersonRole {
  if (group.canProcess || group.canClaim) return "handler";
  if (group.canAccept) return "manager";
  return "reporter";
}

export function ensureConversationAndIdentity(state: AppState, source: IdentitySource): { conversation: Conversation; identity: ChatIdentity } {
  state.conversations ??= [];
  state.chatIdentities ??= [];

  const timestamp = now();
  const externalConversationId =
    normalizeText(source.sourceConversationId) ||
    normalizeText(source.senderGroup) ||
    normalizeText(source.senderId) ||
    normalizeText(source.senderName) ||
    "unknown-conversation";
  const stableUserId = normalizeText(source.senderId);
  const displayName = normalizeText(source.senderName) || "微信用户";
  const isTemporary = !stableUserId;
  const externalUserId = stableUserId || `temporary-${source.channel}-${externalConversationId}-${displayName}`;

  let conversation = state.conversations.find((item) => item.platform === source.channel && item.externalConversationId === externalConversationId);
  if (!conversation) {
    conversation = {
      id: id("conversation"),
      platform: source.channel,
      type: normalizeText(source.senderGroup) ? "group" : "direct",
      externalConversationId,
      title: normalizeText(source.senderGroup) || normalizeText(source.senderName) || "微信会话",
      linkedPersonIds: [],
      defaultNotify: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.conversations.push(conversation);
  } else {
    conversation.title = normalizeText(source.senderGroup) || conversation.title;
    conversation.updatedAt = timestamp;
  }

  let identity = state.chatIdentities.find((item) => item.platform === source.channel && item.externalUserId === externalUserId);
  if (!identity) {
    identity = {
      id: id("chat"),
      platform: source.channel,
      externalUserId,
      displayName,
      isTemporary,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    };
    state.chatIdentities.push(identity);
  } else {
    identity.displayName = displayName || identity.displayName;
    identity.isTemporary = isTemporary;
    identity.lastSeenAt = timestamp;
  }

  return { conversation, identity };
}

export function bindWechatIdentityFromRegistration(state: AppState, chatIdentityId: string, draft: RegistrationDraft): Person {
  const groupName = normalizeText(draft.identityGroup);
  const name = normalizeText(draft.name);
  const phone = normalizeText(draft.phone);
  if (!name) throw new Error("真实姓名不能为空");
  if (!isValidPhone(phone)) throw new Error("手机号格式不正确");
  const group = enabledIdentityGroup(state, groupName);
  if (!group) throw new Error(`身份组不存在：${groupName}`);

  state.people ??= [];
  state.chatIdentities ??= [];

  const timestamp = now();
  const identity = state.chatIdentities.find((item) => item.id === chatIdentityId);
  if (!identity) throw new Error("微信身份不存在");
  if (identity.isTemporary) throw new Error("缺少稳定微信用户标识，无法绑定");

  const role = roleForGroup(group);

  let person = state.people.find((item) => item.phone === phone);
  if (!person) {
    person = {
      id: id("person"),
      name,
      phone,
      role,
      groupName,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.people.push(person);
  } else {
    if (person.name !== name) {
      person.nameConflict = { attemptedName: name, observedAt: timestamp };
    } else {
      delete person.nameConflict;
    }
    person.groupName = groupName;
    person.role = role;
    person.enabled = true;
    person.updatedAt = timestamp;
  }

  identity.personId = person.id;
  identity.verifiedBy = "phone";
  identity.verifiedAt = timestamp;
  identity.lastSeenAt = timestamp;

  return person;
}

export function missingIdentityFields(draft: Partial<RegistrationDraft>): PendingWorkOrderField[] {
  const fields: PendingWorkOrderField[] = [];
  if (!draft.identityGroup) fields.push("identityGroup");
  if (!draft.name) fields.push("name");
  if (!draft.phone) fields.push("phone");
  return fields;
}

export function identityPromptText(fields: PendingWorkOrderField[], groups: string[]) {
  const labels = fields
    .filter((field) => ["identityGroup", "name", "phone"].includes(field))
    .map((field) => field === "identityGroup" ? "身份组" : field === "name" ? "真实姓名" : "手机号");
  const uniqueLabels = Array.from(new Set(labels));
  const groupText = groups.length ? `。可选身份组：${groups.join("、")}` : "";
  return `请补充${uniqueLabels.join("、")}，例如：注册 搭建组 张三 13800138000${groupText}`;
}

