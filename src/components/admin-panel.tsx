"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ClipboardList,
  Database,
  FileClock,
  Gauge,
  Layers,
  Settings,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  UsersRound,
  type LucideIcon
} from "lucide-react";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import { ExhibitionDataPanel } from "@/components/exhibition-data-panel";
import { AI_PROVIDER_PRESETS, aiPromptDefaultsOf, aiPromptTemplatesOf, copyAiPromptTemplate, providerPresetFor } from "@/lib/domain/ai-config";
import { keywordRuleSetsOf, normalizeKeywordGroups } from "@/lib/domain/keyword-config";
import type { AiPromptDefaults, AiPromptScenario, AiPromptTemplate, AiProviderPresetId, BoothRecord, ChatIdentity, Conversation, InboundMessageRecord, KeywordGroup, KeywordRuleSet, KeywordTerm, OutboundMessage, PendingWorkOrderSession, Person, WxautoMcpConfig } from "@/lib/domain/types";
import type { TicketSummary } from "@/lib/domain/ticket-summary";
import { messageIntegrationsOf, userGroupsOf, type AppConfig } from "@/lib/seed";
import { normalizeWxautoMcpConfig, WXAUTO_MCP_ENDPOINT } from "@/lib/integrations/wxauto/config";
import {
  AUTO_ACCEPTANCE_MAX_MINUTES,
  AUTO_ACCEPTANCE_MIN_MINUTES,
  normalizeAutoAcceptanceConfig
} from "@/lib/services/auto-acceptance-service";

const AUTO_ISSUE_TYPE_NAME = "自动";
const MASKED_API_KEY = "••••••••";

const AI_PROMPT_SCENARIOS: Array<{ id: AiPromptScenario; label: string; helper: string }> = [
  { id: "classify", label: "工单分类", helper: "从展位和描述中判断问题类型" },
  { id: "dedupe", label: "相似工单判重", helper: "判断是否应转为催单" },
  { id: "escalation", label: "超时研判", helper: "为超时工单给出处理建议" },
  { id: "customer-service", label: "客服加急研判", helper: "结合上下文判断是否加急并生成客服回复" }
];

function textValue(formData: FormData, name: string) {
  return String(formData.get(name) ?? "").trim();
}

function apiKeyValue(formData: FormData) {
  const value = textValue(formData, "apiKey");
  return value === MASKED_API_KEY ? "" : value;
}

function numberValue(formData: FormData, name: string) {
  return Number(formData.get(name) ?? 0);
}

function isChecked(formData: FormData, name: string) {
  return formData.get(name) === "on";
}

function setNamedFormControlValue(form: HTMLFormElement, name: string, value: string) {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)) return;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function isAutomaticIssueType(item: AppConfig["issueTypes"][number]) {
  return item.id === "auto" || item.name === AUTO_ISSUE_TYPE_NAME;
}

function nextConfigId(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

function safeIdPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "term";
}

function splitKeywordTerms(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function keywordTermsText(ruleSet: KeywordRuleSet) {
  return ruleSet.terms
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((term) => term.value)
    .join("，");
}

function keywordRuleSetLabel(group: KeywordGroup, ruleSet: KeywordRuleSet) {
  const ruleSets = keywordRuleSetsOf(group);
  if (ruleSets.length <= 1) return group.name;
  if (ruleSet.action === "issue-type") return `${group.name}${ruleSet.issueType ?? "未指定问题类型"}`;
  return `${group.name}识别诉求`;
}

function nextKeywordTerm(ruleSet: KeywordRuleSet, value: string, index: number): KeywordTerm {
  const existing = ruleSet.terms.find((term) => term.value === value);
  return {
    ...existing,
    id: existing?.id ?? `${ruleSet.id}-term-${safeIdPart(value)}-${index + 1}`,
    value,
    enabled: existing?.enabled ?? true,
    aliases: existing?.aliases,
    sortOrder: index + 1
  };
}

type GroupDraft = {
  name: string;
  enabled: boolean;
};

type AdminFeedback = {
  id: number;
  message: string;
};

type WxautoMcpAdminState = WxautoMcpConfig & {
  tokenPreview?: string;
};

function wxautoMcpStateFromConfig(config: AppConfig): WxautoMcpAdminState {
  const normalized = normalizeWxautoMcpConfig(config.wxautoMcp, config.messageIntegrations);
  if (normalized.accessToken === "已设置") {
    return { ...normalized, accessToken: undefined, tokenPreview: "已设置" };
  }
  return normalized;
}

type AiModelListState = {
  models: string[];
  loading: boolean;
  error?: string;
};

export type AdminView = "all" | "workbench" | "logs" | "users" | "work-order-settings" | "exhibition-data" | "system";

export type WechatOrderLog = {
  id: string;
  inboundMessageId?: string;
  channel: string;
  action: string;
  ticketId?: string;
  sessionId?: string;
  summary: string;
  status: string;
  createdAt: string;
};

const ADMIN_NAV_ITEMS: Array<{
  view: Exclude<AdminView, "all">;
  label: string;
  href: string;
  icon: LucideIcon;
  group: "daily" | "manage";
}> = [
  { view: "workbench", label: "后台工作台", href: "/admin", icon: Gauge, group: "daily" },
  { view: "logs", label: "微信下单日志", href: "/admin/logs", icon: FileClock, group: "daily" },
  { view: "users", label: "用户与权限", href: "/admin/users", icon: UsersRound, group: "manage" },
  { view: "work-order-settings", label: "工单设置", href: "/admin/work-order-settings", icon: ClipboardList, group: "manage" },
  { view: "exhibition-data", label: "展览数据", href: "/admin/exhibition-data", icon: Database, group: "manage" },
  { view: "system", label: "系统配置", href: "/admin/system", icon: Settings, group: "manage" }
];

const QUICK_CONFIG_LINKS: Array<{ label: string; href: string; icon: LucideIcon }> = [
  { label: "用户分组", href: "/admin/work-order-settings#admin-groups", icon: Layers },
  { label: "问题类型", href: "/admin/work-order-settings#admin-issues", icon: ClipboardList },
  { label: "关键词规则", href: "/admin/system#admin-keywords", icon: Sparkles },
  { label: "智能接口", href: "/admin/system#admin-ai", icon: Bot }
];

function adminViewLabel(view: AdminView) {
  return ADMIN_NAV_ITEMS.find((item) => item.view === view)?.label ?? "配置总览";
}

function adminViewDescription(view: AdminView) {
  if (view === "logs") return "查看微信/企微消息分析、建单、匹配和待确认记录。";
  if (view === "users") return "维护后台用户、移动端人员账号、分组权限和登录凭据。";
  if (view === "work-order-settings") return "维护用户分组、问题类型和工单识别规则。";
  if (view === "exhibition-data") return "查看展位主数据状态并承接导入校验。";
  if (view === "system") return "维护智能接口、微信/企微 MCP 和系统级配置。";
  return "集中查看今日状态、待处理风险和常用后台入口。";
}

function adminStatusTone(message: string) {
  if (/已保存|已更新|完成/.test(message)) return "success";
  if (/失败|不正确/.test(message)) return "danger";
  if (/请|至少|需要|不能为空|检查/.test(message)) return "warning";
  return "info";
}

function channelName(channel: InboundMessageRecord["channel"]) {
  return channel === "wecom" ? "企业微信" : "微信";
}

function actionName(action: InboundMessageRecord["analysis"]["suggestedAction"]) {
  if (action === "create-ticket") return "建议建单";
  if (action === "urge-existing") return "建议催单";
  if (action === "needs-review") return "待人工确认";
  return "忽略";
}

function messageSummary(record: InboundMessageRecord) {
  return `${record.analysis.boothNumber ?? "未识别展位"} · ${record.analysis.issueType ?? "待分类"} · ${actionName(record.analysis.suggestedAction)}`;
}

function shortDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isOpenTicket(ticket: TicketSummary) {
  return ticket.status !== "已关闭";
}

function isPendingTicket(ticket: TicketSummary) {
  return ticket.status === "待受理" || ticket.status === "待再次处理";
}

function metricPercent(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function boothSnapshot(booth: BoothRecord) {
  return [
    booth.boothNumber,
    booth.companyName,
    booth.companyShortName,
    booth.salesOwner,
    booth.builder,
    booth.location,
    booth.area,
    booth.boothType
  ].map((value) => value?.trim() ?? "").join("\u0001");
}

function sameBoothRecords(left: BoothRecord[], right: BoothRecord[]) {
  if (left.length !== right.length) return false;
  const leftSnapshot = left.map(boothSnapshot).sort();
  const rightSnapshot = right.map(boothSnapshot).sort();
  return leftSnapshot.every((value, index) => value === rightSnapshot[index]);
}

function actionBadgeText(action: string) {
  if (action === "create-ticket") return "自动建单";
  if (action === "urge-existing") return "匹配催单";
  if (action === "needs-review") return "待确认";
  if (action === "ignore") return "已忽略";
  return "未知动作";
}

function channelLabel(channel: string) {
  if (channel === "wechat") return "微信";
  if (channel === "wecom") return "企业微信";
  return "未知渠道";
}

function actionLabel(action: string) {
  return actionBadgeText(action);
}

function logStatusLabel(status: string) {
  if (status === "processed") return "已处理";
  if (status === "ignored") return "已忽略";
  if (status === "failed") return "失败";
  if (status === "pending") return "待处理";
  return status;
}

function pendingFieldsText(session: PendingWorkOrderSession) {
  const labels: Record<string, string> = {
    identityGroup: "身份分组",
    name: "姓名",
    phone: "电话",
    boothNumber: "展位号",
    issueType: "问题类型"
  };
  return session.missingFields.map((field) => labels[field] ?? field).join("、") || "信息完整";
}

function AdminSidebar({
  view,
  openCount,
  logCount,
  messageIntegrationsEnabled,
  aiEnabled
}: {
  view: AdminView;
  openCount: number;
  logCount: number;
  messageIntegrationsEnabled: number;
  aiEnabled: number;
}) {
  return (
    <aside className="admin-sidebar">
      <div className="admin-brand">
        <span className="admin-brand-mark" aria-hidden="true"><ShieldCheck size={18} /></span>
        <div>
          <strong>主场看板</strong>
          <small>电脑端后台管理</small>
        </div>
      </div>
      <nav className="admin-side-nav" aria-label="后台主导航">
        <span className="admin-side-label">日常</span>
        {ADMIN_NAV_ITEMS.filter((item) => item.group === "daily").map((item) => {
          const Icon = item.icon;
          const active = item.view === view || (view === "all" && item.view === "workbench");
          return (
            <a key={item.view} href={item.href} aria-current={active ? "page" : undefined} className={active ? "active" : undefined}>
              <Icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
              {item.view === "workbench" && openCount > 0 && <em aria-hidden="true">{openCount}</em>}
              {item.view === "logs" && logCount > 0 && <em aria-hidden="true">{logCount}</em>}
            </a>
          );
        })}
        <span className="admin-side-label">管理</span>
        {ADMIN_NAV_ITEMS.filter((item) => item.group === "manage").map((item) => {
          const Icon = item.icon;
          const active = item.view === view;
          return (
            <a key={item.view} href={item.href} aria-current={active ? "page" : undefined} className={active ? "active" : undefined}>
              <Icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          );
        })}
      </nav>
      <div className="admin-side-status">
        <strong>系统在线</strong>
        <span>{messageIntegrationsEnabled} 个消息接入，{aiEnabled} 个智能模型启用</span>
      </div>
    </aside>
  );
}

function AdminMetricCard({
  label,
  value,
  helper,
  tone = "default",
  percent
}: {
  label: string;
  value: string | number;
  helper: string;
  tone?: "default" | "warning" | "danger" | "info";
  percent: number;
}) {
  return (
    <article className={`admin-metric-card admin-metric-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{helper}</small>
      <i aria-hidden="true"><b style={{ width: `${Math.max(4, Math.min(100, percent))}%` }} /></i>
    </article>
  );
}

function AdminWorkbench({
  tickets,
  booths,
  recentLogs,
  failedOutboundMessages,
  messageRecords,
  people,
  chatIdentities,
  conversations,
  pendingWorkOrderSessions,
  enabledAiModels,
  enabledMessageIntegrations
}: {
  tickets: TicketSummary[];
  booths: BoothRecord[];
  recentLogs: WechatOrderLog[];
  failedOutboundMessages: OutboundMessage[];
  messageRecords: InboundMessageRecord[];
  people: Person[];
  chatIdentities: ChatIdentity[];
  conversations: Conversation[];
  pendingWorkOrderSessions: PendingWorkOrderSession[];
  enabledAiModels: number;
  enabledMessageIntegrations: number;
}) {
  const openTickets = tickets.filter(isOpenTicket);
  const pendingTickets = tickets.filter(isPendingTicket);
  const reviewMessages = messageRecords.filter((record) => record.analysis.suggestedAction === "needs-review");
  const exceptionRows = [
    ...pendingTickets.map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      source: "工单",
      status: ticket.status,
      owner: ticket.assignmentGroup ?? "未分配",
      time: ticket.updatedAt
    })),
    ...failedOutboundMessages.map((message) => ({
      id: message.id,
      title: message.text,
      source: "通知",
      status: "通知失败",
      owner: message.targetName,
      time: message.updatedAt
    })),
    ...reviewMessages.map((record) => ({
      id: record.id,
      title: record.analysis.reason,
      source: channelLabel(record.channel),
      status: "待人工确认",
      owner: record.senderName,
      time: record.createdAt
    }))
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 6);
  const actionableTotal = pendingTickets.length + failedOutboundMessages.length + reviewMessages.length;
  const autoLogs = recentLogs.filter((log) => log.action === "create-ticket").length;
  const autoRate = metricPercent(autoLogs, recentLogs.length);
  const firstBooth = booths[0];
  const boothSummary = firstBooth
    ? `${firstBooth.boothNumber} ${firstBooth.companyShortName ?? firstBooth.companyName} ${firstBooth.builder ?? "未指定搭建商"}`
    : "暂无展位数据";
  const linkedIdentities = chatIdentities.filter((identity) => identity.personId);
  const latestPendingSession = pendingWorkOrderSessions
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

  return (
    <div className="admin-workbench">
      <div className="admin-metric-grid">
        <AdminMetricCard label="未关闭工单" value={openTickets.length} helper={`共 ${tickets.length} 张工单`} percent={metricPercent(openTickets.length, tickets.length)} />
        <AdminMetricCard label="待处理工单" value={pendingTickets.length} helper="待受理 / 待再次处理" tone="warning" percent={metricPercent(pendingTickets.length, openTickets.length)} />
        <AdminMetricCard label="失败通知" value={failedOutboundMessages.length} helper="需要人工复核发送" tone="danger" percent={metricPercent(failedOutboundMessages.length, failedOutboundMessages.length + 5)} />
        <AdminMetricCard label="自动建单率" value={`${autoRate}%`} helper={`${enabledMessageIntegrations} 个接入，${enabledAiModels} 个模型`} tone="info" percent={autoRate} />
      </div>

      <div className="admin-workbench-layout">
        <section className="admin-card admin-queue-card">
          <div className="admin-card-head">
            <div>
              <h3>待处理与异常队列</h3>
              <p>优先展示需要人工介入的事项</p>
            </div>
            <span>{actionableTotal} 项</span>
          </div>
          <div className="admin-table">
            <div className="admin-table-row admin-table-head">
              <span>事项</span>
              <span>来源</span>
              <span>状态</span>
              <span>负责人</span>
              <span>时间</span>
            </div>
            {exceptionRows.map((row) => (
              <div className="admin-table-row" key={`${row.source}-${row.id}`}>
                <strong>{row.title}</strong>
                <span>{row.source}</span>
                <em className={row.status === "通知失败" ? "danger" : row.status === "待人工确认" ? "warning" : undefined}>{row.status}</em>
                <span>{row.owner}</span>
                <time>{shortDateTime(row.time)}</time>
              </div>
            ))}
            {exceptionRows.length === 0 && <p className="admin-empty-note">暂无待处理异常</p>}
          </div>
        </section>

        <div className="admin-side-stack">
          <section className="admin-card">
            <div className="admin-card-head">
              <div>
                <h3>微信下单动态</h3>
                <p>最近消息处理结果</p>
              </div>
              <a href="/admin/logs">查看全部</a>
            </div>
            <div className="admin-timeline">
              {recentLogs.slice(0, 5).map((log) => (
                <article key={log.id}>
                  <i aria-hidden="true" />
                  <div>
                    <strong>{actionBadgeText(log.action)}</strong>
                    <p>{log.summary}</p>
                  </div>
                  <time>{shortDateTime(log.createdAt)}</time>
                </article>
              ))}
              {recentLogs.length === 0 && <p className="admin-empty-note">暂无微信下单日志</p>}
            </div>
          </section>

          <section className="admin-card">
            <div className="admin-card-head">
              <div>
                <h3>快捷配置</h3>
                <p>常用后台入口</p>
              </div>
            </div>
            <div className="admin-quick-grid">
              {QUICK_CONFIG_LINKS.map((item) => {
                const Icon = item.icon;
                return (
                  <a key={item.href} href={item.href}>
                    <Icon size={16} aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </div>
          </section>

          <section className="admin-card admin-data-card">
            <Database size={18} aria-hidden="true" />
            <div>
              <strong>展览数据</strong>
              <p>{boothSummary}，当前共 {booths.length} 条展位数据</p>
            </div>
          </section>

          <section className="admin-card admin-linkage-card">
            <div className="admin-card-head">
              <div>
                <h3>消息身份联通</h3>
                <p>来自 MariaDB 身份、会话和追问表</p>
              </div>
              <Users size={18} aria-hidden="true" />
            </div>
            <div className="admin-linkage-grid" aria-label="消息身份联通状态">
              <span><strong>人员 {people.length}</strong><small>已建档</small></span>
              <span><strong>身份 {linkedIdentities.length}</strong><small>已绑定</small></span>
              <span><strong>会话 {conversations.length}</strong><small>可通知</small></span>
              <span><strong>待补全 {pendingWorkOrderSessions.length}</strong><small>待追问</small></span>
            </div>
            {latestPendingSession ? (
              <div className="admin-linkage-pending">
                <strong>最近待补全</strong>
                <p>{latestPendingSession.draftText}</p>
                <small>缺少：{pendingFieldsText(latestPendingSession)}</small>
              </div>
            ) : (
              <p className="admin-empty-note">暂无待补全会话</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

export function AdminConfigCenter({
  config,
  view = "all",
  booths = [],
  wechatOrderLogs = [],
  messageRecords = [],
  tickets = [],
  people = [],
  chatIdentities = [],
  conversations = [],
  pendingWorkOrderSessions = [],
  outboundMessages = [],
  onRefresh
}: {
  config: AppConfig;
  view?: AdminView;
  booths?: BoothRecord[];
  wechatOrderLogs?: WechatOrderLog[];
  messageRecords?: InboundMessageRecord[];
  tickets?: TicketSummary[];
  people?: Person[];
  chatIdentities?: ChatIdentity[];
  conversations?: Conversation[];
  pendingWorkOrderSessions?: PendingWorkOrderSession[];
  outboundMessages?: OutboundMessage[];
  onRefresh: () => void;
}) {
  const [statusQueue, setStatusQueue] = useState<AdminFeedback[]>([]);
  const nextStatusId = useRef(0);
  const [isImporting, setIsImporting] = useState(false);
  const [savingConfigId, setSavingConfigId] = useState<string | null>(null);
  const [newIssueName, setNewIssueName] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [groupDrafts, setGroupDrafts] = useState<Record<string, GroupDraft>>({});
  const [deletedGroupIds, setDeletedGroupIds] = useState<Set<string>>(() => new Set());
  const [deletedIssueTypeIds, setDeletedIssueTypeIds] = useState<Set<string>>(() => new Set());
  const [aiProviderPresetDrafts, setAiProviderPresetDrafts] = useState<Partial<Record<"fast" | "smart", AiProviderPresetId>>>({});
  const [aiModelNameDrafts, setAiModelNameDrafts] = useState<Partial<Record<"fast" | "smart", string>>>({});
  const [aiModelLists, setAiModelLists] = useState<Partial<Record<"fast" | "smart", AiModelListState>>>({});
  const [wxautoMcpState, setWxautoMcpState] = useState<WxautoMcpAdminState>(() => wxautoMcpStateFromConfig(config));
  const [displayedBooths, setDisplayedBooths] = useState<BoothRecord[]>(booths);
  const [pendingImportedBooths, setPendingImportedBooths] = useState<BoothRecord[] | null>(null);
  const groups = config.userGroups?.length ? config.userGroups : userGroupsOf(config);
  const messageIntegrations = messageIntegrationsOf(config);
  const wxautoMcp = wxautoMcpState;
  const autoAcceptance = normalizeAutoAcceptanceConfig(config.autoAcceptance);
  const activeGroups = groups.filter((group) => !deletedGroupIds.has(group.id));
  const usedGroupNames = new Set(tickets.map((ticket) => ticket.assignmentGroup).filter(Boolean));
  const usedIssueTypeNames = new Set(tickets.map((ticket) => ticket.issueType).filter(Boolean));
  const managedIssueTypes = config.issueTypes.filter((item) => !isAutomaticIssueType(item));
  const activeIssueTypes = managedIssueTypes.filter((item) => !deletedIssueTypeIds.has(item.id));
  const keywordGroups = normalizeKeywordGroups(config.keywordGroups ?? []);
  const aiPromptTemplates = aiPromptTemplatesOf(config);
  const aiPromptDefaults = aiPromptDefaultsOf(config);
  const openTickets = tickets.filter(isOpenTicket);
  const pendingTickets = tickets.filter(isPendingTicket);
  const failedOutboundMessages = outboundMessages.filter((message) => message.status === "failed");
  const recentLogs = wechatOrderLogs.length > 0
    ? wechatOrderLogs
    : messageRecords.slice(-8).reverse().map((record) => ({
      id: `log-${record.id}`,
      inboundMessageId: record.id,
      channel: record.channel,
      action: record.analysis.suggestedAction,
      ticketId: record.analysis.matchedTicketId,
      summary: record.analysis.reason,
      status: record.analysis.suggestedAction === "ignore" ? "ignored" : "processed",
      createdAt: record.createdAt
    }));
  const showAll = view === "all";
  const activeStatusId = statusQueue[0]?.id;

  useEffect(() => {
    if (!pendingImportedBooths) {
      setDisplayedBooths((current) => sameBoothRecords(current, booths) ? current : booths);
      return;
    }
    if (sameBoothRecords(booths, pendingImportedBooths)) {
      setPendingImportedBooths(null);
      setDisplayedBooths(booths);
    }
  }, [booths, pendingImportedBooths]);

  useEffect(() => {
    if (!activeStatusId) return;
    const timeout = window.setTimeout(() => {
      setStatusQueue((current) => current.slice(1));
    }, 1500);
    return () => window.clearTimeout(timeout);
  }, [activeStatusId]);

  useEffect(() => {
    if (view !== "system") return;
    let cancelled = false;
    async function ensureWxautoMcp() {
      try {
        const response = await fetch("/api/admin/wxauto-mcp", { cache: "no-store" });
        if (!response.ok) throw new Error("wxauto 服务启动失败");
        const payload = await response.json() as { wxautoMcp?: WxautoMcpAdminState };
        if (!cancelled && payload.wxautoMcp) setWxautoMcpState(payload.wxautoMcp);
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "wxauto 服务启动失败");
      }
    }
    void ensureWxautoMcp();
    return () => {
      cancelled = true;
    };
  }, [showAll, view]);

  function setStatus(message: string | null) {
    if (!message) return;
    nextStatusId.current += 1;
    setStatusQueue((current) => [...current, { id: nextStatusId.current, message }]);
  }

  function groupDraft(group: typeof groups[number]) {
    return groupDrafts[group.id] ?? { name: group.name, enabled: group.enabled };
  }

  function updateGroupDraft(groupId: string, patch: Partial<GroupDraft>) {
    setGroupDrafts((current) => {
      const group = groups.find((item) => item.id === groupId);
      if (!group) return current;
      const next = { ...(current[groupId] ?? { name: group.name, enabled: group.enabled }), ...patch };
      return { ...current, [groupId]: next };
    });
  }

  function groupOptions() {
    return Array.from(new Set([
      ...activeGroups
        .map((group) => groupDraft(group))
        .filter((group) => group.name.trim())
        .map((group) => group.name.trim()),
      ...(newGroupName.trim() ? [newGroupName.trim()] : [])
    ]));
  }

  function assignmentGroupValue(value?: string) {
    return value && groupOptions().includes(value) ? value : "";
  }

  async function saveConfig(nextConfig: AppConfig, successMessage: string, savingId: string) {
    setSavingConfigId(savingId);
    setStatus(null);
    try {
      const response = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextConfig)
      });
      if (!response.ok) throw new Error("配置保存失败");
      setStatus(successMessage);
      onRefresh();
      return true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "配置保存失败");
      return false;
    } finally {
      setSavingConfigId(null);
    }
  }

  async function importFile(file: File, sheetNames?: string[]) {
    setIsImporting(true);
    setStatus("正在导入");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("dryRun", "false");
      if (sheetNames) formData.append("sheetNames", JSON.stringify(sheetNames));
      const response = await fetch("/api/admin/master-data", {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw new Error("主数据导入失败");
      const payload = await response.json() as { booths?: BoothRecord[] };
      if (payload.booths) {
        setPendingImportedBooths(payload.booths);
        setDisplayedBooths(payload.booths);
      }
      setStatus("导入完成");
      onRefresh();
    } catch (error) {
      setStatus(`导入失败：${error instanceof Error ? error.message : "请检查文件"}`);
    } finally {
      setIsImporting(false);
    }
  }

  async function saveWxautoMcp(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setSavingConfigId("wxauto-mcp");
    try {
      const response = await fetch("/api/admin/wxauto-mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: isChecked(formData, "wxautoMcp-enabled"),
          autoCreateTickets: isChecked(formData, "wxautoMcp-autoCreateTickets"),
          accessToken: textValue(formData, "wxautoMcp-accessToken")
        })
      });
      if (!response.ok) throw new Error("wxauto 服务配置保存失败");
      const payload = await response.json() as { wxautoMcp: WxautoMcpAdminState };
      setWxautoMcpState(payload.wxautoMcp);
      setStatus("wxauto 桌面服务已保存");
      onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "wxauto 服务配置保存失败");
    } finally {
      setSavingConfigId(null);
    }
  }

  async function rotateWxautoToken() {
    setSavingConfigId("wxauto-mcp");
    try {
      const response = await fetch("/api/admin/wxauto-mcp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotateToken: true })
      });
      if (!response.ok) throw new Error("访问令牌重置失败");
      const payload = await response.json() as { wxautoMcp: WxautoMcpAdminState };
      setWxautoMcpState(payload.wxautoMcp);
      setStatus("访问令牌已重置");
      onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "访问令牌重置失败");
    } finally {
      setSavingConfigId(null);
    }
  }

  function saveAutoAcceptance(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const timeoutMinutes = numberValue(formData, "autoAcceptance-timeoutMinutes");
    if (
      !Number.isInteger(timeoutMinutes) ||
      timeoutMinutes < AUTO_ACCEPTANCE_MIN_MINUTES ||
      timeoutMinutes > AUTO_ACCEPTANCE_MAX_MINUTES
    ) {
      setStatus("自动验收时效需为 1 至 10080 分钟的整数");
      return;
    }
    void saveConfig({
      ...config,
      autoAcceptance: {
        enabled: isChecked(formData, "autoAcceptance-enabled"),
        timeoutMinutes
      }
    }, "自动验收配置已保存", "auto-acceptance");
  }

  async function saveKeywordGroups(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextGroups: KeywordGroup[] = keywordGroups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      enabled: isChecked(formData, `keyword-group-${group.id}-enabled`),
      ruleSets: keywordRuleSetsOf(group).map((ruleSet) => {
        const terms = splitKeywordTerms(textValue(formData, `keyword-rule-set-${ruleSet.id}-terms`))
          .map((value, index) => nextKeywordTerm(ruleSet, value, index));
        return {
          ...ruleSet,
          matchType: textValue(formData, `keyword-rule-set-${ruleSet.id}-matchType`) === "exact" ? "exact" : "contains",
          action: textValue(formData, `keyword-rule-set-${ruleSet.id}-action`) === "issue-type" ? "issue-type" : "operational-intent",
          issueType: textValue(formData, `keyword-rule-set-${ruleSet.id}-issueType`) || undefined,
          priority: numberValue(formData, `keyword-rule-set-${ruleSet.id}-priority`),
          enabled: isChecked(formData, `keyword-rule-set-${ruleSet.id}-enabled`),
          terms
        };
      })
    }));
    if (nextGroups.some((group) => keywordRuleSetsOf(group).some((ruleSet) => ruleSet.terms.length < 1))) {
      setStatus("关键词不能为空");
      return;
    }
    setSavingConfigId("keywords");
    setStatus(null);
    try {
      const response = await fetch("/api/admin/keywords", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywordGroups: nextGroups })
      });
      if (!response.ok) throw new Error("关键词配置保存失败");
      setStatus("关键词配置已保存");
      onRefresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "关键词配置保存失败");
    } finally {
      setSavingConfigId(null);
    }
  }

  async function saveUserGroups(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextGroups = activeGroups.map((group) => ({
      ...group,
      name: textValue(formData, `group-${group.id}-name`),
      description: textValue(formData, `group-${group.id}-description`),
      canClaim: isChecked(formData, `group-${group.id}-canClaim`),
      canProcess: isChecked(formData, `group-${group.id}-canProcess`),
      canAccept: isChecked(formData, `group-${group.id}-canAccept`),
      canAdmin: isChecked(formData, `group-${group.id}-canAdmin`),
      enabled: isChecked(formData, `group-${group.id}-enabled`)
    }));
    const newGroupNameValue = textValue(formData, "newGroupName");
    if (newGroupNameValue) {
      nextGroups.push({
        id: nextConfigId("group"),
        name: newGroupNameValue,
        description: textValue(formData, "newGroupDescription"),
        canClaim: isChecked(formData, "newGroupCanClaim"),
        canProcess: isChecked(formData, "newGroupCanProcess"),
        canAccept: isChecked(formData, "newGroupCanAccept"),
        canAdmin: isChecked(formData, "newGroupCanAdmin"),
        enabled: true
      });
    }
    if (nextGroups.some((group) => !group.name)) {
      setStatus("请填写所有已配置分组的名称");
      return;
    }
    if (!nextGroups.some((group) => group.enabled)) {
      setStatus("至少需要保留一个启用的用户分组");
      return;
    }
    if (!nextGroups.some((group) => group.enabled && group.canAccept)) {
      setStatus("至少需要保留一个可验收的用户分组");
      return;
    }
    const deletedGroupNames = new Set(groups.filter((group) => deletedGroupIds.has(group.id)).map((group) => group.name));
    const nextIssueTypes = config.issueTypes.map((item) => (
      item.assignmentGroup && deletedGroupNames.has(item.assignmentGroup) ? { ...item, assignmentGroup: undefined } : item
    ));
    const saved = await saveConfig({ ...config, userGroups: nextGroups, issueTypes: nextIssueTypes }, "用户分组配置已保存", "groups");
    if (saved && newGroupNameValue) setNewGroupName("");
  }

  async function saveIssueTypes(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextIssueTypes = activeIssueTypes.map((item) => {
      const urgencyMinutes = numberValue(formData, `issue-${item.id}-urgencyMinutes`);
      const priorityWeight = numberValue(formData, `issue-${item.id}-priorityWeight`);
      return {
        ...item,
        name: textValue(formData, `issue-${item.id}-name`),
        urgencyMinutes,
        priorityWeight,
        assignmentGroup: textValue(formData, `issue-${item.id}-assignmentGroup`) || undefined,
        enabled: isChecked(formData, `issue-${item.id}-enabled`)
      };
    });
    const newTypeNameValue = textValue(formData, "newIssueName");
    if (newTypeNameValue) {
      nextIssueTypes.push({
        id: nextConfigId("issue"),
        name: newTypeNameValue,
        urgencyMinutes: numberValue(formData, "newIssueUrgencyMinutes"),
        priorityWeight: numberValue(formData, "newIssuePriorityWeight"),
        assignmentGroup: textValue(formData, "newIssueAssignmentGroup") || undefined,
        enabled: true
      });
    }
    const hasInvalidIssueType = nextIssueTypes.some((item) => (
      !item.name ||
      !Number.isFinite(item.urgencyMinutes) ||
      item.urgencyMinutes < 0 ||
      !Number.isFinite(item.priorityWeight)
    ));
    if (hasInvalidIssueType) {
      setStatus("请检查问题类型名称、催单时间和优先权重");
      return;
    }
    if (!nextIssueTypes.some((item) => item.enabled)) {
      setStatus("至少需要保留一个启用的问题类型");
      return;
    }
    const deletedIssueTypeNames = new Set(managedIssueTypes.filter((item) => deletedIssueTypeIds.has(item.id)).map((item) => item.name));
    const nextAssignmentRules = config.assignmentRules.filter((rule) => !deletedIssueTypeNames.has(rule.issueType));
    const saved = await saveConfig({ ...config, issueTypes: nextIssueTypes, assignmentRules: nextAssignmentRules }, "问题类型配置已保存", "issues");
    if (saved && newTypeNameValue) setNewIssueName("");
  }

  function saveAiModel(event: React.FormEvent<HTMLFormElement>, modelId: "fast" | "smart") {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const timeoutMs = Number(formData.get("timeoutMs") ?? 0);
    const modelName = String(formData.get("modelName") ?? "").trim();
    const apiKey = apiKeyValue(formData);
    if (!modelName || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      setStatus("请检查智能模型名称和超时时间");
      return;
    }
    const nextAiModels = config.aiModels.map((model) => {
      const { apiKeyConfigured, ...persistedModel } = model;
      return model.id === modelId ? {
        ...persistedModel,
        providerPreset: providerPresetFor(String(formData.get("providerPreset") ?? "custom")).id as AiProviderPresetId,
        provider: String(formData.get("provider") ?? "mock") === "http" ? "http" as const : "mock" as const,
        endpoint: String(formData.get("endpoint") ?? "").trim() || undefined,
        modelName,
        apiKey: apiKey || undefined,
        apiKeyEnv: undefined,
        timeoutMs,
        enabled: formData.get("enabled") === "on"
      } : persistedModel;
    });
    void saveConfig({ ...config, aiModels: nextAiModels }, "智能接口已更新", `ai-${modelId}`);
  }

  function selectedAiProviderPresetId(model: AppConfig["aiModels"][number]) {
    return aiProviderPresetDrafts[model.id] ?? model.providerPreset ?? "custom";
  }

  function uniqueModelOptions(values: Array<string | undefined>) {
    return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean))) as string[];
  }

  function selectedAiModelName(model: AppConfig["aiModels"][number], presetModelName?: string) {
    return aiModelNameDrafts[model.id] ?? model.modelName ?? presetModelName;
  }

  function aiModelControlLabel(modelLabel: string, suffix: string) {
    if (modelLabel.endsWith("模型") && suffix.startsWith("模型")) {
      return `${modelLabel}${suffix.slice("模型".length)}`;
    }
    return `${modelLabel}${suffix}`;
  }

  function fillAiProviderPresetFields(form: HTMLFormElement, presetId: string, modelId: "fast" | "smart") {
    const preset = providerPresetFor(presetId);
    if (preset.id === "custom") return;
    setNamedFormControlValue(form, "provider", "http");
    setNamedFormControlValue(form, "endpoint", preset.endpoint ?? "");
    if (preset.modelName) {
      setAiModelNameDrafts((current) => ({ ...current, [modelId]: preset.modelName }));
    }
    setNamedFormControlValue(form, "timeoutMs", String(preset.timeoutMs ?? 8000));
  }

  function changeAiProviderPreset(event: React.ChangeEvent<HTMLSelectElement>, modelId: "fast" | "smart") {
    const presetId = providerPresetFor(event.currentTarget.value).id as AiProviderPresetId;
    const form = event.currentTarget.form;
    setAiProviderPresetDrafts((current) => ({ ...current, [modelId]: presetId }));
    setAiModelLists((current) => ({ ...current, [modelId]: undefined }));
    if (form) fillAiProviderPresetFields(form, presetId, modelId);
  }

  function changeAiModelName(event: React.ChangeEvent<HTMLSelectElement>, modelId: "fast" | "smart") {
    const value = event.currentTarget.value;
    setAiModelNameDrafts((current) => ({ ...current, [modelId]: value }));
  }

  async function loadAiModelList(event: React.MouseEvent<HTMLButtonElement>, modelId: "fast" | "smart") {
    const form = event.currentTarget.form;
    if (!form) return;
    const formData = new FormData(form);
    const endpoint = textValue(formData, "endpoint");
    const apiKey = apiKeyValue(formData);
    const currentModelName = textValue(formData, "modelName");
    const savedApiKeyAvailable = Boolean(config.aiModels.find((model) => model.id === modelId)?.apiKeyConfigured);
    if (!endpoint || (!apiKey && !savedApiKeyAvailable)) {
      setStatus("请先填写智能接口地址和接口密钥，或保存已配置密钥后再获取模型列表");
      return;
    }
    setAiModelLists((current) => ({ ...current, [modelId]: { models: current[modelId]?.models ?? [], loading: true } }));
    try {
      const response = await fetch("/api/admin/ai-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apiKey ? { endpoint, apiKey } : { endpoint, modelId })
      });
      const data = await response.json() as { models?: string[]; error?: string; message?: string };
      if (!response.ok) throw new Error(data.error ?? data.message ?? "模型列表获取失败");
      const models = Array.isArray(data.models) ? data.models.filter((model) => model.trim()) : [];
      if (models.length === 0) throw new Error("未获取到可用模型");
      setAiModelLists((current) => ({ ...current, [modelId]: { models, loading: false } }));
      setAiModelNameDrafts((current) => ({ ...current, [modelId]: models.includes(currentModelName) ? currentModelName : models[0] }));
      setStatus("智能模型列表已更新");
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型列表获取失败";
      setAiModelLists((current) => ({ ...current, [modelId]: { models: current[modelId]?.models ?? [], loading: false, error: message } }));
      setStatus(message);
    }
  }

  function saveAiPromptConfig(nextTemplates: AiPromptTemplate[], nextDefaults: AiPromptDefaults, message: string, savingId: string) {
    void saveConfig({ ...config, aiPromptTemplates: nextTemplates, aiPromptDefaults: nextDefaults }, message, savingId);
  }

  function copyPromptTemplate(template: AiPromptTemplate) {
    const copied = copyAiPromptTemplate(template);
    saveAiPromptConfig(
      [...aiPromptTemplates, copied],
      { ...aiPromptDefaults, [template.scenario]: copied.id },
      "智能提示词预设已复制",
      `ai-prompt-${template.scenario}`
    );
  }

  function setPromptDefault(template: AiPromptTemplate) {
    saveAiPromptConfig(
      aiPromptTemplates,
      { ...aiPromptDefaults, [template.scenario]: template.id },
      "智能默认提示词已更新",
      `ai-prompt-${template.scenario}`
    );
  }

  function deletePromptTemplate(template: AiPromptTemplate) {
    if (template.builtIn) return;
    const nextTemplates = aiPromptTemplates.filter((item) => item.id !== template.id);
    const builtInDefault = nextTemplates.find((item) => item.scenario === template.scenario && item.builtIn)?.id ?? aiPromptDefaults[template.scenario];
    saveAiPromptConfig(
      nextTemplates,
      aiPromptDefaults[template.scenario] === template.id
        ? { ...aiPromptDefaults, [template.scenario]: builtInDefault }
        : aiPromptDefaults,
      "智能提示词模板已删除",
      `ai-prompt-${template.scenario}`
    );
  }

  function savePromptTemplateFromForm(form: HTMLFormElement, template: AiPromptTemplate, setDefault: boolean) {
    const formData = new FormData(form);
    const name = textValue(formData, "promptName");
    const systemPrompt = textValue(formData, "systemPrompt");
    if (!name || !systemPrompt) {
      setStatus("请填写智能提示词名称和系统提示词");
      return;
    }
    const nextTemplates = aiPromptTemplates.map((item) => item.id === template.id ? {
      ...item,
      name,
      description: textValue(formData, "promptDescription"),
      systemPrompt,
      enabled: setDefault || isChecked(formData, "enabled"),
      updatedAt: new Date().toISOString()
    } : item);
    saveAiPromptConfig(
      nextTemplates,
      setDefault ? { ...aiPromptDefaults, [template.scenario]: template.id } : aiPromptDefaults,
      setDefault ? "智能默认提示词已更新" : "智能提示词模板已保存",
      `ai-prompt-${template.scenario}`
    );
  }

  function savePromptTemplate(event: React.FormEvent<HTMLFormElement>, template: AiPromptTemplate) {
    event.preventDefault();
    savePromptTemplateFromForm(event.currentTarget, template, false);
  }

  function saveAndSetDefaultPromptTemplate(event: React.MouseEvent<HTMLButtonElement>, template: AiPromptTemplate) {
    const form = event.currentTarget.form;
    if (!form) return;
    savePromptTemplateFromForm(form, template, true);
  }

  return (
    <section className="admin-console">
      <AdminSidebar
        view={view}
        openCount={openTickets.length}
        logCount={recentLogs.length}
        messageIntegrationsEnabled={messageIntegrations.filter((item) => item.enabled).length}
        aiEnabled={config.aiModels.filter((model) => model.enabled).length}
      />
      <div className="admin-main-panel">
        <div className="admin-page-head">
          <div>
            <p className="eyebrow">后台管理</p>
            <h1>{adminViewLabel(view)}</h1>
            <span>{adminViewDescription(view)}</span>
          </div>
          <div className="admin-page-actions">
            <button className="secondary-button" type="button" onClick={onRefresh}>刷新数据</button>
          </div>
        </div>
        {statusQueue.length > 0 && (
          <div className="admin-feedback-stack" role="region" aria-label="操作提示">
            {statusQueue.map((status) => (
              <p key={status.id} className={`admin-feedback-toast ${adminStatusTone(status.message)}`} role="status" aria-live="polite">
                {status.message}
              </p>
            ))}
          </div>
        )}
        <div className="admin-view-body">
      {view === "workbench" && (
        <AdminWorkbench
          tickets={tickets}
          booths={displayedBooths}
          recentLogs={recentLogs}
          failedOutboundMessages={failedOutboundMessages}
          messageRecords={messageRecords}
          people={people}
          chatIdentities={chatIdentities}
          conversations={conversations}
          pendingWorkOrderSessions={pendingWorkOrderSessions}
          enabledAiModels={config.aiModels.filter((model) => model.enabled).length}
          enabledMessageIntegrations={messageIntegrations.filter((item) => item.enabled).length}
        />
      )}
      {view === "logs" && (
        <div className="admin-card config-list" id="admin-wechat-order-logs">
          <div className="admin-card-head">
            <div>
              <h3>微信下单日志</h3>
              <p>展示消息分析、自动建单、催单匹配和人工确认记录。</p>
            </div>
            <span>{recentLogs.length} 条</span>
          </div>
          <div className="admin-log-table">
            <div className="admin-log-row admin-log-head">
              <span>时间</span>
              <span>渠道</span>
              <span>动作</span>
              <span>摘要</span>
              <span>关联</span>
              <span>状态</span>
            </div>
            {recentLogs.map((log) => (
              <article className="admin-log-row" key={log.id}>
                <time>{shortDateTime(log.createdAt)}</time>
                <span>{channelLabel(log.channel)}</span>
                <strong>{actionLabel(log.action)}</strong>
                <p>{log.summary}</p>
                <small>{log.ticketId ?? "未关联"}</small>
                <em>{logStatusLabel(log.status)}</em>
              </article>
            ))}
            {recentLogs.length === 0 && <p className="admin-empty-note">暂无微信下单日志</p>}
          </div>
        </div>
      )}
      {view === "users" && (
        <AdminUsersPanel groups={groups} onRefresh={onRefresh} />
      )}
      {(showAll || view === "work-order-settings") && (
        <div className="work-order-settings-grid" role="region" aria-label="工单设置配置台">
          <section className="admin-card config-list compact-config-panel" id="admin-groups" aria-labelledby="admin-groups-title">
            <form className="config-list-form compact-config-form" onSubmit={saveUserGroups}>
              <div className="compact-panel-head">
                <div>
                  <p className="compact-panel-kicker">权限与流转</p>
                  <h3 id="admin-groups-title">用户分组</h3>
                  <span>维护可认领、处理、验收的后台角色。</span>
                </div>
                <button className="secondary-button" type="submit" disabled={savingConfigId === "groups"}>保存用户分组配置</button>
              </div>
              <div className="settings-config-table group-settings-table" role="table" aria-label="用户分组配置表">
                <div className="settings-table-head settings-table-row group-settings-row" role="row">
                  <span role="columnheader">分组信息</span>
                  <span role="columnheader">权限</span>
                  <span role="columnheader">状态</span>
                  <span role="columnheader">操作</span>
                </div>
                {groups.map((group) => {
                  const isUsedByTickets = usedGroupNames.has(group.name);
                  const isPendingDelete = deletedGroupIds.has(group.id);
                  return (
                    <article key={group.id} className={`settings-table-row compact-config-row group-settings-row group-compact-row${isPendingDelete ? " is-pending-delete" : ""}`} role="row">
                      <div className="settings-cell settings-info-cell" role="cell">
                        <label className="settings-field settings-field-primary">
                          <input
                            className="settings-primary-input"
                            name={`group-${group.id}-name`}
                            defaultValue={group.name}
                            aria-label={`${group.name}名称`}
                            disabled={isPendingDelete}
                            onChange={(event) => updateGroupDraft(group.id, { name: event.target.value })}
                          />
                        </label>
                        <label className="settings-field settings-field-secondary">
                          <input className="settings-secondary-input" name={`group-${group.id}-description`} defaultValue={group.description} aria-label={`${group.name}说明`} disabled={isPendingDelete} />
                        </label>
                      </div>
                      <div className="settings-cell settings-permission-cell" role="cell">
                        <div className="compact-check-strip">
                          <label className="compact-check-row"><input name={`group-${group.id}-canClaim`} type="checkbox" defaultChecked={group.canClaim} aria-label={`${group.name}可认领`} disabled={isPendingDelete} />认领</label>
                          <label className="compact-check-row"><input name={`group-${group.id}-canProcess`} type="checkbox" defaultChecked={group.canProcess} aria-label={`${group.name}可处理`} disabled={isPendingDelete} />处理</label>
                          <label className="compact-check-row"><input name={`group-${group.id}-canAccept`} type="checkbox" defaultChecked={group.canAccept} aria-label={`${group.name}可验收`} disabled={isPendingDelete} />验收</label>
                          <label className="compact-check-row"><input name={`group-${group.id}-canAdmin`} type="checkbox" defaultChecked={group.canAdmin ?? false} aria-label={`${group.name}可管理后台`} disabled={isPendingDelete} />后台</label>
                        </div>
                      </div>
                      <div className="settings-cell settings-status-cell" role="cell">
                        {isPendingDelete ? (
                          <span className="compact-status-chip is-pending-delete" role="note" aria-label="待删除，保存后生效" title="保存后生效">待删除</span>
                        ) : (
                          <>
                            <label className="compact-check-row status-check-row">
                              <input
                                name={`group-${group.id}-enabled`}
                                type="checkbox"
                                defaultChecked={group.enabled}
                                aria-label={`${group.name}启用`}
                                disabled={isPendingDelete}
                                onChange={(event) => updateGroupDraft(group.id, { enabled: event.target.checked })}
                              />
                              启用
                            </label>
                            {isUsedByTickets && <span className="compact-status-chip is-locked" role="note" aria-label="已有工单，仅可停用" title="已有工单，仅可停用">仅可停用</span>}
                          </>
                        )}
                      </div>
                      <div className="settings-cell settings-action-cell compact-row-actions" role="cell">
                        {isPendingDelete ? (
                          <button
                            aria-label={`撤销删除${group.name}`}
                            className="secondary-button compact-undo-button"
                            type="button"
                            onClick={() => {
                              setDeletedGroupIds((current) => {
                                const next = new Set(current);
                                next.delete(group.id);
                                return next;
                              });
                              setStatus(null);
                            }}
                          >
                            撤销
                          </button>
                        ) : isUsedByTickets ? (
                          <span className="settings-action-placeholder">-</span>
                        ) : (
                          <button
                            aria-label={`删除${group.name}`}
                            className="danger-button"
                            type="button"
                            onClick={() => {
                              setDeletedGroupIds((current) => new Set([...current, group.id]));
                              setStatus(null);
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
                <article className="settings-table-row compact-config-row group-settings-row group-compact-row compact-config-row-new" role="row">
                  <div className="settings-cell settings-info-cell" role="cell">
                    <label className="settings-field settings-new-field settings-field-primary">
                      <strong className="compact-row-title">新增用户分组</strong>
                      <input
                        className="settings-primary-input"
                        name="newGroupName"
                        value={newGroupName}
                        onChange={(event) => setNewGroupName(event.target.value)}
                        placeholder="例如 客服组"
                        aria-label="新增分组名称"
                      />
                    </label>
                    <label className="settings-field settings-field-secondary">
                      <input className="settings-secondary-input" name="newGroupDescription" placeholder="说明该分组现场职责" aria-label="新增分组说明" />
                    </label>
                  </div>
                  <div className="settings-cell settings-permission-cell" role="cell">
                    <div className="compact-check-strip">
                      <label className="compact-check-row"><input name="newGroupCanClaim" type="checkbox" aria-label="新增分组可认领" />认领</label>
                      <label className="compact-check-row"><input name="newGroupCanProcess" type="checkbox" aria-label="新增分组可处理" />处理</label>
                      <label className="compact-check-row"><input name="newGroupCanAccept" type="checkbox" aria-label="新增分组可验收" />验收</label>
                      <label className="compact-check-row"><input name="newGroupCanAdmin" type="checkbox" aria-label="新增分组可管理后台" />后台</label>
                    </div>
                  </div>
                  <div className="settings-cell settings-status-cell" role="cell">
                    <span className="compact-status-chip is-new">新增</span>
                  </div>
                  <div className="settings-cell settings-action-cell" role="cell" aria-label="新增用户分组操作" />
                </article>
              </div>
            </form>
          </section>
          <section className="admin-card config-list compact-config-panel" id="admin-issues" aria-labelledby="admin-issues-title">
            <form className="config-list-form compact-config-form" onSubmit={saveIssueTypes}>
              <div className="compact-panel-head">
                <div>
                  <p className="compact-panel-kicker">类型与优先级</p>
                  <h3 id="admin-issues-title">问题类型</h3>
                  <span>配置催单时限、权重和默认处理组。</span>
                </div>
                <button className="secondary-button" type="submit" disabled={savingConfigId === "issues"}>保存问题类型配置</button>
              </div>
              <div className="settings-config-table issue-settings-table" role="table" aria-label="问题类型配置表">
                <div className="settings-table-head settings-table-row issue-settings-row" role="row">
                  <span role="columnheader">问题类型</span>
                  <span role="columnheader">规则</span>
                  <span role="columnheader">处理组</span>
                  <span role="columnheader">状态</span>
                  <span role="columnheader">操作</span>
                </div>
                {managedIssueTypes.map((item) => {
                  const isUsedByTickets = usedIssueTypeNames.has(item.name);
                  const isPendingDelete = deletedIssueTypeIds.has(item.id);
                  return (
                    <article key={item.id} className={`settings-table-row compact-config-row issue-settings-row issue-compact-row${isPendingDelete ? " is-pending-delete" : ""}`} role="row">
                      <div className="settings-cell settings-info-cell" role="cell">
                        <label className="settings-field settings-field-primary">
                          <input className="settings-primary-input" name={`issue-${item.id}-name`} defaultValue={item.name} aria-label={`${item.name}名称`} disabled={isPendingDelete} />
                        </label>
                      </div>
                      <div className="settings-cell settings-rule-cell" role="cell">
                        <label className="settings-inline-field">
                          <span>催单</span>
                          <input name={`issue-${item.id}-urgencyMinutes`} type="number" min={0} defaultValue={item.urgencyMinutes} aria-label={`${item.name}催单分钟`} disabled={isPendingDelete} />
                        </label>
                        <label className="settings-inline-field">
                          <span>权重</span>
                          <input name={`issue-${item.id}-priorityWeight`} type="number" defaultValue={item.priorityWeight} aria-label={`${item.name}优先权重`} disabled={isPendingDelete} />
                        </label>
                      </div>
                      <div className="settings-cell settings-select-cell" role="cell">
                        <label className="settings-field">
                          <select name={`issue-${item.id}-assignmentGroup`} defaultValue={assignmentGroupValue(item.assignmentGroup)} aria-label={`${item.name}默认处理组`} disabled={isPendingDelete}>
                            <option value="">未指定</option>
                            {groupOptions().map((groupName) => (
                              <option key={groupName} value={groupName}>{groupName}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="settings-cell settings-status-cell" role="cell">
                        {isPendingDelete ? (
                          <span className="compact-status-chip is-pending-delete" role="note" aria-label="待删除，保存后生效" title="保存后生效">待删除</span>
                        ) : (
                          <>
                            <label className="compact-check-row status-check-row"><input name={`issue-${item.id}-enabled`} type="checkbox" defaultChecked={item.enabled} aria-label={`${item.name}启用`} disabled={isPendingDelete} />启用</label>
                            {isUsedByTickets && <span className="compact-status-chip is-locked" role="note" aria-label="已有工单，仅可停用" title="已有工单，仅可停用">仅可停用</span>}
                          </>
                        )}
                      </div>
                      <div className="settings-cell settings-action-cell compact-row-actions" role="cell">
                        {isPendingDelete ? (
                          <button
                            aria-label={`撤销删除${item.name}`}
                            className="secondary-button compact-undo-button"
                            type="button"
                            onClick={() => {
                              setDeletedIssueTypeIds((current) => {
                                const next = new Set(current);
                                next.delete(item.id);
                                return next;
                              });
                              setStatus(null);
                            }}
                          >
                            撤销
                          </button>
                        ) : isUsedByTickets ? (
                          <span className="settings-action-placeholder">-</span>
                        ) : (
                          <button
                            aria-label={`删除${item.name}`}
                            className="danger-button"
                            type="button"
                            onClick={() => {
                              setDeletedIssueTypeIds((current) => new Set([...current, item.id]));
                              setStatus(null);
                            }}
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
                <article className="settings-table-row compact-config-row issue-settings-row issue-compact-row compact-config-row-new" role="row">
                  <div className="settings-cell settings-info-cell" role="cell">
                    <label className="settings-field settings-new-field settings-field-primary">
                      <strong className="compact-row-title">新增问题类型</strong>
                      <input className="settings-primary-input" name="newIssueName" value={newIssueName} onChange={(event) => setNewIssueName(event.target.value)} placeholder="例如 报馆" aria-label="新增问题类型名称" />
                    </label>
                  </div>
                  <div className="settings-cell settings-rule-cell" role="cell">
                    <label className="settings-inline-field">
                      <span>催单</span>
                      <input name="newIssueUrgencyMinutes" type="number" min={0} defaultValue={30} aria-label="新增问题类型催单分钟" />
                    </label>
                    <label className="settings-inline-field">
                      <span>权重</span>
                      <input name="newIssuePriorityWeight" type="number" defaultValue={10} aria-label="新增问题类型优先权重" />
                    </label>
                  </div>
                  <div className="settings-cell settings-select-cell" role="cell">
                    <label className="settings-field">
                      <select name="newIssueAssignmentGroup" defaultValue="" disabled={!newIssueName.trim()} aria-label="新增问题类型默认处理组">
                        <option value="">未指定</option>
                        {newIssueName.trim() && groupOptions().map((groupName) => (
                          <option key={groupName} value={groupName}>{groupName}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="settings-cell settings-status-cell" role="cell">
                    <span className="compact-status-chip is-new">新增</span>
                  </div>
                  <div className="settings-cell settings-action-cell" role="cell" aria-label="新增问题类型操作" />
                </article>
              </div>
            </form>
          </section>
        </div>
      )}
      {(showAll || view === "system") && <div className="admin-card config-list" id="admin-ai">
        <h3>智能接口</h3>
        {config.aiModels.map((item) => {
          const selectedPreset = providerPresetFor(selectedAiProviderPresetId(item));
          const presetHasDefaults = selectedPreset.id !== "custom";
          const modelList = aiModelLists[item.id];
          const modelName = selectedAiModelName(item, presetHasDefaults ? selectedPreset.modelName : undefined);
          const modelOptions = uniqueModelOptions([
            modelName,
            item.modelName,
            presetHasDefaults ? selectedPreset.modelName : undefined,
            ...(modelList?.models ?? [])
          ]);
          return (
            <form key={item.id} className="config-edit-card" onSubmit={(event) => saveAiModel(event, item.id)}>
              <strong className="config-edit-title">{item.label}</strong>
              <div className="config-edit-grid">
                <label>
                  <span>{item.label}供应商预设</span>
                  <select name="providerPreset" value={selectedPreset.id} aria-label={`${item.label}供应商预设`} onChange={(event) => changeAiProviderPreset(event, item.id)}>
                    {AI_PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{item.label}供应商</span>
                  <select name="provider" defaultValue={presetHasDefaults ? "http" : item.provider} aria-label={`${item.label}供应商`}>
                    <option value="mock">本地模拟</option>
                    <option value="http">网络接口</option>
                  </select>
                </label>
                <label>
                  <span>{item.label}接口地址</span>
                  <input name="endpoint" defaultValue={presetHasDefaults ? selectedPreset.endpoint ?? "" : item.endpoint ?? ""} placeholder="https://api.openai.com/v1/chat/completions" aria-label={`${item.label}接口地址`} />
                </label>
                <label>
                  <span>{aiModelControlLabel(item.label, "模型名称")}</span>
                  <select name="modelName" value={modelName} aria-label={aiModelControlLabel(item.label, "模型名称")} onChange={(event) => changeAiModelName(event, item.id)}>
                    {modelOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{item.label}接口密钥</span>
                  <input name="apiKey" type="password" defaultValue={item.apiKeyConfigured ? MASKED_API_KEY : ""} placeholder="输入接口密钥" aria-label={`${item.label}接口密钥`} autoComplete="off" onFocus={(event) => {
                    if (event.currentTarget.value === MASKED_API_KEY) event.currentTarget.select();
                  }} />
                </label>
                <label>
                  <span>{item.label}超时毫秒</span>
                  <input name="timeoutMs" type="number" min={100} defaultValue={presetHasDefaults ? selectedPreset.timeoutMs ?? item.timeoutMs : item.timeoutMs} aria-label={`${item.label}超时毫秒`} />
                </label>
              </div>
              <p className="config-lock-note">{selectedPreset.helper}</p>
              {modelList?.error && <p className="config-lock-note">{modelList.error}</p>}
              <label className="check-row"><input name="enabled" type="checkbox" defaultChecked={item.enabled} />{item.label}启用</label>
              <button aria-label={`获取${aiModelControlLabel(item.label, "模型列表")}`} className="secondary-button" type="button" onClick={(event) => loadAiModelList(event, item.id)} disabled={modelList?.loading}>{modelList?.loading ? "获取中" : "获取模型列表"}</button>
              <button aria-label={`保存${item.label}`} className="secondary-button" type="submit" disabled={savingConfigId === `ai-${item.id}`}>保存{item.label}</button>
            </form>
          );
        })}
      </div>}
      {(showAll || view === "system") && <div className="admin-card config-list" id="admin-ai-prompts">
        <h3>智能调用预设</h3>
        <p className="config-lock-note">内置预设只读；复制后会生成自定义模板，可编辑并设为当前默认。</p>
        <p className="config-lock-note">识别顺序：自定义关键词优先判断是否处理和问题类型；未命中问题类型时才调用智能分类。创建工单时，智能模型仍会参与相似工单判重。智能提示词只影响实际调用智能模型的场景，不会覆盖已命中的关键词规则。</p>
        <div className="ai-prompt-scenario-list">
          {AI_PROMPT_SCENARIOS.map((scenario) => {
            const templates = aiPromptTemplates.filter((template) => template.scenario === scenario.id);
            const defaultId = aiPromptDefaults[scenario.id];
            const defaultTemplate = templates.find((template) => template.id === defaultId) ?? templates[0];
            return (
              <section key={scenario.id} className="ai-prompt-scenario" aria-label={`${scenario.label}提示词预设`}>
                <div className="ai-prompt-scenario-head">
                  <div>
                    <strong>{scenario.label}</strong>
                    <span>{scenario.helper}</span>
                  </div>
                  <em>默认：{defaultTemplate?.name ?? "未设置"}</em>
                </div>
                <div className="ai-prompt-template-list">
                  {templates.map((template) => template.builtIn ? (
                    <article key={template.id} className="ai-prompt-template is-builtin">
                      <div className="ai-prompt-template-head">
                        <strong>{template.name}</strong>
                        <span>{defaultId === template.id ? "当前默认" : "内置"}</span>
                      </div>
                      <p>{template.description}</p>
                      <code>{template.systemPrompt}</code>
                      <div className="ai-prompt-actions">
                        <button aria-label={`复制${template.name}`} className="secondary-button" type="button" onClick={() => copyPromptTemplate(template)} disabled={savingConfigId === `ai-prompt-${scenario.id}`}>复制后编辑</button>
                        <button aria-label={`设为${template.name}默认模板`} className="secondary-button" type="button" onClick={() => setPromptDefault(template)} disabled={defaultId === template.id || savingConfigId === `ai-prompt-${scenario.id}`}>设为默认</button>
                      </div>
                    </article>
                  ) : (
                    <form key={template.id} className="ai-prompt-template is-custom" onSubmit={(event) => savePromptTemplate(event, template)}>
                      <div className="ai-prompt-template-head">
                        <strong>{template.name}</strong>
                        <span>{defaultId === template.id ? "当前默认" : "自定义"}</span>
                      </div>
                      <div className="config-edit-grid">
                        <label>
                          <span>模板名称</span>
                          <input name="promptName" defaultValue={template.name} aria-label={`${template.name}模板名称`} />
                        </label>
                        <label>
                          <span>说明</span>
                          <input name="promptDescription" defaultValue={template.description} aria-label={`${template.name}模板说明`} />
                        </label>
                      </div>
                      <label>
                        <span>系统提示词</span>
                        <textarea name="systemPrompt" defaultValue={template.systemPrompt} aria-label={`${template.name}系统提示词`} />
                      </label>
                      <label className="check-row"><input name="enabled" type="checkbox" defaultChecked={template.enabled} />启用</label>
                      <div className="ai-prompt-actions">
                        <button aria-label={`保存${template.name}模板`} className="secondary-button" type="submit" disabled={savingConfigId === `ai-prompt-${scenario.id}`}>保存模板</button>
                        <button aria-label={`保存并设为${template.name}默认模板`} className="secondary-button" type="button" onClick={(event) => saveAndSetDefaultPromptTemplate(event, template)} disabled={savingConfigId === `ai-prompt-${scenario.id}`}>保存并设为默认</button>
                        <button aria-label={`删除${template.name}模板`} className="secondary-button" type="button" onClick={() => deletePromptTemplate(template)} disabled={savingConfigId === `ai-prompt-${scenario.id}`}>删除模板</button>
                      </div>
                    </form>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>}
      {(showAll || view === "system") && <div className="admin-card config-list" id="admin-auto-acceptance">
        <h3>自动验收</h3>
        <form className="config-list-form" onSubmit={saveAutoAcceptance} noValidate>
          <article className="config-edit-card">
            <strong className="config-edit-title">自动验收</strong>
            <p className="config-lock-note">处理组标记完成后，业务组在时效内未验收将由系统自动闭环。</p>
            <div className="config-edit-grid">
              <label>
                <span>处理完成后自动验收时效（分钟）</span>
                <input
                  name="autoAcceptance-timeoutMinutes"
                  type="number"
                  min={AUTO_ACCEPTANCE_MIN_MINUTES}
                  max={AUTO_ACCEPTANCE_MAX_MINUTES}
                  step={1}
                  defaultValue={autoAcceptance.timeoutMinutes}
                  aria-label="处理完成后自动验收时效（分钟）"
                />
              </label>
            </div>
            <div className="config-check-grid">
              <label className="check-row"><input name="autoAcceptance-enabled" type="checkbox" defaultChecked={autoAcceptance.enabled} />启用自动验收</label>
            </div>
          </article>
          <button className="secondary-button" type="submit" disabled={savingConfigId === "auto-acceptance"}>保存自动验收配置</button>
        </form>
      </div>}
      {(showAll || view === "system") && <div className="admin-card config-list" id="admin-message">
        <h3>wxauto 桌面服务</h3>
        <form className="config-list-form" onSubmit={saveWxautoMcp}>
          <article className="config-edit-card" key={`${wxautoMcp.enabled}-${wxautoMcp.autoCreateTickets}-${wxautoMcp.accessToken ?? wxautoMcp.tokenPreview ?? ""}`}>
            <strong className="config-edit-title">内置标准 MCP 服务</strong>
            <p className="config-lock-note">打开后台后，看板会自动准备 wxauto MCP 服务。桌面应用只需要填写服务地址和访问令牌，不再需要配置微信 MCP 服务器名、接收地址或密钥环境变量。</p>
            <div className="config-edit-grid">
              <label>
                <span>MCP 服务地址</span>
                <input name="wxautoMcp-endpoint" value={wxautoMcp.endpoint || WXAUTO_MCP_ENDPOINT} aria-label="MCP 服务地址" readOnly />
              </label>
              <label>
                <span>访问令牌</span>
                <input name="wxautoMcp-accessToken" defaultValue={wxautoMcp.accessToken ?? ""} aria-label="wxauto访问令牌" placeholder="保存后自动生成，也可手动粘贴" />
              </label>
            </div>
            <div className="config-check-grid">
              <label className="check-row"><input name="wxautoMcp-enabled" type="checkbox" defaultChecked={wxautoMcp.enabled} />启用 wxauto 桌面服务</label>
              <label className="check-row"><input name="wxautoMcp-autoCreateTickets" type="checkbox" defaultChecked={wxautoMcp.autoCreateTickets} />自动建单</label>
            </div>
            <p className="config-lock-note">当前令牌：{wxautoMcp.tokenPreview ?? (wxautoMcp.accessToken ? "已设置" : "未设置")}。桌面应用填写看板地址加 <code>/api/mcp</code>，访问令牌填写上方令牌。</p>
          </article>
          <div className="config-action-row">
            <button className="secondary-button" type="submit" disabled={savingConfigId === "wxauto-mcp"}>保存 wxauto 设置</button>
            <button className="secondary-button" type="button" onClick={() => void rotateWxautoToken()} disabled={savingConfigId === "wxauto-mcp"}>重置访问令牌</button>
          </div>
        </form>
      </div>}
      {(showAll || view === "system") && <div className="admin-card config-list" id="admin-keywords">
        <h3>关键词配置</h3>
        <form className="config-list-form" onSubmit={saveKeywordGroups}>
          {keywordGroups.map((group) => (
            <article className="config-edit-card" key={group.id}>
              <strong className="config-edit-title">{group.name}</strong>
              <label className="check-row"><input name={`keyword-group-${group.id}-enabled`} type="checkbox" defaultChecked={group.enabled} />{group.name}启用</label>
              <div className="keyword-rule-grid">
                {keywordRuleSetsOf(group).map((ruleSet) => {
                  const label = keywordRuleSetLabel(group, ruleSet);
                  return (
                    <div className="keyword-rule-row" key={ruleSet.id}>
                    <textarea
                      name={`keyword-rule-set-${ruleSet.id}-terms`}
                      defaultValue={keywordTermsText(ruleSet)}
                      aria-label={`${label}关键词`}
                      rows={2}
                    />
                    <select name={`keyword-rule-set-${ruleSet.id}-matchType`} defaultValue={ruleSet.matchType} aria-label={`${label}匹配方式`}>
                      <option value="contains">包含</option>
                      <option value="exact">完全匹配</option>
                    </select>
                    <select name={`keyword-rule-set-${ruleSet.id}-action`} defaultValue={ruleSet.action} aria-label={`${label}动作`}>
                      <option value="operational-intent">识别诉求</option>
                      <option value="issue-type">映射问题类型</option>
                    </select>
                    <select name={`keyword-rule-set-${ruleSet.id}-issueType`} defaultValue={ruleSet.issueType ?? ""} aria-label={`${label}问题类型`}>
                      <option value="">不指定</option>
                      {activeIssueTypes.map((issue) => (
                        <option key={issue.id} value={issue.name}>{issue.name}</option>
                      ))}
                    </select>
                    <input name={`keyword-rule-set-${ruleSet.id}-priority`} type="number" defaultValue={ruleSet.priority} aria-label={`${label}优先级`} />
                    <label className="check-row"><input name={`keyword-rule-set-${ruleSet.id}-enabled`} type="checkbox" defaultChecked={ruleSet.enabled} />启用</label>
                    </div>
                  );
                })}
              </div>
            </article>
          ))}
          <button className="secondary-button" type="submit" disabled={savingConfigId === "keywords"}>保存关键词配置</button>
        </form>
      </div>}
      {(showAll || view === "exhibition-data") && (
        <ExhibitionDataPanel booths={displayedBooths} isImporting={isImporting} onImportFile={importFile} />
      )}
        </div>
      </div>
    </section>
  );
}
