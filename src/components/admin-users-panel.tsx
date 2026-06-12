"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unlink,
  Upload,
  X
} from "lucide-react";
import { AdminUserImport } from "@/components/admin-user-import";
import {
  type ManagedChatIdentity,
  permissionCodesForGroup,
  type PermissionCode,
  type UserListItem
} from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";

type UserEditorDraft = {
  personId?: string;
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  enabled: boolean;
};

type UserListResponse = {
  users: UserListItem[];
  total: number;
  page: number;
  pageSize: number;
};

type IdentityDraft = {
  identityId: string;
  externalUserId: string;
  displayName: string;
};

type IdentityConflict = {
  platform: "wechat" | "wecom";
  confirmationToken: string;
  conflict: {
    identityId: string;
    externalUserId: string;
    displayName: string;
    personId: string;
    personName?: string;
    personPhone?: string;
  };
};

const PAGE_SIZE = 20;

const PERMISSION_LABELS: Record<PermissionCode, string> = {
  "ticket.claim": "认领工单",
  "ticket.process": "处理工单",
  "ticket.accept": "验收工单",
  "admin.access": "后台管理"
};

function responseMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

async function readPayload(response: Response) {
  if (response.status === 204) return null;
  return await response.json().catch(() => null) as unknown;
}

function formatDateTime(value?: string) {
  if (!value) return "从未登录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function newUserDraft(groups: UserGroup[]): UserEditorDraft {
  return {
    name: "",
    phone: "",
    groupId: groups.find((group) => group.enabled)?.id ?? "",
    groupLocked: false,
    enabled: true
  };
}

function userDraft(user: UserListItem): UserEditorDraft {
  return {
    personId: user.personId,
    name: user.name,
    phone: user.phone,
    groupId: user.groupId,
    groupLocked: user.groupLocked,
    enabled: user.enabled
  };
}

function BindingSummary({
  user,
  platform
}: {
  user: UserListItem;
  platform: "wechat" | "wecom";
}) {
  const identity = user.identities[platform];
  if (!identity) return <span className="admin-user-binding empty">未绑定</span>;
  return (
    <span className="admin-user-binding" title={identity.externalUserId}>
      <strong>{identity.displayName || identity.externalUserId}</strong>
      <small>{identity.externalUserId}</small>
    </span>
  );
}

export function AdminUsersPanel({ groups }: { groups: UserGroup[] }) {
  const activeGroups = useMemo(() => groups.filter((group) => group.enabled), [groups]);
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [groupId, setGroupId] = useState("");
  const [enabled, setEnabled] = useState("");
  const [admin, setAdmin] = useState("");
  const [binding, setBinding] = useState("");
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<UserEditorDraft | null>(null);
  const [editorUser, setEditorUser] = useState<UserListItem | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [identityOptions, setIdentityOptions] = useState<ManagedChatIdentity[]>([]);
  const [identityDrafts, setIdentityDrafts] = useState<Record<"wechat" | "wecom", IdentityDraft>>({
    wechat: { identityId: "", externalUserId: "", displayName: "" },
    wecom: { identityId: "", externalUserId: "", displayName: "" }
  });
  const [identityLoading, setIdentityLoading] = useState(false);
  const [identityBusy, setIdentityBusy] = useState<"wechat" | "wecom" | null>(null);
  const [identityConflict, setIdentityConflict] = useState<IdentityConflict | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ personId: string; message: string } | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE)
    });
    if (search.trim()) params.set("search", search.trim());
    if (groupId) params.set("groupId", groupId);
    if (enabled) params.set("enabled", enabled);
    if (admin) params.set("admin", admin);
    if (binding) params.set("binding", binding);
    return params.toString();
  }, [admin, binding, enabled, groupId, page, search]);

  const loadUsers = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setListError(null);
    try {
      const response = await fetch(`/api/admin/users?${queryString}`, {
        cache: "no-store",
        signal
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, "用户列表加载失败"));
      const result = payload as UserListResponse;
      setUsers(result.users ?? []);
      setTotal(result.total ?? 0);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setListError(error instanceof Error ? error.message : "用户列表加载失败");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadUsers(controller.signal), 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadUsers, reloadVersion]);

  useEffect(() => {
    if (!editor) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editor]);

  function refreshUsers() {
    setReloadVersion((current) => current + 1);
  }

  function resetPage(setter: (value: string) => void, value: string) {
    setPage(1);
    setter(value);
  }

  function openCreate() {
    setEditor(newUserDraft(activeGroups));
    setEditorUser(null);
    setEditorError(null);
    setEditorMessage(null);
    setPassword("");
    setIdentityConflict(null);
  }

  function openEdit(user: UserListItem) {
    setEditor(userDraft(user));
    setEditorUser(user);
    setEditorError(null);
    setEditorMessage(null);
    setPassword("");
    setIdentityConflict(null);
    setIdentityDrafts({
      wechat: {
        identityId: user.identities.wechat?.id ?? "",
        externalUserId: user.identities.wechat?.externalUserId ?? "",
        displayName: user.identities.wechat?.displayName ?? ""
      },
      wecom: {
        identityId: user.identities.wecom?.id ?? "",
        externalUserId: user.identities.wecom?.externalUserId ?? "",
        displayName: user.identities.wecom?.displayName ?? ""
      }
    });
    void loadIdentityOptions();
  }

  function closeEditor() {
    setEditor(null);
    setEditorUser(null);
    setEditorError(null);
    setEditorMessage(null);
    setPassword("");
    setIdentityConflict(null);
  }

  async function loadIdentityOptions() {
    setIdentityLoading(true);
    try {
      const response = await fetch("/api/admin/chat-identities", { cache: "no-store" });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, "已识别账号加载失败"));
      setIdentityOptions((payload as { identities?: ManagedChatIdentity[] }).identities ?? []);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "已识别账号加载失败");
    } finally {
      setIdentityLoading(false);
    }
  }

  function patchIdentityDraft(platform: "wechat" | "wecom", patch: Partial<IdentityDraft>) {
    setIdentityDrafts((current) => ({
      ...current,
      [platform]: { ...current[platform], ...patch }
    }));
  }

  function applyUpdatedUser(user: UserListItem) {
    setEditorUser(user);
    setEditor(userDraft(user));
    setUsers((current) => current.map((item) => item.personId === user.personId ? user : item));
    setIdentityDrafts({
      wechat: {
        identityId: user.identities.wechat?.id ?? "",
        externalUserId: user.identities.wechat?.externalUserId ?? "",
        displayName: user.identities.wechat?.displayName ?? ""
      },
      wecom: {
        identityId: user.identities.wecom?.id ?? "",
        externalUserId: user.identities.wecom?.externalUserId ?? "",
        displayName: user.identities.wecom?.displayName ?? ""
      }
    });
  }

  async function bindPlatform(platform: "wechat" | "wecom", confirmationToken?: string) {
    if (!editor?.personId) return;
    const draft = identityDrafts[platform];
    setIdentityBusy(platform);
    setEditorError(null);
    setEditorMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${editor.personId}/chat-identities/${platform}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          identityId: draft.identityId || undefined,
          externalUserId: draft.identityId ? undefined : draft.externalUserId,
          displayName: draft.displayName,
          confirmationToken
        })
      });
      const payload = await readPayload(response);
      if (response.status === 409 && payload && typeof payload === "object") {
        const conflictPayload = payload as {
          code?: string;
          confirmationToken?: string;
          conflict?: IdentityConflict["conflict"];
        };
        if (
          conflictPayload.code === "IDENTITY_CONFLICT"
          && conflictPayload.confirmationToken
          && conflictPayload.conflict
        ) {
          setIdentityConflict({
            platform,
            confirmationToken: conflictPayload.confirmationToken,
            conflict: conflictPayload.conflict
          });
          return;
        }
      }
      if (!response.ok) throw new Error(responseMessage(payload, "账号绑定失败"));
      const user = (payload as { user: UserListItem }).user;
      applyUpdatedUser(user);
      setIdentityConflict(null);
      setEditorMessage(`${platform === "wechat" ? "微信" : "企微"}账号已绑定`);
      void loadIdentityOptions();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "账号绑定失败");
    } finally {
      setIdentityBusy(null);
    }
  }

  async function unbindPlatform(platform: "wechat" | "wecom") {
    if (!editor?.personId) return;
    if (!window.confirm(`确定解绑当前${platform === "wechat" ? "微信" : "企微"}账号？`)) return;
    setIdentityBusy(platform);
    setEditorError(null);
    setEditorMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${editor.personId}/chat-identities/${platform}`, {
        method: "DELETE"
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, "账号解绑失败"));
      applyUpdatedUser((payload as { user: UserListItem }).user);
      setEditorMessage(`${platform === "wechat" ? "微信" : "企微"}账号已解绑`);
      void loadIdentityOptions();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "账号解绑失败");
    } finally {
      setIdentityBusy(null);
    }
  }

  function patchEditor(patch: Partial<UserEditorDraft>) {
    setEditor((current) => current ? { ...current, ...patch } : current);
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    setSaving(true);
    setEditorError(null);
    setEditorMessage(null);
    try {
      const editing = Boolean(editor.personId);
      const response = await fetch(
        editing ? `/api/admin/users/${editor.personId}` : "/api/admin/users",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: editor.name,
            phone: editor.phone,
            groupId: editor.groupId,
            groupLocked: editor.groupLocked,
            enabled: editor.enabled
          })
        }
      );
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, editing ? "用户保存失败" : "用户创建失败"));
      const saved = (payload as { user: UserListItem }).user;
      setEditor(userDraft(saved));
      setEditorUser(saved);
      setEditorMessage(editing ? "用户信息已保存" : "用户已创建");
      refreshUsers();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "用户保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function changeEnabled(user: UserListItem) {
    const action = user.enabled ? "停用" : "启用";
    if (!window.confirm(`确定${action}${user.name}？${user.enabled ? "停用后其现有登录会立即失效。" : ""}`)) return;
    setBusyUserId(user.personId);
    setActionFeedback(null);
    try {
      const response = await fetch(
        `/api/admin/users/${user.personId}/${user.enabled ? "disable" : "enable"}`,
        { method: "POST" }
      );
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, `${action}用户失败`));
      refreshUsers();
    } catch (error) {
      setActionFeedback({
        personId: user.personId,
        message: error instanceof Error ? error.message : `${action}用户失败`
      });
    } finally {
      setBusyUserId(null);
    }
  }

  async function removeUser(user: UserListItem) {
    if (!window.confirm(`确定删除${user.name}？已有业务历史的用户将无法删除，只能停用。`)) return;
    setBusyUserId(user.personId);
    setActionFeedback(null);
    try {
      const response = await fetch(`/api/admin/users/${user.personId}`, { method: "DELETE" });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, "删除用户失败"));
      refreshUsers();
    } catch (error) {
      setActionFeedback({
        personId: user.personId,
        message: error instanceof Error ? error.message : "删除用户失败"
      });
    } finally {
      setBusyUserId(null);
    }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor?.personId) return;
    setPasswordSaving(true);
    setEditorError(null);
    setEditorMessage(null);
    try {
      const response = await fetch(`/api/admin/users/${editor.personId}/password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password })
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new Error(responseMessage(payload, "后台密码设置失败"));
      setPassword("");
      setEditorMessage("后台密码已更新");
      setEditorUser((current) => current ? { ...current, hasPassword: true } : current);
      refreshUsers();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "后台密码设置失败");
    } finally {
      setPasswordSaving(false);
    }
  }

  const selectedGroup = activeGroups.find((group) => group.id === editor?.groupId)
    ?? groups.find((group) => group.id === editor?.groupId);
  const inheritedPermissions = selectedGroup ? permissionCodesForGroup(selectedGroup) : [];
  const editorCanAdmin = inheritedPermissions.includes("admin.access");
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="admin-users-workspace" aria-label="用户与权限管理">
      <div className="admin-users-toolbar">
        <label className="admin-user-search">
          <span className="sr-only">搜索用户</span>
          <Search size={16} aria-hidden="true" />
          <input
            aria-label="搜索用户"
            value={search}
            onChange={(event) => resetPage(setSearch, event.target.value)}
            placeholder="姓名或手机号"
          />
        </label>
        <label>
          <span className="sr-only">用户分组</span>
          <select aria-label="用户分组" value={groupId} onChange={(event) => resetPage(setGroupId, event.target.value)}>
            <option value="">全部分组</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">启用状态</span>
          <select aria-label="启用状态" value={enabled} onChange={(event) => resetPage(setEnabled, event.target.value)}>
            <option value="">全部状态</option>
            <option value="true">已启用</option>
            <option value="false">已停用</option>
          </select>
        </label>
        <label>
          <span className="sr-only">后台权限</span>
          <select aria-label="后台权限" value={admin} onChange={(event) => resetPage(setAdmin, event.target.value)}>
            <option value="">全部权限</option>
            <option value="true">可进后台</option>
            <option value="false">不可进后台</option>
          </select>
        </label>
        <label>
          <span className="sr-only">账号绑定</span>
          <select aria-label="账号绑定" value={binding} onChange={(event) => resetPage(setBinding, event.target.value)}>
            <option value="">全部绑定</option>
            <option value="bound">已绑定</option>
            <option value="unbound">未绑定</option>
          </select>
        </label>
        <button className="admin-icon-button" type="button" onClick={refreshUsers} aria-label="刷新用户" title="刷新用户">
          <RefreshCw size={17} aria-hidden="true" />
        </button>
        <div className="admin-user-toolbar-actions">
          <button className="secondary-button" type="button" onClick={() => setImportOpen(true)}>
            <Upload size={17} aria-hidden="true" />
            批量导入
          </button>
          <button className="primary-button admin-user-create" type="button" onClick={openCreate}>
            <Plus size={17} aria-hidden="true" />
            新建用户
          </button>
        </div>
      </div>

      {listError && <p className="admin-user-list-message error" role="alert">{listError}</p>}

      <div className="admin-user-table" aria-busy={loading}>
        <div className="admin-user-row admin-user-head" role="row">
          <span>用户</span>
          <span>手机号</span>
          <span>分组</span>
          <span>继承权限</span>
          <span>微信</span>
          <span>企微</span>
          <span>状态</span>
          <span>最近登录</span>
          <span>操作</span>
        </div>
        {users.map((user) => (
          <article className="admin-user-row" key={user.personId}>
            <div className="admin-user-cell admin-user-name" data-label="用户">
              <strong>{user.name}</strong>
              <small>{user.groupLocked ? "分组已锁定" : "分组可同步"}</small>
            </div>
            <span className="admin-user-cell admin-user-phone" data-label="手机号">{user.phone}</span>
            <span className="admin-user-cell" data-label="分组">{user.groupName}</span>
            <div className="admin-user-cell admin-user-permissions" data-label="继承权限">
              {user.permissions.map((permission) => (
                <span key={permission}>{PERMISSION_LABELS[permission]}</span>
              ))}
              {user.permissions.length === 0 && <small>无业务权限</small>}
            </div>
            <div className="admin-user-cell" data-label="微信"><BindingSummary user={user} platform="wechat" /></div>
            <div className="admin-user-cell" data-label="企微"><BindingSummary user={user} platform="wecom" /></div>
            <span className={`admin-user-cell admin-user-status ${user.enabled ? "enabled" : "disabled"}`} data-label="状态">
              {user.enabled ? "启用" : "停用"}
            </span>
            <time className="admin-user-cell" data-label="最近登录">{formatDateTime(user.lastLoginAt)}</time>
            <div className="admin-user-cell admin-user-actions" data-label="操作">
              <button type="button" onClick={() => openEdit(user)} aria-label={`编辑${user.name}`} title="编辑用户">
                <Pencil size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void changeEnabled(user)}
                aria-label={`${user.enabled ? "停用" : "启用"}${user.name}`}
                title={user.enabled ? "停用用户" : "启用用户"}
                disabled={busyUserId === user.personId}
              >
                {user.enabled ? <Ban size={16} aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => void removeUser(user)}
                aria-label={`删除${user.name}`}
                title="删除用户"
                disabled={busyUserId === user.personId}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
              {actionFeedback?.personId === user.personId && (
                <small className="admin-user-action-error" role="alert">{actionFeedback.message}</small>
              )}
            </div>
          </article>
        ))}
        {!loading && users.length === 0 && <p className="admin-user-empty">没有符合条件的用户</p>}
        {loading && users.length === 0 && <p className="admin-user-empty">正在加载用户...</p>}
      </div>

      <footer className="admin-user-pagination">
        <span>共 {total} 位用户，第 {page} / {pageCount} 页</span>
        <div>
          <button
            className="admin-icon-button"
            type="button"
            aria-label="上一页"
            title="上一页"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <button
            className="admin-icon-button"
            type="button"
            aria-label="下一页"
            title="下一页"
            disabled={page >= pageCount || loading}
            onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </footer>

      {editor && (
        <div className="admin-user-drawer-layer">
          <button className="admin-user-drawer-scrim" type="button" aria-label="关闭用户编辑器" onClick={closeEditor} />
          <aside className="admin-user-drawer" role="dialog" aria-modal="true" aria-labelledby="admin-user-editor-title">
            <header>
              <div>
                <p className="eyebrow">{editor.personId ? "编辑用户" : "新建用户"}</p>
                <h2 id="admin-user-editor-title">{editor.personId ? editor.name : "创建用户档案"}</h2>
              </div>
              <button className="admin-icon-button" type="button" onClick={closeEditor} aria-label="关闭编辑器" title="关闭">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <form className="admin-user-editor-form" onSubmit={saveUser}>
              <div className="admin-user-form-grid">
                <label>
                  <span>姓名</span>
                  <input value={editor.name} onChange={(event) => patchEditor({ name: event.target.value })} required />
                </label>
                <label>
                  <span>手机号</span>
                  <input
                    value={editor.phone}
                    onChange={(event) => patchEditor({ phone: event.target.value })}
                    inputMode="tel"
                    autoComplete="tel"
                    required
                  />
                </label>
                <label>
                  <span>用户分组</span>
                  <select value={editor.groupId} onChange={(event) => patchEditor({ groupId: event.target.value })} required>
                    {activeGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                </label>
              </div>

              <div className="admin-user-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={editor.groupLocked}
                    onChange={(event) => patchEditor({ groupLocked: event.target.checked })}
                  />
                  <span>锁定用户分组</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={editor.enabled}
                    onChange={(event) => patchEditor({ enabled: event.target.checked })}
                  />
                  <span>启用用户</span>
                </label>
              </div>

              <section className="admin-user-inherited">
                <div>
                  <strong>继承权限</strong>
                  <span>权限由“{selectedGroup?.name ?? "未选择分组"}”统一授予，不能在用户上单独修改。</span>
                </div>
                <div className="admin-user-permission-list">
                  {inheritedPermissions.map((permission) => (
                    <span key={permission}>{PERMISSION_LABELS[permission]}</span>
                  ))}
                  {inheritedPermissions.length === 0 && <small>该分组不授予业务权限</small>}
                </div>
              </section>

              {editorUser && (
                <section className="admin-user-binding-editor">
                  <div className="admin-user-binding-title">
                    <strong>账号绑定</strong>
                    <span>每个平台最多绑定一个稳定账号标识。</span>
                  </div>
                  {(["wechat", "wecom"] as const).map((platform) => {
                    const label = platform === "wechat" ? "微信" : "企微";
                    const current = editorUser.identities[platform];
                    const options = identityOptions.filter((identity) => identity.platform === platform);
                    const draft = identityDrafts[platform];
                    return (
                      <div className="admin-user-binding-control" key={platform}>
                        <header>
                          <div>
                            <strong>{label}</strong>
                            <span>{current ? `${current.displayName} · ${current.externalUserId}` : "未绑定"}</span>
                          </div>
                          {current && (
                            <button
                              className="admin-icon-button"
                              type="button"
                              onClick={() => void unbindPlatform(platform)}
                              aria-label={`解绑${label}账号`}
                              title={`解绑${label}账号`}
                              disabled={identityBusy === platform}
                            >
                              <Unlink size={16} aria-hidden="true" />
                            </button>
                          )}
                        </header>
                        <label>
                          <span>{label}已识别账号</span>
                          <select
                            aria-label={`${label}已识别账号`}
                            value={draft.identityId}
                            disabled={identityLoading}
                            onChange={(event) => {
                              const identityId = event.target.value;
                              const selected = identityOptions.find((identity) => identity.id === identityId);
                              patchIdentityDraft(platform, {
                                identityId,
                                externalUserId: selected?.externalUserId ?? "",
                                displayName: selected?.displayName ?? ""
                              });
                            }}
                          >
                            <option value="">手工填写稳定账号标识</option>
                            {options.map((identity) => (
                              <option key={identity.id} value={identity.id}>
                                {identity.displayName} · {identity.externalUserId}
                                {identity.personName ? `（已绑定 ${identity.personName}）` : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="admin-user-binding-fields">
                          <label>
                            <span>账号标识</span>
                            <input
                              value={draft.externalUserId}
                              onChange={(event) => patchIdentityDraft(platform, {
                                identityId: "",
                                externalUserId: event.target.value
                              })}
                              disabled={Boolean(draft.identityId)}
                              placeholder={platform === "wechat" ? "wxid_..." : "企业微信 external_userid"}
                            />
                          </label>
                          <label>
                            <span>显示名称</span>
                            <input
                              value={draft.displayName}
                              onChange={(event) => patchIdentityDraft(platform, {
                                displayName: event.target.value
                              })}
                              placeholder={`${label}显示名称`}
                            />
                          </label>
                        </div>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={() => void bindPlatform(platform)}
                          disabled={identityBusy === platform || (!draft.identityId && !draft.externalUserId.trim())}
                        >
                          <Link2 size={16} aria-hidden="true" />
                          {identityBusy === platform ? "绑定中..." : `绑定${label}账号`}
                        </button>
                      </div>
                    );
                  })}
                </section>
              )}

              {editorError && <p className="admin-user-editor-message error" role="alert">{editorError}</p>}
              {editorMessage && <p className="admin-user-editor-message success" role="status">{editorMessage}</p>}

              <div className="admin-user-editor-actions">
                <button className="secondary-button" type="button" onClick={closeEditor}>取消</button>
                <button className="primary-button" type="submit" disabled={saving}>
                  {saving ? "保存中..." : "保存用户"}
                </button>
              </div>
            </form>

            {editor.personId && editorCanAdmin && (
              <form className="admin-user-password-form" onSubmit={savePassword}>
                <div>
                  <KeyRound size={18} aria-hidden="true" />
                  <div>
                    <h3>后台密码</h3>
                    <p>{editorUser?.hasPassword ? "重置该管理员的后台登录密码。" : "为该管理员设置首次后台登录密码。"}</p>
                  </div>
                </div>
                <label>
                  <span>新后台密码</span>
                  <input
                    type="password"
                    minLength={10}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button className="secondary-button" type="submit" disabled={passwordSaving}>
                  {passwordSaving ? "设置中..." : "设置后台密码"}
                </button>
              </form>
            )}
          </aside>
          {identityConflict && (
            <div className="admin-user-conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="identity-conflict-title">
              <h3 id="identity-conflict-title">确认换绑账号</h3>
              <p>
                {identityConflict.conflict.displayName}（{identityConflict.conflict.externalUserId}）
                当前属于 {identityConflict.conflict.personName ?? "其他用户"}
                {identityConflict.conflict.personPhone ? ` ${identityConflict.conflict.personPhone}` : ""}。
              </p>
              <span>确认后，该账号会从原用户解绑并转移到当前用户。</span>
              <div>
                <button className="secondary-button" type="button" onClick={() => setIdentityConflict(null)}>取消</button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void bindPlatform(identityConflict.platform, identityConflict.confirmationToken)}
                  disabled={identityBusy === identityConflict.platform}
                >
                  确认换绑
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {importOpen && (
        <AdminUserImport
          onClose={() => setImportOpen(false)}
          onCompleted={refreshUsers}
        />
      )}
    </section>
  );
}
