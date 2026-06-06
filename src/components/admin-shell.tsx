"use client";

import { useEffect, useState } from "react";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { AdminConfigCenter, type AdminView, type WechatOrderLog } from "@/components/admin-panel";
import { clearAdminSession, readAdminSession, storeAdminSession } from "@/lib/client/admin-auth";
import { isAdminPassword } from "@/lib/client/auth";
import type { BoothRecord, ChatIdentity, Conversation, InboundMessageRecord, OutboundMessage, PendingWorkOrderSession, Person, WxautoAgent } from "@/lib/domain/types";
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
  wxautoAgents: WxautoAgent[];
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
    setAuthenticated(readAdminSession());
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (authReady && authenticated) void refresh();
  }, [authReady, authenticated]);

  function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const password = String(formData.get("password") ?? "");
    if (!isAdminPassword(password)) {
      setMessage("后台口令不正确");
      return;
    }
    storeAdminSession();
    setMessage(null);
    setData(null);
    setAuthenticated(true);
  }

  function logout() {
    clearAdminSession();
    setAuthenticated(false);
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
          <h1>后台配置登录</h1>
          <p className="auth-copy">登录后可进入工作台、查看微信下单日志、维护工单设置、集成配置和展览数据。</p>
          <form className="auth-form" onSubmit={login}>
            <label>
              <span>后台口令</span>
              <input name="password" type="password" autoComplete="current-password" placeholder="请输入后台口令" required />
            </label>
            {message && <StatusMessage tone="error">{message}</StatusMessage>}
            <button className="primary-button" type="submit"><LogIn size={18} aria-hidden="true" />进入后台</button>
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
        wxautoAgents={data.wxautoAgents ?? []}
        wechatOrderLogs={logs}
        onRefresh={refresh}
      />
    </main>
  );
}
