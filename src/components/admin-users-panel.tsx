"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Unlink,
  UserCheck,
  UserX,
  X
} from "lucide-react";
import type { PermissionCode, UserListItem } from "@/lib/domain/access-control";
import type { ChatIdentity, MessageChannel, UserGroup } from "@/lib/domain/types";
import { AdminUserImport } from "./admin-user-import";

type UserPayload = {
  users?: UserListItem[];
  total?: number;
};

type FilterState = {
  search: string;
  groupId: string;
  enabled: string;
  admin: string;
  binding: string;
};

type EditorState = {
  mode: "create" | "edit";
  user?: UserListItem;
};

type DraftState = {
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  enabled: boolean;
};

type IdentityDraft = {
  selectedExternalUserId: string;
  manualExternalUserId: string;
  manualDisplayName: string;
};

type ConflictState = {
  platform: MessageChannel;
  token: string;
  externalUserId: string;
  displayName?: string;
  ownerName?: string;
};

const DEFAULT_FILTERS: FilterState = {
  search: "",
  groupId: "",
  enabled: "",
  admin: "",
  binding: ""
};

const PERMISSION_LABELS: Record<PermissionCode, string> = {
  "ticket.claim": "认领工单",
  "ticket.process": "处理工单",
  "ticket.accept": "验收工单",
  "admin.access": "后台访问"
};

const PLATFORM_LABELS: Record<MessageChannel, string> = {
  wechat: "WeChat",
  wecom: "WeCom"
};

const EMPTY_IDENTITY_DRAFT: Record<MessageChannel, IdentityDraft> = {
  wechat: {
    selectedExternalUserId: "",
    manualExternalUserId: "",
    manualDisplayName: ""
  },
  wecom: {
    selectedExternalUserId: "",
    manualExternalUserId: "",
    manualDisplayName: ""
  }
};

function usersUrl(filters: FilterState) {
  const params = new URLSearchParams({ page: "1", pageSize: "20" });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.groupId) params.set("groupId", filters.groupId);
  if (filters.enabled) params.set("enabled", filters.enabled);
  if (filters.admin) params.set("admin", filters.admin);
  if (filters.binding) params.set("binding", filters.binding);
  return `/api/admin/users?${params.toString()}`;
}

function firstEnabledGroup(groups: UserGroup[]) {
  return groups.find((group) => group.enabled) ?? groups[0];
}

function draftFromUser(user: UserListItem | undefined, groups: UserGroup[]): DraftState {
  const fallbackGroup = firstEnabledGroup(groups);
  return {
    name: user?.name ?? "",
    phone: user?.phone ?? "",
    groupId: user?.groupId ?? fallbackGroup?.id ?? "",
    groupLocked: user?.groupLocked ?? false,
    enabled: user?.enabled ?? true
  };
}

function permissionsForGroup(group: UserGroup | undefined): PermissionCode[] {
  if (!group) return [];
  const permissions: PermissionCode[] = [];
  if (group.canClaim) permissions.push("ticket.claim");
  if (group.canProcess) permissions.push("ticket.process");
  if (group.canAccept) permissions.push("ticket.accept");
  if (group.canAdmin) permissions.push("admin.access");
  return permissions;
}

async function responseMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { message?: string };
    return payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function AdminUsersPanel({
  groups,
  onRefresh
}: {
  groups: UserGroup[];
  onRefresh?: () => void;
}) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<DraftState>(() => draftFromUser(undefined, groups));
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [identityDrafts, setIdentityDrafts] = useState<Record<MessageChannel, IdentityDraft>>(EMPTY_IDENTITY_DRAFT);
  const [availableIdentities, setAvailableIdentities] = useState<Record<MessageChannel, ChatIdentity[]>>({
    wechat: [],
    wecom: []
  });
  const [identityErrors, setIdentityErrors] = useState<Partial<Record<MessageChannel, string>>>({});
  const [identityConflict, setIdentityConflict] = useState<ConflictState | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [password, setPassword] = useState("");
  const latestListRequestId = useRef(0);

  const enabledGroups = useMemo(() => groups.filter((group) => group.enabled), [groups]);
  const inheritedPermissions = useMemo(
    () => {
      const group = groups.find((item) => item.id === draft.groupId);
      return group ? permissionsForGroup(group) : editor?.user?.permissions ?? [];
    },
    [draft.groupId, editor?.user, groups]
  );
  const canSetPassword = inheritedPermissions.includes("admin.access");

  async function loadUsers(nextFilters = appliedFilters) {
    const requestId = latestListRequestId.current + 1;
    latestListRequestId.current = requestId;
    setLoading(true);
    setListError(null);
    try {
      const response = await fetch(usersUrl(nextFilters), { cache: "no-store" });
      if (!response.ok) throw new Error(await responseMessage(response, "用户列表加载失败"));
      const payload = await response.json() as UserPayload;
      if (requestId !== latestListRequestId.current) return;
      setUsers(payload.users ?? []);
      setTotal(payload.total ?? payload.users?.length ?? 0);
    } catch (error) {
      if (requestId !== latestListRequestId.current) return;
      setListError(error instanceof Error ? error.message : "用户列表加载失败");
    } finally {
      if (requestId === latestListRequestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers(appliedFilters);
  }, [appliedFilters]);

  function openEditor(mode: "create" | "edit", user?: UserListItem) {
    setEditor({ mode, user });
    setDraft(draftFromUser(user, groups));
    setPassword("");
    setEditorError(null);
    setPasswordError(null);
    setIdentityDrafts(EMPTY_IDENTITY_DRAFT);
    setIdentityErrors({});
    setIdentityConflict(null);
  }

  function closeEditor() {
    setEditor(null);
    setEditorError(null);
    setPasswordError(null);
    setIdentityErrors({});
    setIdentityConflict(null);
    setPassword("");
  }

  async function loadChatIdentities(platform: MessageChannel) {
    try {
      const response = await fetch(`/api/admin/chat-identities?platform=${platform}`, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error(await responseMessage(response, `${PLATFORM_LABELS[platform]} identities failed to load`));
      const payload = await response.json() as { identities?: ChatIdentity[] };
      setAvailableIdentities((current) => ({
        ...current,
        [platform]: payload.identities ?? []
      }));
    } catch (error) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: error instanceof Error ? error.message : `${PLATFORM_LABELS[platform]} identities failed to load`
      }));
    }
  }

  useEffect(() => {
    if (editor?.mode !== "edit") return;
    void loadChatIdentities("wechat");
    void loadChatIdentities("wecom");
  }, [editor?.mode, editor?.user?.personId]);

  function updateIdentityDraft(
    platform: MessageChannel,
    changes: Partial<IdentityDraft>
  ) {
    setIdentityDrafts((current) => ({
      ...current,
      [platform]: {
        ...current[platform],
        ...changes
      }
    }));
  }

  function selectedIdentity(platform: MessageChannel) {
    const selected = identityDrafts[platform].selectedExternalUserId;
    return availableIdentities[platform].find((identity) => (
      identity.externalUserId === selected
    ));
  }

  function updateEditorIdentity(platform: MessageChannel, identity?: ChatIdentity) {
    setEditor((current) => {
      if (!current?.user) return current;
      const identities = { ...current.user.identities };
      if (identity) {
        identities[platform] = {
          id: identity.id,
          externalUserId: identity.externalUserId,
          displayName: identity.displayName
        };
      } else {
        delete identities[platform];
      }
      return {
        ...current,
        user: {
          ...current.user,
          identities
        }
      };
    });
  }

  async function bindIdentity(platform: MessageChannel, confirmationToken?: string) {
    if (!editor?.user) return;
    const draftIdentity = identityDrafts[platform];
    const discovered = selectedIdentity(platform);
    const externalUserId = discovered?.externalUserId || draftIdentity.manualExternalUserId.trim();
    const displayName = discovered?.displayName || draftIdentity.manualDisplayName.trim() || undefined;
    if (!externalUserId) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: `Select or enter a ${PLATFORM_LABELS[platform]} external ID`
      }));
      return;
    }
    setSavingAction(`identity-${platform}`);
    setIdentityErrors((current) => ({ ...current, [platform]: "" }));
    try {
      const response = await fetch(`/api/admin/users/${editor.user.personId}/chat-identities/${platform}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalUserId,
          displayName,
          ...(confirmationToken ? { confirmationToken } : {})
        })
      });
      if (response.status === 409) {
        const payload = await response.json() as {
          code?: string;
          message?: string;
          confirmationToken?: string;
          currentOwner?: { name?: string };
        };
        if (payload.code === "IDENTITY_CONFLICT" && payload.confirmationToken) {
          setIdentityConflict({
            platform,
            token: payload.confirmationToken,
            externalUserId,
            displayName,
            ownerName: payload.currentOwner?.name
          });
          return;
        }
        throw new Error(payload.message ?? `${PLATFORM_LABELS[platform]} binding failed`);
      }
      if (!response.ok) throw new Error(await responseMessage(response, `${PLATFORM_LABELS[platform]} binding failed`));
      const payload = await response.json() as { identity?: ChatIdentity };
      setIdentityConflict(null);
      if (payload.identity) {
        updateEditorIdentity(platform, payload.identity);
      }
      await loadUsers();
      await loadChatIdentities(platform);
      onRefresh?.();
    } catch (error) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: error instanceof Error ? error.message : `${PLATFORM_LABELS[platform]} binding failed`
      }));
    } finally {
      setSavingAction(null);
    }
  }

  async function unbindIdentity(platform: MessageChannel) {
    if (!editor?.user) return;
    setSavingAction(`identity-${platform}-unbind`);
    setIdentityErrors((current) => ({ ...current, [platform]: "" }));
    try {
      const response = await fetch(`/api/admin/users/${editor.user.personId}/chat-identities/${platform}`, {
        method: "DELETE"
      });
      if (!response.ok) throw new Error(await responseMessage(response, `${PLATFORM_LABELS[platform]} unbind failed`));
      updateEditorIdentity(platform);
      await loadUsers();
      onRefresh?.();
    } catch (error) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: error instanceof Error ? error.message : `${PLATFORM_LABELS[platform]} unbind failed`
      }));
    } finally {
      setSavingAction(null);
    }
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim() || !draft.groupId) {
      setEditorError("请填写姓名、手机号并选择分组");
      return;
    }
    setSavingAction("save");
    setEditorError(null);
    try {
      const body = {
        name: draft.name.trim(),
        phone: draft.phone.trim(),
        groupId: draft.groupId,
        groupLocked: draft.groupLocked,
        enabled: draft.enabled
      };
      const endpoint = editor?.mode === "edit" && editor.user
        ? `/api/admin/users/${editor.user.personId}`
        : "/api/admin/users";
      const response = await fetch(endpoint, {
        method: editor?.mode === "edit" ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(await responseMessage(response, "用户保存失败"));
      await loadUsers();
      onRefresh?.();
      closeEditor();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "用户保存失败");
    } finally {
      setSavingAction(null);
    }
  }

  async function runUserAction(user: UserListItem, action: "enable" | "disable" | "delete") {
    const actionLabel = action === "enable" ? "启用" : action === "disable" ? "停用" : "删除";
    if (!window.confirm(`确认${actionLabel}${user.name}？`)) return;
    const key = `${user.personId}-${action}`;
    setSavingAction(key);
    setActionErrors((current) => ({ ...current, [key]: "" }));
    try {
      const endpoint = action === "delete"
        ? `/api/admin/users/${user.personId}`
        : `/api/admin/users/${user.personId}/${action}`;
      const response = await fetch(endpoint, {
        method: action === "delete" ? "DELETE" : "POST"
      });
      if (!response.ok) throw new Error(await responseMessage(response, `${actionLabel}用户失败`));
      await loadUsers();
      onRefresh?.();
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : `${actionLabel}用户失败`
      }));
    } finally {
      setSavingAction(null);
    }
  }

  async function savePassword() {
    if (!editor?.user || !password.trim()) {
      setPasswordError("请填写新密码");
      return;
    }
    setSavingAction("password");
    setPasswordError(null);
    try {
      const response = await fetch(`/api/admin/users/${editor.user.personId}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      if (!response.ok) throw new Error(await responseMessage(response, "密码设置失败"));
      setPassword("");
      await loadUsers();
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "密码设置失败");
    } finally {
      setSavingAction(null);
    }
  }

  return (
    <section className="admin-card admin-users-panel" aria-label="用户与权限管理">
      <div className="admin-card-head admin-users-head">
        <div>
          <h3>用户与权限</h3>
          <p>按人员、分组、后台权限和微信绑定状态筛选，维护账号启停和继承权限。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => openEditor("create")}>
          <Plus size={16} aria-hidden="true" />
          新增用户
        </button>
      </div>

      <AdminUserImport onCommitted={async () => {
        await loadUsers();
        onRefresh?.();
      }} />

      <form
        className="admin-users-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedFilters(filters);
        }}
      >
        <label>
          <span>搜索姓名或手机号</span>
          <input aria-label="搜索姓名或手机号" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="姓名 / 手机号" />
        </label>
        <label>
          <span>用户分组</span>
          <select aria-label="筛选用户分组" value={filters.groupId} onChange={(event) => setFilters((current) => ({ ...current, groupId: event.target.value }))}>
            <option value="">全部分组</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label>
          <span>状态</span>
          <select aria-label="筛选用户状态" value={filters.enabled} onChange={(event) => setFilters((current) => ({ ...current, enabled: event.target.value }))}>
            <option value="">全部状态</option>
            <option value="true">启用</option>
            <option value="false">停用</option>
          </select>
        </label>
        <label>
          <span>后台权限</span>
          <select aria-label="筛选后台权限" value={filters.admin} onChange={(event) => setFilters((current) => ({ ...current, admin: event.target.value }))}>
            <option value="">全部权限</option>
            <option value="true">可进后台</option>
            <option value="false">无后台权限</option>
          </select>
        </label>
        <label>
          <span>微信绑定</span>
          <select aria-label="筛选绑定状态" value={filters.binding} onChange={(event) => setFilters((current) => ({ ...current, binding: event.target.value }))}>
            <option value="">全部绑定</option>
            <option value="bound">已绑定</option>
            <option value="unbound">未绑定</option>
          </select>
        </label>
        <div className="admin-users-filter-actions">
          <button className="primary-button" type="submit" disabled={loading}>
            <Search size={16} aria-hidden="true" />
            筛选用户
          </button>
          <button className="secondary-button" type="button" onClick={() => void loadUsers()} disabled={loading}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </button>
        </div>
      </form>

      {listError && <p className="form-message" role="alert">{listError}</p>}
      <div className="admin-users-summary" aria-live="polite">{loading ? "加载用户中..." : `共 ${total} 位用户`}</div>

      <div className="admin-users-table" role="table" aria-label="后台用户列表">
        <div className="admin-user-row admin-user-head" role="row">
          <span role="columnheader">用户</span>
          <span role="columnheader">手机号</span>
          <span role="columnheader">状态</span>
          <span role="columnheader">分组</span>
          <span role="columnheader">分组锁定</span>
          <span role="columnheader">后台</span>
          <span role="columnheader">密码</span>
          <span role="columnheader">微信绑定</span>
          <span role="columnheader">操作</span>
        </div>
        {users.map((item) => {
          const boundNames = Object.values(item.identities).map((identity) => identity?.displayName).filter(Boolean).join("、");
          const isAdmin = item.permissions.includes("admin.access");
          return (
            <article className="admin-user-row" role="row" key={item.personId}>
              <strong role="cell" data-label="用户">{item.name}</strong>
              <span role="cell" data-label="手机号">{item.phone}</span>
              <span role="cell" data-label="状态"><em className={item.enabled ? "success" : "danger"}>{item.enabled ? "启用" : "停用"}</em></span>
              <span role="cell" data-label="分组">{item.groupName}</span>
              <span role="cell" data-label="分组锁定">{item.groupLocked ? "已锁定" : "跟随规则"}</span>
              <span role="cell" data-label="后台">{isAdmin ? "可进后台" : "无后台权限"}</span>
              <span role="cell" data-label="密码">{item.hasPassword ? "已设置" : "未设置"}</span>
              <span role="cell" data-label="微信绑定">{boundNames || "未绑定"}</span>
              <div className="admin-user-actions" role="cell" data-label="操作">
                <button className="secondary-button" type="button" aria-label={`编辑${item.name}`} onClick={() => openEditor("edit", item)}>
                  <Pencil size={15} aria-hidden="true" />
                  编辑
                </button>
                {item.enabled ? (
                  <button className="secondary-button" type="button" onClick={() => void runUserAction(item, "disable")} disabled={savingAction === `${item.personId}-disable`}>
                    <UserX size={15} aria-hidden="true" />
                    停用
                  </button>
                ) : (
                  <button className="secondary-button" type="button" onClick={() => void runUserAction(item, "enable")} disabled={savingAction === `${item.personId}-enable`}>
                    <UserCheck size={15} aria-hidden="true" />
                    启用
                  </button>
                )}
                <button className="danger-button" type="button" onClick={() => void runUserAction(item, "delete")} disabled={savingAction === `${item.personId}-delete`}>
                  <Trash2 size={15} aria-hidden="true" />
                  删除
                </button>
                {["enable", "disable", "delete"].map((action) => {
                  const key = `${item.personId}-${action}`;
                  return actionErrors[key] ? <p className="admin-user-action-error" role="alert" key={key}>{actionErrors[key]}</p> : null;
                })}
              </div>
            </article>
          );
        })}
        {!loading && users.length === 0 && <p className="admin-empty-note">暂无匹配用户</p>}
      </div>

      {editor && (
        <aside className="admin-user-drawer" role="complementary" aria-label={editor.mode === "edit" && editor.user ? `编辑用户${editor.user.name}` : "新增用户"}>
          <div className="admin-user-drawer-head">
            <div>
              <span>{editor.mode === "edit" ? "编辑用户" : "新增用户"}</span>
              <strong>{editor.user?.name ?? "新用户"}</strong>
            </div>
            <button className="secondary-button" type="button" aria-label="关闭用户编辑面板" onClick={closeEditor}>
              <X size={16} aria-hidden="true" />
              关闭
            </button>
          </div>
          <form className="admin-user-editor" onSubmit={saveUser}>
            <label>
              <span>姓名</span>
              <input aria-label="用户姓名" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label>
              <span>手机号</span>
              <input aria-label="用户手机号" type="tel" value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
            </label>
            <label>
              <span>用户分组</span>
              <select aria-label="用户分组" value={draft.groupId} onChange={(event) => setDraft((current) => ({ ...current, groupId: event.target.value }))}>
                {(enabledGroups.length > 0 ? enabledGroups : groups).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label className="check-row">
              <input type="checkbox" checked={draft.groupLocked} onChange={(event) => setDraft((current) => ({ ...current, groupLocked: event.target.checked }))} />
              锁定用户分组
            </label>
            <label className="check-row">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
              启用用户
            </label>
            <div className="admin-user-permissions" aria-label="继承权限">
              <strong>继承权限</strong>
              <div>
                {inheritedPermissions.length > 0 ? inheritedPermissions.map((permission) => (
                  <span key={permission}><ShieldCheck size={14} aria-hidden="true" />{PERMISSION_LABELS[permission]}</span>
                )) : <span>当前分组无额外权限</span>}
              </div>
            </div>
            {editorError && <p className="form-message" role="alert">{editorError}</p>}
            <button className="primary-button" type="submit" disabled={savingAction === "save"}>
              {savingAction === "save" ? "保存中..." : "保存用户"}
            </button>
          </form>
          {editor.mode === "edit" && editor.user && (
            <div className="admin-user-identities" aria-label="Chat identity bindings">
              {(["wechat", "wecom"] as MessageChannel[]).map((platform) => {
                const label = PLATFORM_LABELS[platform];
                const current = editor.user?.identities[platform];
                const draftIdentity = identityDrafts[platform];
                const error = identityErrors[platform];
                return (
                  <section className="admin-user-identity-card" key={platform} aria-label={`${label} identity binding`}>
                    <div className="admin-user-identity-head">
                      <div>
                        <strong>{label}</strong>
                        <span>
                          {current
                            ? `Bound to ${current.displayName} (${current.externalUserId})`
                            : "No current binding"}
                        </span>
                      </div>
                      <button
                        className="secondary-button icon-button"
                        type="button"
                        aria-label={`Unbind ${label} identity`}
                        title={`Unbind ${label} identity`}
                        onClick={() => void unbindIdentity(platform)}
                        disabled={!current || savingAction === `identity-${platform}-unbind`}
                      >
                        <Unlink size={15} aria-hidden="true" />
                      </button>
                    </div>
                    <label>
                      <span>{label} stable identity</span>
                      <select
                        aria-label={`${label} stable identity`}
                        value={draftIdentity.selectedExternalUserId}
                        onChange={(event) => updateIdentityDraft(platform, {
                          selectedExternalUserId: event.target.value
                        })}
                      >
                        <option value="">Select discovered identity</option>
                        {availableIdentities[platform].map((identity) => (
                          <option key={identity.id} value={identity.externalUserId}>
                            {identity.displayName} ({identity.externalUserId})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{label} external ID</span>
                      <input
                        aria-label={`${label} external ID`}
                        value={draftIdentity.manualExternalUserId}
                        onChange={(event) => updateIdentityDraft(platform, {
                          manualExternalUserId: event.target.value
                        })}
                        placeholder="Manual external user ID"
                      />
                    </label>
                    <label>
                      <span>{label} display name</span>
                      <input
                        aria-label={`${label} display name`}
                        value={draftIdentity.manualDisplayName}
                        onChange={(event) => updateIdentityDraft(platform, {
                          manualDisplayName: event.target.value
                        })}
                        placeholder="Optional display name"
                      />
                    </label>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void bindIdentity(platform)}
                      disabled={savingAction === `identity-${platform}`}
                    >
                      <Link size={15} aria-hidden="true" />
                      {savingAction === `identity-${platform}` ? "Binding..." : `Bind ${label} identity`}
                    </button>
                    {error && <p className="admin-user-action-error" role="alert">{error}</p>}
                  </section>
                );
              })}
            </div>
          )}
          {editor.mode === "edit" && editor.user && canSetPassword && (
            <div className="admin-user-password">
              <label>
                <span>{editor.user.hasPassword ? "重置密码" : "设置密码"}</span>
                <input aria-label="用户新密码" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
              </label>
              <button className="secondary-button" type="button" onClick={() => void savePassword()} disabled={savingAction === "password"}>
                <KeyRound size={16} aria-hidden="true" />
                {savingAction === "password" ? "提交中..." : "设置/重置密码"}
              </button>
              {passwordError && <p className="admin-user-action-error" role="alert">{passwordError}</p>}
            </div>
          )}
        </aside>
      )}
      {identityConflict && (
        <div className="admin-dialog-backdrop">
          <section
            className="admin-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Confirm identity rebind"
          >
            <h4>Confirm identity rebind</h4>
            <p>
              This {PLATFORM_LABELS[identityConflict.platform]} identity is already bound
              {identityConflict.ownerName ? ` to ${identityConflict.ownerName}` : " to another user"}.
              Confirm to move it to the current user.
            </p>
            <div className="admin-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIdentityConflict(null)}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void bindIdentity(
                  identityConflict.platform,
                  identityConflict.token
                )}
              >
                确认换绑
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
