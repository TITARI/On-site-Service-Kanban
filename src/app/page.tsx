"use client";

import { useEffect, useMemo, useState } from "react";
import { LoginPanel } from "@/components/login-panel";
import { MobileShell, type MobileTab } from "@/components/mobile-shell";
import { TicketDetail } from "@/components/ticket-detail";
import { TicketList } from "@/components/ticket-list";
import { TicketSubmitForm } from "@/components/ticket-submit-form";
import type { CurrentUser } from "@/lib/client/auth";
import { removeLegacyStoredUser, resolveMobileSession } from "@/lib/client/session-auth";
import { findTicketByShortCode } from "@/lib/domain/ticket-links";
import { getPriorityDisplay } from "@/lib/domain/priority-label";
import type { Ticket } from "@/lib/domain/types";
import { defaultConfig, type AppConfig } from "@/lib/seed";
import { StatusMessage } from "@/components/status-message";

type TicketSummary = Pick<
  Ticket,
  | "id"
  | "title"
  | "boothNumber"
  | "companyName"
  | "companyShortName"
  | "description"
  | "issueType"
  | "submitterId"
  | "submitterName"
  | "submitterPhone"
  | "feedbackUsers"
  | "status"
  | "acceptedAt"
  | "handlerId"
  | "handlerName"
  | "handlerPhone"
  | "assignmentGroup"
  | "urgeCount"
  | "lastUrgedAt"
  | "urgeLevel"
  | "priorityScore"
  | "createdAt"
  | "updatedAt"
>;

type Bootstrap = {
  tickets: TicketSummary[];
  config: AppConfig;
};

type LoginBootstrap = {
  config: AppConfig;
};

function ticketIdFromCurrentUrl(tickets: TicketSummary[]) {
  if (typeof window === "undefined") return undefined;

  const url = new URL(window.location.href);
  const ticketId = url.searchParams.get("ticketId")?.trim();
  if (ticketId && tickets.some((ticket) => ticket.id === ticketId)) return ticketId;

  return findTicketByShortCode(tickets, url.searchParams.get("ticketCode"))?.id;
}

export default function HomePage() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [tab, setTab] = useState<MobileTab>("tickets");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [loginConfig, setLoginConfig] = useState<AppConfig | null>(null);
  const [isLoginConfigLoading, setIsLoginConfigLoading] = useState(false);
  const [loginConfigError, setLoginConfigError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [detailTicket, setDetailTicket] = useState<Ticket | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  function clearSessionState() {
    removeLegacyStoredUser();
    setUser(null);
    setData(null);
    setSelectedId(undefined);
    setDetailTicket(null);
    setDetailError(null);
    setError(null);
    setIsLoading(false);
    setTab("tickets");
    void refreshLoginConfig();
  }

  async function refreshLoginConfig() {
    setIsLoginConfigLoading(true);
    setLoginConfigError(null);
    try {
      const response = await fetch("/api/bootstrap?scope=login", { cache: "no-store" });
      if (!response.ok) throw new Error("登录配置加载失败");
      const payload = await response.json() as LoginBootstrap;
      setLoginConfig(payload.config);
    } catch (refreshError) {
      setLoginConfigError(refreshError instanceof Error ? refreshError.message : "登录配置加载失败");
    } finally {
      setIsLoginConfigLoading(false);
    }
  }

  async function refresh() {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/bootstrap?scope=mobile", { cache: "no-store" });
      if (response.status === 401) {
        clearSessionState();
        return;
      }
      if (!response.ok) throw new Error("数据加载失败");
      const payload = await response.json() as Bootstrap;
      setData(payload);
      setLoginConfig(payload.config);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "数据加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshTicketDetail(ticketId: string, fallback?: Ticket) {
    if (fallback) setDetailTicket(fallback);
    setIsDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetch(`/api/tickets/${ticketId}`, { cache: "no-store" });
      if (response.status === 401) {
        clearSessionState();
        return;
      }
      if (!response.ok) throw new Error("ticket detail failed");
      const payload = await response.json() as { ticket?: Ticket };
      if (payload.ticket) {
        setDetailTicket(payload.ticket);
      } else if (!fallback) {
        throw new Error("ticket detail missing");
      }
    } catch {
      if (!fallback) setDetailTicket(null);
      setDetailError("Ticket detail failed to load");
    } finally {
      setIsDetailLoading(false);
    }
  }

  useEffect(() => {
    if (user) void refresh();
  }, [user]);

  useEffect(() => {
    if (!data || selectedId) return;
    const linkedTicketId = ticketIdFromCurrentUrl(data.tickets);
    if (!linkedTicketId) return;
    setTab("tickets");
    setSelectedId(linkedTicketId);
  }, [data, selectedId]);

  useEffect(() => {
    let cancelled = false;

    async function initializeAuth() {
      try {
        const sessionUser = await resolveMobileSession();
        if (cancelled) return;
        if (sessionUser) {
          removeLegacyStoredUser();
          setUser(sessionUser);
          setTab("tickets");
          setIsLoading(true);
        } else {
          await refreshLoginConfig();
        }
      } catch {
        if (!cancelled) await refreshLoginConfig();
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    }

    void initializeAuth();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTicket = useMemo(() => data?.tickets.find((ticket) => ticket.id === selectedId), [data, selectedId]);
  const myTickets = useMemo(
    () => data?.tickets.filter((ticket) => ticket.submitterId === user?.id || ticket.handlerId === user?.id) ?? [],
    [data, user]
  );
  const selectedMineTicket = useMemo(() => myTickets.find((ticket) => ticket.id === selectedId), [myTickets, selectedId]);
  const isDetailPage = (tab === "tickets" && Boolean(selectedTicket)) || (tab === "mine" && Boolean(selectedMineTicket));
  const activeDetailTicket: Ticket | undefined = detailTicket && detailTicket.id === selectedId ? detailTicket : undefined;

  useEffect(() => {
    if (!selectedId || !isDetailPage) {
      setDetailTicket(null);
      setDetailError(null);
      setIsDetailLoading(false);
      return;
    }

    const inlineTicket = selectedTicket && "timeline" in selectedTicket ? selectedTicket as Ticket : undefined;
    void refreshTicketDetail(selectedId, inlineTicket);
  }, [selectedId, isDetailPage]);

  const metrics = useMemo(() => ({
    today: data?.tickets.length ?? 0,
    urgent: data?.tickets.filter((ticket) => getPriorityDisplay(ticket.priorityScore).tone === "critical").length ?? 0,
    pending: data?.tickets.filter((ticket) => ticket.status === "待受理").length ?? 0
  }), [data]);

  const changeTab = (nextTab: MobileTab) => {
    setTab(nextTab);
    setSelectedId(undefined);
    setDetailTicket(null);
    setDetailError(null);
  };

  const login = (nextUser: CurrentUser) => {
    setUser(nextUser);
    setData(null);
    setIsLoading(true);
    setDetailTicket(null);
    setDetailError(null);
    setTab("tickets");
    setSelectedId(undefined);
  };

  const logout = async () => {
    await fetch("/api/auth/mobile/logout", { method: "POST" });
    setUser(null);
    setData(null);
    setSelectedId(undefined);
    setDetailTicket(null);
    setDetailError(null);
    setError(null);
    setIsLoading(false);
    setTab("tickets");
    void refreshLoginConfig();
  };

  if (!authReady) return <main className="app-shell loading">加载中</main>;
  if (!user && isLoginConfigLoading && !loginConfig) return <main className="app-shell loading">加载中</main>;
  if (!user && loginConfigError && !loginConfig) {
    return (
      <main className="app-shell loading">
        <StatusMessage tone="error">{loginConfigError}</StatusMessage>
        <button className="primary-button" type="button" onClick={() => void refreshLoginConfig()}>重新加载</button>
      </main>
    );
  }
  if (!user) return <LoginPanel config={loginConfig ?? defaultConfig()} onLogin={login} />;
  if (isLoading && !data) return <main className="app-shell loading">加载中</main>;
  if (error && !data) {
    return (
      <main className="app-shell loading">
        <StatusMessage tone="error">{error}</StatusMessage>
        <button className="primary-button" type="button" onClick={() => void refresh()}>重新加载</button>
        <button className="secondary-button" type="button" onClick={() => void logout()}>退出登录</button>
      </main>
    );
  }
  if (!data) return null;

  const refreshCurrentDetail = () => {
    void refresh();
    if (selectedId) void refreshTicketDetail(selectedId);
  };

  return (
    <MobileShell activeTab={tab} currentUser={user} hideHero={isDetailPage} metrics={metrics} onLogout={() => void logout()} onTabChange={changeTab}>
      {tab === "submit" && <TicketSubmitForm config={data.config} currentUser={user} onSubmitted={() => { changeTab("tickets"); void refresh(); }} />}
      {tab === "tickets" && !selectedTicket && <TicketList tickets={data.tickets} onSelect={setSelectedId} />}
      {tab === "tickets" && selectedTicket && (
        <section className="detail-route">
          <button className="back-button" type="button" onClick={() => setSelectedId(undefined)}>返回工单列表</button>
          {isDetailLoading && !activeDetailTicket ? (
            <section className="empty-state">Loading...</section>
          ) : detailError && !activeDetailTicket ? (
            <section className="empty-state">{detailError}</section>
          ) : (
            <TicketDetail ticket={activeDetailTicket} currentUser={user} onRefresh={refreshCurrentDetail} />
          )}
        </section>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {tab === "mine" && !selectedMineTicket && <TicketList tickets={myTickets} onSelect={setSelectedId} />}
      {tab === "mine" && selectedMineTicket && (
        <section className="detail-route">
          <button className="back-button" type="button" onClick={() => setSelectedId(undefined)}>返回我的工单</button>
          {isDetailLoading && !activeDetailTicket ? (
            <section className="empty-state">Loading...</section>
          ) : detailError && !activeDetailTicket ? (
            <section className="empty-state">{detailError}</section>
          ) : (
            <TicketDetail ticket={activeDetailTicket} currentUser={user} onRefresh={refreshCurrentDetail} />
          )}
        </section>
      )}
    </MobileShell>
  );
}
