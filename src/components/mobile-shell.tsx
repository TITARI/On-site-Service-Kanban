"use client";

import { CalendarCheck, ClipboardCheck, FilePlus, Flame, Inbox, LogOut, UserRound } from "lucide-react";
import type { CurrentUser } from "@/lib/client/auth";

export type MobileTab = "submit" | "tickets" | "mine";

type ShellMetrics = {
  today: number;
  urgent: number;
  pending: number;
};

export function MobileShell({
  activeTab,
  currentUser,
  hideHero = false,
  metrics = { today: 0, urgent: 0, pending: 0 },
  onLogout,
  onTabChange,
  children
}: {
  activeTab: MobileTab;
  currentUser: CurrentUser;
  hideHero?: boolean;
  metrics?: ShellMetrics;
  onLogout: () => void;
  onTabChange: (tab: MobileTab) => void;
  children: React.ReactNode;
}) {
  const tabs = [
    { id: "submit" as const, label: "提交", icon: FilePlus },
    { id: "tickets" as const, label: "工单", icon: ClipboardCheck },
    { id: "mine" as const, label: "我的", icon: UserRound }
  ];
  const metricItems = [
    { label: `今日 ${metrics.today}`, icon: CalendarCheck, tone: "today" },
    { label: `紧急 ${metrics.urgent}`, icon: Flame, tone: "urgent" },
    { label: `待受理 ${metrics.pending}`, icon: Inbox, tone: "pending" }
  ];
  const groupLabel = currentUser.groupName ?? "未分组";
  const identityLabel = [currentUser.name, currentUser.phone].filter(Boolean).join(" · ");

  return (
    <main className={`mobile-shell ${hideHero ? "mobile-shell-no-hero" : ""}`}>
      {!hideHero && (
        <header className="topbar">
          <div className="hero-copy">
            <p className="eyebrow">现场协同</p>
            <h1>内部工单看板</h1>
          </div>
          <div className="hero-side">
            <span className="live-dot">运行中</span>
            <div className="hero-user" aria-label="当前登录用户">
              <span>{groupLabel}</span>
              <small>{identityLabel}</small>
              <button type="button" onClick={onLogout} aria-label="退出登录"><LogOut size={14} aria-hidden="true" /></button>
            </div>
          </div>
          <div className="metric-strip" aria-label="现场工单指标">
            {metricItems.map((item) => {
              const Icon = item.icon;
              return (
                <span className={`metric-chip metric-${item.tone}`} key={item.label}>
                  <Icon size={15} aria-hidden="true" />
                  {item.label}
                </span>
              );
            })}
          </div>
        </header>
      )}
      <section className="content-pane">{children}</section>
      <nav className="bottom-nav" aria-label="主导航">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => onTabChange(tab.id)} type="button">
              <Icon size={20} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </main>
  );
}
