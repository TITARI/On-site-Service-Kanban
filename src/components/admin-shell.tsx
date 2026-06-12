"use client";

import { useEffect, useState } from "react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { AdminConfigCenter, type AdminView, type WechatOrderLog } from "@/components/admin-panel";
import {
  bootstrapAdmin,
  loadSession,
  loginAdmin,
  logoutAdmin
} from "@/lib/client/session-auth";
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

function adminTitle(view: AdminView) {
  if (view === "logs") return "微信下单日志";
  if (view === "work-order-settings") return "工单设置";
  if (view === "exhibition-data") return "展览数据";
  if (view === "system") return "系统配置";
  return "后台工作台";
}

export function AdminBackendShell({ view }: { view: AdminView }) {
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [bootstrapConfig, setBootstrapConfig] = useState<AppConfig | null>(null);
  const [groupChoice, setGroupChoice] = useState("create");
  const [data, setData] = useState<AdminBootstrap | null>(null);
  const [logs, setLogs] = useState<WechatOrderLog[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("后台数据加载失败");
      setData(await response.json());
      void fetch("/api/admin/wxauto-mcp", { cache: "no-store" }).catch(() => undefined);
      {
        const logResponse = await fetch("/api/admin/wechat-order-logs?limit=50", { cache: "no-store" });
        if (!logResponse.ok && view !== "logs") {
          setLogs([]);
          return;
        }
        if (!logResponse.ok) throw new Error("微信下单日志加载失败");
        if (logResponse.ok) {
          const payload = await logResponse.json() as { logs?: WechatOrderLog[] };
          setLogs(payload.logs ?? []);
        }
      }
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "后台数据加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void loadSession("admin")
      .then(async (session) => {
        if (!active) return;
        if (session.authenticated) {
          setAuthenticated(true);
          setBootstrapRequired(false);
          return;
        }
        setAuthenticated(false);
        const required = Boolean(session.bootstrapRequired);
        setBootstrapRequired(required);
        if (required) {
          const response = await fetch("/api/bootstrap?scope=login", { cache: "no-store" });
          if (!response.ok) throw new Error("初始化分组加载失败");
          const payload = await response.json() as { config: AppConfig };
          if (active) setBootstrapConfig(payload.config);
        }
      })
      .catch((sessionError) => {
        if (active) {
          setMessage(sessionError instanceof Error ? sessionError.message : "后台登录状态检查失败");
        }
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
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
    setIsSubmitting(true);
    setMessage(null);
    try {
      await loginAdmin({
        phone: String(formData.get("phone") ?? ""),
        password: String(formData.get("password") ?? "")
      });
      setData(null);
      setAuthenticated(true);
    } catch (loginError) {
      setMessage(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function initialize(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const selectedGroup = String(formData.get("groupChoice") ?? "create");
    setIsSubmitting(true);
    setMessage(null);
    try {
      await bootstrapAdmin({
        legacyPassword: String(formData.get("legacyPassword") ?? ""),
        name: String(formData.get("name") ?? ""),
        phone: String(formData.get("phone") ?? ""),
        password: String(formData.get("password") ?? ""),
        group: selectedGroup === "create"
          ? {
              mode: "create",
              name: String(formData.get("groupName") ?? "")
            }
          : {
              mode: "existing",
              groupId: selectedGroup.replace(/^existing:/, "")
            }
      });
      setBootstrapRequired(false);
      setData(null);
      setAuthenticated(true);
    } catch (initializeError) {
      setMessage(initializeError instanceof Error ? initializeError.message : "初始化失败");
    } finally {
      setIsSubmitting(false);
    }
  }

  function logout() {
    void logoutAdmin().catch(() => undefined);
    setAuthenticated(false);
    setBootstrapRequired(false);
    setData(null);
    setLogs([]);
    setError(null);
    setMessage(null);
  }

  if (!authReady) return <main className="admin-page-shell loading">加载中</main>;

  if (!authenticated) {
    return (
      <main className="admin-login-shell">
        <section className="admin-login-card">
          <div className="auth-hero-mark">
            <ShieldCheck size={26} aria-hidden="true" />
          </div>
          <p className="eyebrow">PC 后台</p>
          <h1>{bootstrapRequired ? "初始化后台管理员" : "后台账号登录"}</h1>
          {bootstrapRequired ? (
            <>
              <p className="auth-copy">使用原后台口令创建首位管理员。完成后，原口令将永久停用。</p>
              <form className="auth-form" onSubmit={initialize}>
                <label>
                  <span>原后台口令</span>
                  <input name="legacyPassword" type="password" autoComplete="current-password" required />
                </label>
                <label>
                  <span>管理员姓名</span>
                  <input name="name" autoComplete="name" required />
                </label>
                <label>
                  <span>手机号</span>
                  <input name="phone" inputMode="tel" autoComplete="tel" required />
                </label>
                <label>
                  <span>新后台密码</span>
                  <input name="password" type="password" minLength={10} autoComplete="new-password" required />
                </label>
                <label>
                  <span>管理员分组</span>
                  <select
                    name="groupChoice"
                    value={groupChoice}
                    onChange={(event) => setGroupChoice(event.target.value)}
                  >
                    <option value="create">新建管理员分组</option>
                    {(bootstrapConfig?.userGroups ?? []).map((group) => (
                      <option key={group.id} value={`existing:${group.id}`}>{group.name}</option>
                    ))}
                  </select>
                </label>
                {groupChoice === "create" && (
                  <label>
                    <span>新分组名称</span>
                    <input name="groupName" defaultValue="系统管理员组" required />
                  </label>
                )}
                {message && <StatusMessage tone="error">{message}</StatusMessage>}
                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  <ShieldCheck size={18} aria-hidden="true" />
                  {isSubmitting ? "初始化中..." : "创建管理员并进入后台"}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="auth-copy">使用管理员手机号和后台密码登录。</p>
              <form className="auth-form" onSubmit={login}>
                <label>
                  <span>手机号</span>
                  <input name="phone" inputMode="tel" autoComplete="username" required />
                </label>
                <label>
                  <span>后台密码</span>
                  <input name="password" type="password" autoComplete="current-password" required />
                </label>
                {message && <StatusMessage tone="error">{message}</StatusMessage>}
                <button className="primary-button" type="submit" disabled={isSubmitting}>
                  <LogIn size={18} aria-hidden="true" />
                  {isSubmitting ? "登录中..." : "进入后台"}
                </button>
              </form>
            </>
          )}
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
        <button className="secondary-button" type="button" onClick={logout}>退出后台</button>
      </main>
    );
  }

  if (!data) return null;

  return (
    <main className="admin-page-shell">
      <div className="admin-page-toolbar">
        <div>
          <span>PC 后台</span>
          <strong>{adminTitle(view)}</strong>
        </div>
        <button className="secondary-button" type="button" onClick={logout}><LogOut size={16} aria-hidden="true" />退出后台</button>
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
