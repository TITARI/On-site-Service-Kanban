"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState
} from "@tanstack/react-table";
import {
  Ban,
  Building2,
  CheckCircle2,
  FilterX,
  Link,
  KeyRound,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  SearchX,
  ShieldCheck,
  Trash2,
  Unlink,
  Upload,
  X
} from "lucide-react";
import type { PermissionCode, UserListItem } from "@/lib/domain/access-control";
import type { ChatIdentity, MessageChannel, UserGroup } from "@/lib/domain/types";
import { apiFetch, apiJson } from "@/lib/client/api-request";
import { queryKeys } from "@/lib/client/query-keys";
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
  wechat: "微信",
  wecom: "企业微信"
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

function usersUrl(filters: FilterState, pagination: PaginationState) {
  const params = new URLSearchParams({
    page: String(pagination.pageIndex + 1),
    pageSize: String(pagination.pageSize)
  });
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

function BindingSummary({
  user,
  platform
}: {
  user: UserListItem;
  platform: MessageChannel;
}) {
  const identity = user.identities[platform];
  const label = PLATFORM_LABELS[platform];
  const PlatformIcon = platform === "wechat" ? MessageCircle : Building2;

  return (
    <span className={`admin-user-binding ${identity ? "" : "empty"}`}>
      <PlatformIcon size={15} aria-hidden="true" />
      <span>
        <strong>{label}</strong>
        <small title={identity?.externalUserId}>
          {identity ? identity.displayName || identity.externalUserId : "未绑定"}
        </small>
      </span>
    </span>
  );
}

export function AdminUsersPanel({
  groups
}: {
  groups: UserGroup[];
}) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [draft, setDraft] = useState<DraftState>(() => draftFromUser(undefined, groups));
  const [editorError, setEditorError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [identityDrafts, setIdentityDrafts] = useState<Record<MessageChannel, IdentityDraft>>(EMPTY_IDENTITY_DRAFT);
  const [identityErrors, setIdentityErrors] = useState<Partial<Record<MessageChannel, string>>>({});
  const [identityConflict, setIdentityConflict] = useState<ConflictState | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20
  });

  const usersQuery = useQuery({
    queryKey: [
      ...queryKeys.admin.users.list(appliedFilters),
      pagination.pageIndex,
      pagination.pageSize
    ],
    queryFn: ({ signal }) => apiJson<UserPayload>(
      usersUrl(appliedFilters, pagination),
      { cache: "no-store", signal },
      "用户列表加载失败"
    ),
    placeholderData: (previous) => previous
  });
  const identityQueries = {
    wechat: useQuery({
      queryKey: queryKeys.admin.users.identities("wechat"),
      queryFn: ({ signal }) => apiJson<{ identities?: ChatIdentity[] }>(
        "/api/admin/chat-identities?platform=wechat",
        { cache: "no-store", signal },
        "微信身份加载失败"
      ),
      enabled: editor?.mode === "edit"
    }),
    wecom: useQuery({
      queryKey: queryKeys.admin.users.identities("wecom"),
      queryFn: ({ signal }) => apiJson<{ identities?: ChatIdentity[] }>(
        "/api/admin/chat-identities?platform=wecom",
        { cache: "no-store", signal },
        "企业微信身份加载失败"
      ),
      enabled: editor?.mode === "edit"
    })
  };
  const users = usersQuery.data?.users ?? [];
  const total = usersQuery.data?.total ?? users.length;
  const loading = usersQuery.isFetching;
  const listError = usersQuery.error instanceof Error ? usersQuery.error.message : null;
  const availableIdentities: Record<MessageChannel, ChatIdentity[]> = {
    wechat: identityQueries.wechat.data?.identities ?? [],
    wecom: identityQueries.wecom.data?.identities ?? []
  };
  const queryClient = useQueryClient();

  async function invalidateUserData(platform?: MessageChannel) {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.bootstrap })
    ];
    if (platform) {
      invalidations.push(queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.identities(platform) }));
    }
    await Promise.all(invalidations);
  }

  const identityMutation = useMutation({
    mutationFn: async (variables: {
      kind: "bind" | "unbind";
      personId: string;
      platform: MessageChannel;
      externalUserId?: string;
      displayName?: string;
      confirmationToken?: string;
    }) => {
      const endpoint = `/api/admin/users/${variables.personId}/chat-identities/${variables.platform}`;
      if (variables.kind === "unbind") {
        await apiFetch(endpoint, { method: "DELETE" }, `${PLATFORM_LABELS[variables.platform]}解绑失败`);
        return { kind: "unbound" as const };
      }

      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalUserId: variables.externalUserId,
          displayName: variables.displayName,
          ...(variables.confirmationToken ? { confirmationToken: variables.confirmationToken } : {})
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
          return { kind: "conflict" as const, payload };
        }
        throw new Error(payload.message ?? `${PLATFORM_LABELS[variables.platform]}绑定失败`);
      }
      if (!response.ok) throw new Error(await responseMessage(response, `${PLATFORM_LABELS[variables.platform]}绑定失败`));
      const payload = await response.json() as { identity?: ChatIdentity };
      return { kind: "bound" as const, identity: payload.identity };
    }
  });

  const saveUserMutation = useMutation({
    mutationFn: async (variables: { endpoint: string; method: "PATCH" | "POST"; body: DraftState }) => {
      await apiFetch(variables.endpoint, {
        method: variables.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(variables.body)
      }, "用户保存失败");
    }
  });

  const userActionMutation = useMutation({
    mutationFn: async (variables: { personId: string; action: "enable" | "disable" | "delete"; label: string }) => {
      const endpoint = variables.action === "delete"
        ? `/api/admin/users/${variables.personId}`
        : `/api/admin/users/${variables.personId}/${variables.action}`;
      await apiFetch(endpoint, {
        method: variables.action === "delete" ? "DELETE" : "POST"
      }, `${variables.label}用户失败`);
    }
  });

  const passwordMutation = useMutation({
    mutationFn: async (variables: { personId: string; password: string }) => {
      await apiFetch(`/api/admin/users/${variables.personId}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: variables.password })
      }, "密码设置失败");
    }
  });

  const savingAction = identityMutation.isPending
    ? identityMutation.variables?.kind === "unbind"
      ? `identity-${identityMutation.variables.platform}-unbind`
      : `identity-${identityMutation.variables?.platform}`
    : saveUserMutation.isPending
      ? "save"
      : userActionMutation.isPending
        ? `${userActionMutation.variables?.personId}-${userActionMutation.variables?.action}`
        : passwordMutation.isPending
          ? "password"
          : null;

  const enabledGroups = useMemo(() => groups.filter((group) => group.enabled), [groups]);
  const inheritedPermissions = useMemo(
    () => {
      const group = groups.find((item) => item.id === draft.groupId);
      return group ? permissionsForGroup(group) : editor?.user?.permissions ?? [];
    },
    [draft.groupId, editor?.user, groups]
  );
  const canSetPassword = inheritedPermissions.includes("admin.access");

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
        [platform]: `请选择或填写${PLATFORM_LABELS[platform]}外部标识`
      }));
      return;
    }
    setIdentityErrors((current) => ({ ...current, [platform]: "" }));
    try {
      const result = await identityMutation.mutateAsync({
        kind: "bind",
        personId: editor.user.personId,
        platform,
        externalUserId,
        displayName,
        confirmationToken
      });
      if (result.kind === "conflict") {
        setIdentityConflict({
          platform,
          token: result.payload.confirmationToken!,
          externalUserId,
          displayName,
          ownerName: result.payload.currentOwner?.name
        });
        return;
      }
      setIdentityConflict(null);
      if (result.kind === "bound" && result.identity) {
        updateEditorIdentity(platform, result.identity);
      }
      await invalidateUserData(platform);
    } catch (error) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: error instanceof Error ? error.message : `${PLATFORM_LABELS[platform]}绑定失败`
      }));
    }
  }

  async function unbindIdentity(platform: MessageChannel) {
    if (!editor?.user) return;
    setIdentityErrors((current) => ({ ...current, [platform]: "" }));
    try {
      await identityMutation.mutateAsync({
        kind: "unbind",
        personId: editor.user.personId,
        platform
      });
      updateEditorIdentity(platform);
      await invalidateUserData(platform);
    } catch (error) {
      setIdentityErrors((current) => ({
        ...current,
        [platform]: error instanceof Error ? error.message : `${PLATFORM_LABELS[platform]}解绑失败`
      }));
    }
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.phone.trim() || !draft.groupId) {
      setEditorError("请填写姓名、手机号并选择分组");
      return;
    }
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
      await saveUserMutation.mutateAsync({
        endpoint,
        method: editor?.mode === "edit" ? "PATCH" : "POST",
        body
      });
      await invalidateUserData();
      closeEditor();
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "用户保存失败");
    }
  }

  async function runUserAction(user: UserListItem, action: "enable" | "disable" | "delete") {
    const actionLabel = action === "enable" ? "启用" : action === "disable" ? "停用" : "删除";
    if (!window.confirm(`确认${actionLabel}${user.name}？`)) return;
    const key = `${user.personId}-${action}`;
    setActionErrors((current) => ({ ...current, [key]: "" }));
    try {
      await userActionMutation.mutateAsync({ personId: user.personId, action, label: actionLabel });
      await invalidateUserData();
    } catch (error) {
      setActionErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : `${actionLabel}用户失败`
      }));
    }
  }

  async function savePassword() {
    if (!editor?.user || !password.trim()) {
      setPasswordError("请填写新密码");
      return;
    }
    setPasswordError(null);
    try {
      await passwordMutation.mutateAsync({ personId: editor.user.personId, password });
      setPassword("");
      await invalidateUserData();
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "密码设置失败");
    }
  }

  const columns = useMemo<ColumnDef<UserListItem>[]>(() => [
    {
      id: "user",
      header: "用户",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="admin-user-cell admin-user-name" role="cell" data-label="用户">
            <span className="admin-user-name-line">
              <strong>{item.name}</strong>
              {item.groupLocked && <span className="admin-user-lock-label">分组锁定</span>}
            </span>
            <small>{item.phone}</small>
          </div>
        );
      }
    },
    {
      id: "access",
      header: "分组与继承权限",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="admin-user-cell admin-user-access" role="cell" data-label="分组与继承权限">
            <strong>{item.groupName}</strong>
            <div className="admin-user-permissions">
              {item.permissions.map((permission) => (
                <span key={permission}>{PERMISSION_LABELS[permission]}</span>
              ))}
              {item.permissions.length === 0 && <small>无业务权限</small>}
            </div>
          </div>
        );
      }
    },
    {
      id: "bindings",
      header: "消息账号",
      cell: ({ row }) => (
        <div className="admin-user-cell admin-user-bindings" role="cell" data-label="消息账号">
          <BindingSummary user={row.original} platform="wechat" />
          <BindingSummary user={row.original} platform="wecom" />
        </div>
      )
    },
    {
      id: "status",
      header: "账号状态",
      cell: ({ row }) => {
        const item = row.original;
        const isAdmin = item.permissions.includes("admin.access");
        return (
          <div className="admin-user-cell admin-user-account-state" role="cell" data-label="账号状态">
            <span className={`admin-user-status ${item.enabled ? "enabled" : "disabled"}`}>
              <i aria-hidden="true" />
              {item.enabled ? "已启用" : "已停用"}
            </span>
            <small>
              {isAdmin ? (item.hasPassword ? "后台密码已设置" : "后台密码未设置") : "无后台登录"}
              {" · "}
              {formatDateTime(item.lastLoginAt)}
            </small>
          </div>
        );
      }
    },
    {
      id: "actions",
      header: "操作",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="admin-user-actions" role="cell" data-label="操作">
            <button className="secondary-button" type="button" aria-label={`编辑${item.name}`} onClick={() => openEditor("edit", item)} title="编辑用户">
              <Pencil size={17} aria-hidden="true" />
            </button>
            {item.enabled ? (
              <button className="secondary-button" type="button" aria-label={`停用${item.name}`} title="停用用户" onClick={() => void runUserAction(item, "disable")} disabled={savingAction === `${item.personId}-disable`}>
                <Ban size={17} aria-hidden="true" />
              </button>
            ) : (
              <button className="secondary-button" type="button" aria-label={`启用${item.name}`} title="启用用户" onClick={() => void runUserAction(item, "enable")} disabled={savingAction === `${item.personId}-enable`}>
                <CheckCircle2 size={17} aria-hidden="true" />
              </button>
            )}
            <button className="danger-button" type="button" aria-label={`删除${item.name}`} title="删除用户" onClick={() => void runUserAction(item, "delete")} disabled={savingAction === `${item.personId}-delete`}>
              <Trash2 size={17} aria-hidden="true" />
            </button>
            {["enable", "disable", "delete"].map((action) => {
              const key = `${item.personId}-${action}`;
              return actionErrors[key] ? <p className="admin-user-action-error" role="alert" key={key}>{actionErrors[key]}</p> : null;
            })}
          </div>
        );
      }
    }
  ], [actionErrors, groups, savingAction]);

  const table = useReactTable({
    data: users,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.personId,
    manualPagination: true,
    rowCount: total,
    state: { pagination },
    onPaginationChange: setPagination
  });
  const pageCount = Math.max(table.getPageCount(), 1);

  useEffect(() => {
    setPagination((current) => current.pageIndex < pageCount
      ? current
      : { ...current, pageIndex: pageCount - 1 });
  }, [pageCount]);

  const hasActiveFilters = Boolean(
    filters.search.trim()
    || filters.groupId
    || filters.enabled
    || filters.admin
    || filters.binding
  );

  function clearFilters() {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  }

  return (
    <Dialog.Root open={importOpen} onOpenChange={setImportOpen}>
      <section className="admin-card admin-users-panel" aria-label="用户与权限管理">
      <div className="admin-card-head admin-users-head">
        <div>
          <h3>用户与权限</h3>
          <p>按人员、分组、后台权限和微信绑定状态筛选，维护账号启停和继承权限。</p>
        </div>
      </div>

      <form
        className="admin-users-commandbar"
        onSubmit={(event) => {
          event.preventDefault();
          const nextFilters = { ...filters };
          setPagination((current) => ({ ...current, pageIndex: 0 }));
          if (JSON.stringify(nextFilters) === JSON.stringify(appliedFilters)) {
            if (pagination.pageIndex === 0) void usersQuery.refetch();
          } else {
            setAppliedFilters(nextFilters);
          }
        }}
      >
        <div className="admin-users-control-strip">
          <div className="admin-users-search-group">
            <label className="admin-user-search">
              <span className="sr-only">搜索姓名或手机号</span>
              <Search size={17} aria-hidden="true" />
              <input
                aria-label="搜索姓名或手机号"
                value={filters.search}
                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                placeholder="搜索姓名或手机号"
              />
            </label>
            <span className="admin-user-result-count" aria-live="polite">
              {loading ? "正在更新" : `${total} 位用户`}
            </span>
          </div>
          <div className="admin-users-filterbar" aria-label="筛选用户">
            <label className="admin-user-filter">
              <span>分组</span>
              <select aria-label="筛选用户分组" value={filters.groupId} onChange={(event) => setFilters((current) => ({ ...current, groupId: event.target.value }))}>
                <option value="">全部</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label className="admin-user-filter">
              <span>状态</span>
              <select aria-label="筛选用户状态" value={filters.enabled} onChange={(event) => setFilters((current) => ({ ...current, enabled: event.target.value }))}>
                <option value="">全部</option>
                <option value="true">已启用</option>
                <option value="false">已停用</option>
              </select>
            </label>
            <label className="admin-user-filter">
              <span>后台</span>
              <select aria-label="筛选后台权限" value={filters.admin} onChange={(event) => setFilters((current) => ({ ...current, admin: event.target.value }))}>
                <option value="">全部</option>
                <option value="true">可登录</option>
                <option value="false">不可登录</option>
              </select>
            </label>
            <label className="admin-user-filter">
              <span>绑定</span>
              <select aria-label="筛选绑定状态" value={filters.binding} onChange={(event) => setFilters((current) => ({ ...current, binding: event.target.value }))}>
                <option value="">全部</option>
                <option value="bound">已绑定</option>
                <option value="unbound">未绑定</option>
              </select>
            </label>
            {hasActiveFilters && (
              <button className="admin-user-clear-filters" type="button" onClick={clearFilters}>
                <FilterX size={16} aria-hidden="true" />
                清除筛选
              </button>
            )}
          </div>
        </div>
        <div className="admin-user-toolbar-actions">
          <button className="primary-button" type="submit" disabled={loading}>
            <Search size={17} aria-hidden="true" />
            筛选用户
          </button>
          <Dialog.Trigger asChild>
            <button className="secondary-button" type="button">
              <Upload size={17} aria-hidden="true" />
              批量导入
            </button>
          </Dialog.Trigger>
          <button className="primary-button admin-user-create" type="button" onClick={() => openEditor("create")}>
            <Plus size={17} aria-hidden="true" />
            新增用户
          </button>
        </div>
      </form>

      {listError && <p className="admin-user-list-message error" role="alert">{listError}</p>}

      <div className="admin-user-table" role="table" aria-label="后台用户列表" aria-busy={loading}>
        {table.getHeaderGroups().map((headerGroup) => (
          <div className="admin-user-row admin-user-head" role="row" key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <span role="columnheader" key={header.id}>
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              </span>
            ))}
          </div>
        ))}
        {table.getRowModel().rows.map((row) => (
          <article className="admin-user-row" role="row" key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <Fragment key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </Fragment>
            ))}
          </article>
        ))}
        {!loading && users.length === 0 && (
          <div className="admin-user-empty">
            <SearchX size={22} aria-hidden="true" />
            <strong>没有符合条件的用户</strong>
            {hasActiveFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}
          </div>
        )}
        {loading && users.length === 0 && (
          <div className="admin-user-loading" aria-label="正在加载用户">
            {[0, 1, 2].map((item) => <span key={item} />)}
          </div>
        )}
      </div>
      <nav className="admin-users-commandbar admin-user-toolbar-actions" aria-label="用户分页">
        <button
          className="secondary-button"
          type="button"
          aria-label="上一页"
          onClick={() => table.previousPage()}
          disabled={!table.getCanPreviousPage() || loading}
        >
          上一页
        </button>
        <span>第 {pagination.pageIndex + 1} / {pageCount} 页</span>
        <button
          className="secondary-button"
          type="button"
          aria-label="下一页"
          onClick={() => table.nextPage()}
          disabled={!table.getCanNextPage() || loading}
        >
          下一页
        </button>
      </nav>

      {importOpen && (
        <AdminUserImport
          onCompleted={async () => {
            await invalidateUserData();
          }}
        />
      )}

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
            <div className="admin-user-identities" aria-label="消息身份绑定">
              {(["wechat", "wecom"] as MessageChannel[]).map((platform) => {
                const label = PLATFORM_LABELS[platform];
                const current = editor.user?.identities[platform];
                const draftIdentity = identityDrafts[platform];
                const queryError = identityQueries[platform].error;
                const error = identityErrors[platform]
                  || (queryError instanceof Error ? queryError.message : "");
                return (
                  <section className="admin-user-identity-card" key={platform} aria-label={`${label}身份绑定`}>
                    <div className="admin-user-identity-head">
                      <div>
                        <strong>{label}</strong>
                        <span>
                          {current
                            ? `已绑定 ${current.displayName}（${current.externalUserId}）`
                            : "当前未绑定"}
                        </span>
                      </div>
                      <button
                        className="secondary-button icon-button"
                        type="button"
                        aria-label={`解绑${label}身份`}
                        title={`解绑${label}身份`}
                        onClick={() => void unbindIdentity(platform)}
                        disabled={!current || savingAction === `identity-${platform}-unbind`}
                      >
                        <Unlink size={15} aria-hidden="true" />
                      </button>
                    </div>
                    <label>
                      <span>{label}稳定身份</span>
                      <select
                        aria-label={`${label}稳定身份`}
                        value={draftIdentity.selectedExternalUserId}
                        onChange={(event) => updateIdentityDraft(platform, {
                          selectedExternalUserId: event.target.value
                        })}
                      >
                        <option value="">选择已识别身份</option>
                        {availableIdentities[platform].map((identity) => (
                          <option key={identity.id} value={identity.externalUserId}>
                            {identity.displayName} ({identity.externalUserId})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{label}外部标识</span>
                      <input
                        aria-label={`${label}外部标识`}
                        value={draftIdentity.manualExternalUserId}
                        onChange={(event) => updateIdentityDraft(platform, {
                          manualExternalUserId: event.target.value
                        })}
                        placeholder="手动填写外部用户标识"
                      />
                    </label>
                    <label>
                      <span>{label}显示名称</span>
                      <input
                        aria-label={`${label}显示名称`}
                        value={draftIdentity.manualDisplayName}
                        onChange={(event) => updateIdentityDraft(platform, {
                          manualDisplayName: event.target.value
                        })}
                        placeholder="可选显示名称"
                      />
                    </label>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void bindIdentity(platform)}
                      disabled={savingAction === `identity-${platform}`}
                    >
                      <Link size={15} aria-hidden="true" />
                      {savingAction === `identity-${platform}` ? "绑定中..." : `绑定${label}身份`}
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
            aria-label="确认身份换绑"
          >
            <h4>确认身份换绑</h4>
            <p>
              该{PLATFORM_LABELS[identityConflict.platform]}身份已经绑定
              {identityConflict.ownerName ? `给 ${identityConflict.ownerName}` : "给其他用户"}。
              确认后会转绑到当前用户。
            </p>
            <div className="admin-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIdentityConflict(null)}
              >
                取消
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
    </Dialog.Root>
  );
}
