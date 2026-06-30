"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { AdminConfigCenter, type AdminView, type WechatOrderLog } from "@/components/admin-panel";
import type { SessionUser } from "@/lib/client/auth";
import type { BoothRecord, ChatIdentity, Conversation, InboundMessageRecord, OutboundMessage, PendingWorkOrderSession, Person } from "@/lib/domain/types";
import type { TicketSummary } from "@/lib/domain/ticket-summary";
import type { AppConfig } from "@/lib/seed";
import { apiJson } from "@/lib/client/api-request";
import { queryKeys } from "@/lib/client/query-keys";
import { StatusMessage } from "./status-message";

type AdminBootstrap = {
  tickets: TicketSummary[];
  booths: BoothRecord[];
  messageRecords: InboundMessageRecord[];
  people: Person[];
  chatIdentities: ChatIdentity[];
  conversations: Conversation[];
  pendingWorkOrderSessions: PendingWorkOrderSession[];
  outboundMessages: OutboundMessage[];
  config: AppConfig;
};

type AdminSessionPayload =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false; bootstrapRequired: boolean };

function adminTitle(view: AdminView) {
  if (view === "users") return "用户与权限";
  if (view === "logs") return "微信下单日志";
  if (view === "work-order-settings") return "工单设置";
  if (view === "exhibition-data") return "展览数据";
  if (view === "system") return "系统配置";
  return "后台工作台";
}

export function AdminBackendShell({ view }: { view: AdminView }) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: queryKeys.admin.session,
    queryFn: ({ signal }) => apiJson<AdminSessionPayload>(
      "/api/auth/session?type=admin",
      { cache: "no-store", signal },
      "后台登录状态检查失败"
    ),
    retry: false
  });
  const authenticated = sessionQuery.data?.authenticated === true;
  const bootstrapQuery = useQuery({
    queryKey: queryKeys.admin.bootstrap,
    queryFn: ({ signal }) => apiJson<AdminBootstrap>(
      "/api/bootstrap",
      { cache: "no-store", signal },
      "后台数据加载失败"
    ),
    enabled: authenticated
  });
  const logsQuery = useQuery({
    queryKey: queryKeys.admin.logs(50),
    queryFn: ({ signal }) => apiJson<{ logs?: WechatOrderLog[] }>(
      "/api/admin/wechat-order-logs?limit=50",
      { cache: "no-store", signal },
      "微信下单日志加载失败"
    ),
    enabled: authenticated
  });

  const loginMutation = useMutation({
    mutationFn: async (input: { phone: string; password: string }) => {
      const payload = await apiJson<{ user?: SessionUser }>(
        "/api/admin/auth/login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        "后台登录失败"
      );
      if (!payload.user) throw new Error("后台登录失败");
      return payload.user;
    }
  });
  const bootstrapMutation = useMutation({
    mutationFn: async (input: {
      legacyPassword: string;
      name: string;
      phone: string;
      password: string;
      group: { mode: "create"; name: string };
    }) => {
      const payload = await apiJson<{ user?: SessionUser }>(
        "/api/admin/auth/bootstrap",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        },
        "管理员初始化失败"
      );
      if (!payload.user) throw new Error("管理员初始化失败");
      return payload.user;
    }
  });
  const logoutMutation = useMutation({
    mutationFn: () => fetch("/api/admin/auth/logout", { method: "POST" }),
    onSettled: async () => {
      await queryClient.cancelQueries({ queryKey: queryKeys.admin.all });
      queryClient.removeQueries({
        queryKey: queryKeys.admin.all,
        predicate: (query) => query.queryKey[1] !== "session"
      });
      const loggedOutSession: AdminSessionPayload = {
        authenticated: false,
        bootstrapRequired: false
      };
      queryClient.setQueryData(queryKeys.admin.session, loggedOutSession);
    }
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.bootstrap }),
      queryClient.invalidateQueries({ queryKey: queryKeys.admin.logs(50) })
    ]);
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const user = await loginMutation.mutateAsync({
        phone: String(formData.get("phone") ?? ""),
        password: String(formData.get("password") ?? "")
      });
      queryClient.removeQueries({ queryKey: queryKeys.admin.bootstrap });
      const authenticatedSession: AdminSessionPayload = {
        authenticated: true,
        user
      };
      queryClient.setQueryData(queryKeys.admin.session, authenticatedSession);
    } catch {
      // Mutation error is rendered below.
    }
  }

  async function bootstrap(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    try {
      const user = await bootstrapMutation.mutateAsync({
        legacyPassword: String(formData.get("legacyPassword") ?? ""),
        name: String(formData.get("name") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        password: String(formData.get("password") ?? ""),
        group: {
          mode: "create",
          name: String(formData.get("groupName") ?? "")
        }
      });
      queryClient.removeQueries({ queryKey: queryKeys.admin.bootstrap });
      const authenticatedSession: AdminSessionPayload = {
        authenticated: true,
        user
      };
      queryClient.setQueryData(queryKeys.admin.session, authenticatedSession);
    } catch {
      // Mutation error is rendered below.
    }
  }

  async function logout() {
    await logoutMutation.mutateAsync().catch(() => undefined);
  }

  const authReady = !sessionQuery.isPending;
  const bootstrapRequired = sessionQuery.data?.authenticated === false && sessionQuery.data.bootstrapRequired;
  const currentAdmin = sessionQuery.data?.authenticated ? sessionQuery.data.user : null;
  const data = bootstrapQuery.data ?? null;
  const logs = logsQuery.data?.logs ?? [];
  const messageError = loginMutation.error ?? bootstrapMutation.error;
  const message = messageError instanceof Error ? messageError.message : null;
  const queryError = sessionQuery.error ?? bootstrapQuery.error ?? (view === "logs" ? logsQuery.error : null);
  const error = queryError instanceof Error ? queryError.message : null;
  const isLoading = loginMutation.isPending
    || bootstrapMutation.isPending
    || logoutMutation.isPending
    || (authenticated && bootstrapQuery.isPending);

  if (!authReady) return <main className="admin-page-shell loading">加载中</main>;

  if (!authenticated && bootstrapRequired) {
    return (
      <main className="admin-login-shell">
        <section className="admin-login-card">
          <div className="auth-hero-mark">
            <ShieldCheck size={26} aria-hidden="true" />
          </div>
          <p className="eyebrow">电脑端后台</p>
          <h1>首个管理员初始化</h1>
          <p className="auth-copy">创建首个后台管理员后，系统会关闭旧口令初始化入口。</p>
          <form className="auth-form" onSubmit={bootstrap}>
            <label>
              <span>初始化旧口令</span>
              <input name="legacyPassword" type="password" autoComplete="current-password" required />
            </label>
            <label>
              <span>管理员姓名</span>
              <input name="name" type="text" autoComplete="name" required />
            </label>
            <label>
              <span>管理员手机号</span>
              <input name="phone" type="tel" autoComplete="tel" required />
            </label>
            <label>
              <span>管理员密码</span>
              <input name="password" type="password" autoComplete="new-password" required />
            </label>
            <label>
              <span>管理员分组</span>
              <input name="groupName" type="text" defaultValue="管理员" required />
            </label>
            {message && <StatusMessage tone="error">{message}</StatusMessage>}
            <button className="primary-button" type="submit" disabled={isLoading}>
              <LogIn size={18} aria-hidden="true" />
              创建管理员
            </button>
          </form>
        </section>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <main className="admin-login-shell">
        <section className="admin-login-card">
          <div className="auth-hero-mark">
            <ShieldCheck size={26} aria-hidden="true" />
          </div>
          <p className="eyebrow">电脑端后台</p>
          <h1>后台配置登录</h1>
          <p className="auth-copy">登录后可进入工作台、查看微信下单日志、维护工单设置、集成配置和展览数据。</p>
          <form className="auth-form" onSubmit={login}>
            <label>
              <span>管理员手机号</span>
              <input name="phone" type="tel" autoComplete="username" required />
            </label>
            <label>
              <span>管理员密码</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {message && <StatusMessage tone="error">{message}</StatusMessage>}
            <button className="primary-button" type="submit" disabled={isLoading}>
              <LogIn size={18} aria-hidden="true" />
              进入后台
            </button>
          </form>
        </section>
      </main>
    );
  }

  if (isLoading && !data) return <main className="admin-page-shell loading">加载中</main>;

  if (error && !data) {
    return (
      <main className="admin-page-shell loading">
        <StatusMessage tone="error">{error}</StatusMessage>
        <button className="primary-button" type="button" onClick={() => void refresh()}>重新加载</button>
        <button className="secondary-button" type="button" onClick={() => void logout()}>退出后台</button>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="admin-page-shell">
      <div className="admin-page-toolbar">
        <div>
          <span>电脑端后台{currentAdmin ? ` · ${currentAdmin.name}` : ""}</span>
          <strong>{adminTitle(view)}</strong>
        </div>
        <button className="secondary-button" type="button" onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />退出后台</button>
      </div>
      <AdminConfigCenter
        view={view}
        config={data.config}
        booths={data.booths}
        tickets={data.tickets}
        messageRecords={data.messageRecords}
        people={data.people}
        chatIdentities={data.chatIdentities}
        conversations={data.conversations}
        pendingWorkOrderSessions={data.pendingWorkOrderSessions}
        outboundMessages={data.outboundMessages}
        wechatOrderLogs={logs}
        onRefresh={refresh}
      />
    </main>
  );
}
