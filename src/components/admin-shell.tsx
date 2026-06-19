"use client";

import { useEffect, useState } from "react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { AdminConfigCenter, type AdminView, type WechatOrderLog } from "@/components/admin-panel";
import type { SessionUser } from "@/lib/client/auth";
import type { BoothRecord, ChatIdentity, Conversation, InboundMessageRecord, OutboundMessage, PendingWorkOrderSession, Person } from "@/lib/domain/types";
import type { TicketSummary } from "@/lib/domain/ticket-summary";
import type { AppConfig } from "@/lib/seed";
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

async function parseJsonMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { message?: string };
    return payload.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function AdminBackendShell({ view }: { view: AdminView }) {
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [currentAdmin, setCurrentAdmin] = useState<SessionUser | null>(null);
  const [data, setData] = useState<AdminBootstrap | null>(null);
  const [logs, setLogs] = useState<WechatOrderLog[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("后台数据加载失败");
      setData(await response.json());
      void fetch("/api/admin/wxauto-mcp", { cache: "no-store" }).catch(() => undefined);
      const logResponse = await fetch("/api/admin/wechat-order-logs?limit=50", { cache: "no-store" });
      if (!logResponse.ok && view !== "logs") {
        setLogs([]);
        return;
      }
      if (!logResponse.ok) throw new Error("微信下单日志加载失败");
      const payload = await logResponse.json() as { logs?: WechatOrderLog[] };
      setLogs(payload.logs ?? []);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "后台数据加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function resolveSession() {
      try {
        const response = await fetch("/api/auth/session?type=admin", {
          cache: "no-store"
        });
        if (!response.ok) throw new Error("后台登录状态检查失败");
        const payload = await response.json() as AdminSessionPayload;
        if (!active) return;
        if (payload.authenticated) {
          setAuthenticated(true);
          setBootstrapRequired(false);
          setCurrentAdmin(payload.user);
        } else {
          setAuthenticated(false);
          setBootstrapRequired(payload.bootstrapRequired);
          setCurrentAdmin(null);
        }
      } catch (sessionError) {
        if (!active) return;
        setAuthenticated(false);
        setBootstrapRequired(false);
        setCurrentAdmin(null);
        setError(sessionError instanceof Error ? sessionError.message : "后台登录状态检查失败");
      } finally {
        if (active) setAuthReady(true);
      }
    }
    void resolveSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (authReady && authenticated) void refresh();
  }, [authReady, authenticated]);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: String(formData.get("phone") ?? ""),
          password: String(formData.get("password") ?? "")
        })
      });
      if (!response.ok) {
        throw new Error(await parseJsonMessage(response, "后台登录失败"));
      }
      const payload = await response.json() as { user?: SessionUser };
      if (!payload.user) throw new Error("后台登录失败");
      setCurrentAdmin(payload.user);
      setBootstrapRequired(false);
      setData(null);
      setAuthenticated(true);
    } catch (loginError) {
      setMessage(loginError instanceof Error ? loginError.message : "后台登录失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function bootstrap(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setMessage(null);
    setError(null);
    setIsLoading(true);
    try {
      const response = await fetch("/api/admin/auth/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legacyPassword: String(formData.get("legacyPassword") ?? ""),
          name: String(formData.get("name") ?? ""),
          phone: String(formData.get("phone") ?? ""),
          password: String(formData.get("password") ?? ""),
          group: {
            mode: "create",
            name: String(formData.get("groupName") ?? "")
          }
        })
      });
      if (!response.ok) {
        throw new Error(await parseJsonMessage(response, "管理员初始化失败"));
      }
      const payload = await response.json() as { user?: SessionUser };
      if (!payload.user) throw new Error("管理员初始化失败");
      setCurrentAdmin(payload.user);
      setBootstrapRequired(false);
      setData(null);
      setAuthenticated(true);
    } catch (bootstrapError) {
      setMessage(bootstrapError instanceof Error ? bootstrapError.message : "管理员初始化失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function logout() {
    try {
      await fetch("/api/admin/auth/logout", { method: "POST" });
    } catch {
      // Local UI state should still reset if the network drops during logout.
    }
    setAuthenticated(false);
    setCurrentAdmin(null);
    setBootstrapRequired(false);
    setData(null);
    setLogs([]);
    setError(null);
    setMessage(null);
  }

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
