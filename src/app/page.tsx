"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoginPanel } from "@/components/login-panel";
import { MobileShell, type MobileTab } from "@/components/mobile-shell";
import { TicketDetail } from "@/components/ticket-detail";
import { TicketList } from "@/components/ticket-list";
import { TicketSubmitForm } from "@/components/ticket-submit-form";
import { StatusMessage } from "@/components/status-message";
import type { CurrentUser } from "@/lib/client/auth";
import { apiJson, isUnauthorized } from "@/lib/client/api-request";
import { queryKeys } from "@/lib/client/query-keys";
import { removeLegacyStoredUser, resolveMobileSession } from "@/lib/client/session-auth";
import { findTicketByShortCode } from "@/lib/domain/ticket-links";
import { getPriorityDisplay } from "@/lib/domain/priority-label";
import type { Ticket } from "@/lib/domain/types";
import { defaultConfig, type AppConfig } from "@/lib/seed";

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
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MobileTab>("tickets");
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const sessionQuery = useQuery({
    queryKey: queryKeys.mobile.session,
    queryFn: ({ signal }) => resolveMobileSession(signal),
    retry: false
  });
  const user = sessionQuery.data ?? null;
  const loginConfigQuery = useQuery({
    queryKey: queryKeys.mobile.loginConfig,
    queryFn: ({ signal }) => apiJson<LoginBootstrap>(
      "/api/bootstrap?scope=login",
      { cache: "no-store", signal },
      "登录配置加载失败"
    ),
    enabled: (sessionQuery.isSuccess && !user) || sessionQuery.isError
  });
  const bootstrapQuery = useQuery({
    queryKey: queryKeys.mobile.bootstrap,
    queryFn: ({ signal }) => apiJson<Bootstrap>(
      "/api/bootstrap?scope=mobile",
      { cache: "no-store", signal },
      "数据加载失败"
    ),
    enabled: Boolean(user)
  });
  const data = bootstrapQuery.data ?? null;

  const selectedTicket = useMemo(
    () => data?.tickets.find((ticket) => ticket.id === selectedId),
    [data, selectedId]
  );
  const myTickets = useMemo(
    () => data?.tickets.filter((ticket) => ticket.submitterId === user?.id || ticket.handlerId === user?.id) ?? [],
    [data, user]
  );
  const selectedMineTicket = useMemo(
    () => myTickets.find((ticket) => ticket.id === selectedId),
    [myTickets, selectedId]
  );
  const isDetailPage = (tab === "tickets" && Boolean(selectedTicket)) || (tab === "mine" && Boolean(selectedMineTicket));
  const inlineTicket = selectedTicket && "timeline" in selectedTicket ? selectedTicket as Ticket : undefined;
  const detailQuery = useQuery({
    queryKey: queryKeys.mobile.ticket(selectedId ?? ""),
    queryFn: async ({ signal }) => {
      const payload = await apiJson<{ ticket?: Ticket }>(
        `/api/tickets/${selectedId}`,
        { cache: "no-store", signal },
        "Ticket detail failed to load"
      );
      if (!payload.ticket) throw new Error("Ticket detail failed to load");
      return payload.ticket;
    },
    enabled: Boolean(selectedId && isDetailPage)
  });
  const activeDetailTicket = detailQuery.data ?? inlineTicket;

  async function clearSessionState() {
    removeLegacyStoredUser();
    await queryClient.cancelQueries({ queryKey: queryKeys.mobile.all });
    queryClient.removeQueries({
      queryKey: queryKeys.mobile.all,
      predicate: (query) => query.queryKey[1] !== "session"
    });
    queryClient.setQueryData<CurrentUser | null>(queryKeys.mobile.session, null);
    setSelectedId(undefined);
    setTab("tickets");
  }

  const logoutMutation = useMutation({
    mutationFn: () => fetch("/api/auth/mobile/logout", { method: "POST" }),
    onSettled: clearSessionState
  });

  useEffect(() => {
    if (bootstrapQuery.data?.config) {
      queryClient.setQueryData<LoginBootstrap>(queryKeys.mobile.loginConfig, {
        config: bootstrapQuery.data.config
      });
    }
  }, [bootstrapQuery.data, queryClient]);

  useEffect(() => {
    if (sessionQuery.isSuccess && user) removeLegacyStoredUser();
  }, [sessionQuery.isSuccess, user]);

  useEffect(() => {
    if (isUnauthorized(bootstrapQuery.error) || isUnauthorized(detailQuery.error)) {
      void clearSessionState();
    }
  }, [bootstrapQuery.error, detailQuery.error]);

  useEffect(() => {
    if (!data || selectedId) return;
    const linkedTicketId = ticketIdFromCurrentUrl(data.tickets);
    if (!linkedTicketId) return;
    setTab("tickets");
    setSelectedId(linkedTicketId);
  }, [data, selectedId]);

  const metrics = useMemo(() => ({
    today: data?.tickets.length ?? 0,
    urgent: data?.tickets.filter((ticket) => getPriorityDisplay(ticket.priorityScore).tone === "critical").length ?? 0,
    pending: data?.tickets.filter((ticket) => ticket.status === "待受理").length ?? 0
  }), [data]);

  const changeTab = (nextTab: MobileTab) => {
    setTab(nextTab);
    setSelectedId(undefined);
  };

  const login = (nextUser: CurrentUser) => {
    queryClient.removeQueries({
      queryKey: queryKeys.mobile.all,
      predicate: (query) => query.queryKey[1] !== "session" && query.queryKey[1] !== "login-config"
    });
    queryClient.setQueryData(queryKeys.mobile.session, nextUser);
    setTab("tickets");
    setSelectedId(undefined);
  };

  const logout = async () => {
    await logoutMutation.mutateAsync().catch(() => undefined);
  };

  if (sessionQuery.isPending) return <main className="app-shell loading">加载中</main>;
  if (!user && loginConfigQuery.isPending && !loginConfigQuery.data) return <main className="app-shell loading">加载中</main>;
  if (!user && loginConfigQuery.error && !loginConfigQuery.data) {
    return (
      <main className="app-shell loading">
        <StatusMessage tone="error">{loginConfigQuery.error.message}</StatusMessage>
        <button className="primary-button" type="button" onClick={() => void loginConfigQuery.refetch()}>重新加载</button>
      </main>
    );
  }
  if (!user) return <LoginPanel config={loginConfigQuery.data?.config ?? defaultConfig()} onLogin={login} />;
  if (bootstrapQuery.isPending && !data) return <main className="app-shell loading">加载中</main>;
  if (bootstrapQuery.error && !data && !isUnauthorized(bootstrapQuery.error)) {
    return (
      <main className="app-shell loading">
        <StatusMessage tone="error">{bootstrapQuery.error.message}</StatusMessage>
        <button className="primary-button" type="button" onClick={() => void bootstrapQuery.refetch()}>重新加载</button>
        <button className="secondary-button" type="button" onClick={() => void logout()}>退出登录</button>
      </main>
    );
  }
  if (!data) return null;

  return (
    <MobileShell activeTab={tab} currentUser={user} hideHero={isDetailPage} metrics={metrics} onLogout={() => void logout()} onTabChange={changeTab}>
      {tab === "submit" && (
        <TicketSubmitForm
          config={data.config}
          currentUser={user}
          onSubmitted={() => changeTab("tickets")}
          onUnauthorized={() => void clearSessionState()}
        />
      )}
      {tab === "tickets" && !selectedTicket && <TicketList tickets={data.tickets} onSelect={setSelectedId} />}
      {tab === "tickets" && selectedTicket && (
        <section className="detail-route">
          <button className="back-button" type="button" onClick={() => setSelectedId(undefined)}>返回工单列表</button>
          {detailQuery.isPending && !activeDetailTicket ? (
            <section className="empty-state">加载中...</section>
          ) : detailQuery.error && !activeDetailTicket ? (
            <section className="empty-state">Ticket detail failed to load</section>
          ) : (
            <TicketDetail ticket={activeDetailTicket} currentUser={user} onUnauthorized={() => void clearSessionState()} />
          )}
        </section>
      )}
      {bootstrapQuery.error && <StatusMessage tone="error">{bootstrapQuery.error.message}</StatusMessage>}
      {tab === "mine" && !selectedMineTicket && <TicketList tickets={myTickets} onSelect={setSelectedId} />}
      {tab === "mine" && selectedMineTicket && (
        <section className="detail-route">
          <button className="back-button" type="button" onClick={() => setSelectedId(undefined)}>返回我的工单</button>
          {detailQuery.isPending && !activeDetailTicket ? (
            <section className="empty-state">加载中...</section>
          ) : detailQuery.error && !activeDetailTicket ? (
            <section className="empty-state">Ticket detail failed to load</section>
          ) : (
            <TicketDetail ticket={activeDetailTicket} currentUser={user} onUnauthorized={() => void clearSessionState()} />
          )}
        </section>
      )}
    </MobileShell>
  );
}
