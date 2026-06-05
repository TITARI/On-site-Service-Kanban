# PC Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/admin` experience as a practical PC backend with a full left sidebar, operational workbench, denser management pages, and focused responsive styling.

**Architecture:** Keep the current client-side admin shell and API loading flow. Split the large admin panel into small view renderers inside `src/components/admin-panel.tsx` first, then extract files only if the component remains hard to navigate after the UI change. Use existing bootstrap data to compute workbench metrics and queues.

**Tech Stack:** Next.js app router, React client components, TypeScript, lucide-react, CSS in `src/styles/globals.css`, Vitest + Testing Library.

---

## Scope Check

The approved spec covers one subsystem: the PC admin UI. It touches admin layout, workbench content, focused admin pages, styling, and tests. It does not require backend API changes, auth changes, mobile app changes, or database work.

## File Structure

- Modify: `src/components/admin-shell.tsx`
  - Owns admin login state, bootstrap loading, logout, and the outer PC shell toolbar.
  - Add a cleaner shell title and pass refresh/loading state to the admin content when useful.
- Modify: `src/components/admin-panel.tsx`
  - Owns admin views and existing save handlers.
  - Add sidebar navigation, workbench metric helpers, workbench queue helpers, page headers, and compact management sections.
  - Keep existing form submit behavior intact.
- Modify: `src/styles/globals.css`
  - Replace the current admin-specific block with PC backend layout styles.
  - Keep mobile app classes intact.
- Modify: `tests/components/admin-panel.test.tsx`
  - Add tests for workbench metrics, exception queue, sidebar navigation, and quick configuration links.
  - Keep existing configuration-save tests passing.
- Modify: `tests/app/admin-routes.test.tsx`
  - Update route expectations for the new sidebar and workbench labels.
- Modify: `tests/app/admin-page.test.tsx`
  - Update login assertions if visible copy changes.
- Reference: `docs/superpowers/specs/2026-05-30-pc-admin-ui-design.md`
  - Source of truth for visual and information architecture.

## Task 1: Add Workbench Behavior Tests

**Files:**
- Modify: `tests/components/admin-panel.test.tsx`

- [ ] **Step 1: Add workbench fixture data**

Add these fixtures after the existing `outboundMessage` fixture:

```tsx
const resolvedTicket: Ticket = {
  ...ticketAssignedToBuilder,
  id: "ticket-closed",
  title: "B02 星河科技 清洁",
  boothNumber: "B02",
  issueType: "清洁",
  status: "已关闭",
  assignmentGroup: "服务组",
  createdAt: "2026-05-22T07:00:00.000Z",
  updatedAt: "2026-05-22T07:30:00.000Z"
};

const reviewMessageRecord: InboundMessageRecord = {
  ...messageRecord,
  id: "message-review",
  text: "图片里可能是配电箱问题",
  createdAt: "2026-05-22T08:40:01.000Z",
  analysis: {
    boothNumber: "A03",
    issueType: "待分类",
    confidence: 0.42,
    suggestedAction: "needs-review",
    reason: "图片内容置信度偏低，需要人工确认"
  }
};

const processedWechatLog = {
  id: "log-processed",
  channel: "wechat",
  action: "create-ticket",
  ticketId: "ticket-1",
  summary: "A01 展位网络问题已自动建单",
  status: "processed",
  createdAt: "2026-05-22T09:00:00.000Z"
};
```

- [ ] **Step 2: Add failing workbench test**

Add this test near the end of `describe("AdminConfigCenter user groups", () => { ... })`, before the record-management test:

```tsx
it("renders the PC workbench with operational metrics, exception queue and quick config links", () => {
  render(
    <AdminConfigCenter
      config={config}
      view="workbench"
      tickets={[ticketAssignedToBuilder, resolvedTicket]}
      messageRecords={[messageRecord, reviewMessageRecord]}
      outboundMessages={[outboundMessage]}
      wechatOrderLogs={[processedWechatLog]}
      booths={[{
        boothNumber: "A01",
        companyName: "上海星河科技有限公司",
        companyShortName: "星河科技",
        salesOwner: "王宁",
        builder: "搭建组"
      }]}
      onRefresh={vi.fn()}
    />
  );

  expect(screen.getByRole("heading", { name: "后台工作台" })).not.toBeNull();
  expect(screen.getByText("未关闭工单")).not.toBeNull();
  expect(screen.getByText("待处理工单")).not.toBeNull();
  expect(screen.getByText("失败通知")).not.toBeNull();
  expect(screen.getByText("自动建单率")).not.toBeNull();
  expect(screen.getByText("待处理与异常队列")).not.toBeNull();
  expect(screen.getByText("A01 星河科技 搭建")).not.toBeNull();
  expect(screen.getByText("通知失败")).not.toBeNull();
  expect(screen.getByText("微信下单动态")).not.toBeNull();
  expect(screen.getByText("A01 展位网络问题已自动建单")).not.toBeNull();
  expect(screen.getByRole("link", { name: "用户分组" }).getAttribute("href")).toBe("/admin/work-order-settings#admin-groups");
  expect(screen.getByRole("link", { name: "关键词规则" }).getAttribute("href")).toBe("/admin/system#admin-keywords");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx -t "renders the PC workbench"
```

Expected: FAIL because the current workbench does not render the new labels, exception queue, or quick config links.

## Task 2: Add Sidebar Navigation Tests

**Files:**
- Modify: `tests/components/admin-panel.test.tsx`
- Modify: `tests/app/admin-routes.test.tsx`

- [ ] **Step 1: Add component-level sidebar test**

Add this test after the new workbench test:

```tsx
it("marks the active admin sidebar item and exposes all primary admin modules", () => {
  render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

  expect(screen.getByRole("navigation", { name: "后台主导航" })).not.toBeNull();
  expect(screen.getByRole("link", { name: "后台工作台" }).getAttribute("href")).toBe("/admin");
  expect(screen.getByRole("link", { name: "微信下单日志" }).getAttribute("href")).toBe("/admin/logs");
  expect(screen.getByRole("link", { name: "工单设置" }).getAttribute("href")).toBe("/admin/work-order-settings");
  expect(screen.getByRole("link", { name: "展览数据" }).getAttribute("href")).toBe("/admin/exhibition-data");
  expect(screen.getByRole("link", { name: "系统配置" }).getAttribute("aria-current")).toBe("page");
});
```

- [ ] **Step 2: Update route test expectations**

In `tests/app/admin-routes.test.tsx`, change the root route test to assert the new sidebar label and workbench structure:

```tsx
it("uses the root admin route as a workbench with sidebar navigation", async () => {
  await renderWithSession(<AdminPage />);

  expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
  expect(screen.getByRole("navigation", { name: "后台主导航" })).not.toBeNull();
  expect(screen.getByRole("link", { name: "微信下单日志" }).getAttribute("href")).toBe("/admin/logs");
  expect(screen.getByRole("link", { name: "工单设置" }).getAttribute("href")).toBe("/admin/work-order-settings");
  expect(screen.getByRole("link", { name: "展览数据" }).getAttribute("href")).toBe("/admin/exhibition-data");
  expect(screen.getByRole("link", { name: "系统配置" }).getAttribute("href")).toBe("/admin/system");
  expect(screen.queryByRole("heading", { name: "用户分组" })).toBeNull();
});
```

- [ ] **Step 3: Run sidebar-related tests to verify failure**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx -t "active admin sidebar"
npm test -- tests/app/admin-routes.test.tsx -t "root admin route"
```

Expected: FAIL because the current navigation uses `aria-label="后台配置导航"` and horizontal pills rather than the new sidebar.

## Task 3: Implement Admin View Metadata, Metrics, and Sidebar

**Files:**
- Modify: `src/components/admin-panel.tsx`

- [ ] **Step 1: Add lucide icons and view metadata**

Change the imports at the top:

```tsx
import { Activity, Bot, ClipboardList, Database, FileClock, Gauge, Layers, MessageSquareText, Settings, ShieldCheck, Sparkles, TriangleAlert } from "lucide-react";
```

Add this metadata after the `WechatOrderLog` type:

```tsx
const ADMIN_NAV_ITEMS: Array<{
  view: Exclude<AdminView, "all">;
  label: string;
  href: string;
  icon: typeof Gauge;
  group: "daily" | "manage";
}> = [
  { view: "workbench", label: "后台工作台", href: "/admin", icon: Gauge, group: "daily" },
  { view: "logs", label: "微信下单日志", href: "/admin/logs", icon: FileClock, group: "daily" },
  { view: "work-order-settings", label: "工单设置", href: "/admin/work-order-settings", icon: ClipboardList, group: "manage" },
  { view: "exhibition-data", label: "展览数据", href: "/admin/exhibition-data", icon: Database, group: "manage" },
  { view: "system", label: "系统配置", href: "/admin/system", icon: Settings, group: "manage" }
];

const QUICK_CONFIG_LINKS = [
  { label: "用户分组", href: "/admin/work-order-settings#admin-groups", icon: Layers },
  { label: "问题类型", href: "/admin/work-order-settings#admin-issues", icon: ClipboardList },
  { label: "关键词规则", href: "/admin/system#admin-keywords", icon: Sparkles },
  { label: "AI 接口", href: "/admin/system#admin-ai", icon: Bot }
];

function adminViewLabel(view: AdminView) {
  return ADMIN_NAV_ITEMS.find((item) => item.view === view)?.label ?? "配置总览";
}

function adminViewDescription(view: AdminView) {
  if (view === "logs") return "查看微信/企微消息分析、建单、匹配和待确认记录。";
  if (view === "work-order-settings") return "维护用户分组、问题类型和工单识别规则。";
  if (view === "exhibition-data") return "查看展位主数据状态并承接导入校验。";
  if (view === "system") return "维护 AI 接口、微信/企微 MCP 和系统级配置。";
  return "集中查看今日状态、待处理风险和常用后台入口。";
}
```

- [ ] **Step 2: Add metric helpers**

Add these helpers after `shortDateTime`:

```tsx
function isOpenTicket(ticket: Ticket) {
  return ticket.status !== "已关闭";
}

function isPendingTicket(ticket: Ticket) {
  return ticket.status === "待受理" || ticket.status === "待再次处理";
}

function metricPercent(part: number, total: number) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

function actionBadgeText(action: string) {
  if (action === "create-ticket") return "自动建单";
  if (action === "urge-existing") return "匹配催单";
  if (action === "needs-review") return "待确认";
  return "已忽略";
}
```

- [ ] **Step 3: Add `AdminSidebar` renderer**

Add this component before `export function AdminConfigCenter`:

```tsx
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
          <small>PC 后台管理</small>
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
              {item.view === "workbench" && openCount > 0 && <em>{openCount}</em>}
              {item.view === "logs" && logCount > 0 && <em>{logCount}</em>}
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
        <span>{messageIntegrationsEnabled} 个消息接入，{aiEnabled} 个 AI 模型启用</span>
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Run TypeScript-checking tests to verify compile errors**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx -t "active admin sidebar"
```

Expected: still FAIL until `AdminConfigCenter` uses `AdminSidebar`.

## Task 4: Implement the PC Workbench Markup

**Files:**
- Modify: `src/components/admin-panel.tsx`

- [ ] **Step 1: Add `AdminMetricCard` and `AdminWorkbench` components**

Add these components before `export function AdminConfigCenter`:

```tsx
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
  enabledAiModels,
  enabledMessageIntegrations
}: {
  tickets: Ticket[];
  booths: BoothRecord[];
  recentLogs: WechatOrderLog[];
  failedOutboundMessages: OutboundMessage[];
  messageRecords: InboundMessageRecord[];
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
      source: channelName(record.channel),
      status: "待人工确认",
      owner: record.senderName,
      time: record.createdAt
    }))
  ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 6);
  const actionableTotal = pendingTickets.length + failedOutboundMessages.length + reviewMessages.length;
  const autoLogs = recentLogs.filter((log) => log.action === "create-ticket").length;
  const autoRate = metricPercent(autoLogs, recentLogs.length);

  return (
    <div className="admin-workbench">
      <div className="admin-metric-grid">
        <AdminMetricCard label="未关闭工单" value={openTickets.length} helper={`共 ${tickets.length} 张工单`} percent={metricPercent(openTickets.length, Math.max(tickets.length, 1))} />
        <AdminMetricCard label="待处理工单" value={pendingTickets.length} helper="待受理 / 待再次处理" tone="warning" percent={metricPercent(pendingTickets.length, Math.max(openTickets.length, 1))} />
        <AdminMetricCard label="失败通知" value={failedOutboundMessages.length} helper="需要人工复核发送" tone="danger" percent={metricPercent(failedOutboundMessages.length, Math.max(failedOutboundMessages.length + 5, 1))} />
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
                    <Icon size={18} aria-hidden="true" />
                    <span>{item.label}</span>
                  </a>
                );
              })}
            </div>
          </section>

          <section className="admin-card admin-data-card">
            <Activity size={18} aria-hidden="true" />
            <div>
              <strong>展览数据</strong>
              <p>当前展位数据 {booths.length} 条</p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace the existing workbench block**

Inside `AdminConfigCenter`, replace the current `view === "workbench"` block with:

```tsx
{view === "workbench" && (
  <AdminWorkbench
    tickets={tickets}
    booths={booths}
    recentLogs={recentLogs}
    failedOutboundMessages={failedOutboundMessages}
    messageRecords={messageRecords}
    enabledAiModels={config.aiModels.filter((model) => model.enabled).length}
    enabledMessageIntegrations={messageIntegrations.filter((item) => item.enabled).length}
  />
)}
```

- [ ] **Step 3: Run the workbench test**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx -t "renders the PC workbench"
```

Expected: PASS after Task 5 connects the outer layout; if this still fails now, failure should be limited to missing sidebar or accessible link names.

## Task 5: Connect the New Admin Layout

**Files:**
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/components/admin-shell.tsx`

- [ ] **Step 1: Replace `AdminConfigCenter` wrapper markup**

In `src/components/admin-panel.tsx`, replace the opening part of the return with:

```tsx
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
          <h2>{adminViewLabel(view)}</h2>
          <span>{adminViewDescription(view)}</span>
        </div>
        <div className="admin-page-actions">
          <button className="secondary-button" type="button" onClick={onRefresh}>刷新数据</button>
        </div>
      </div>
      {status && <p className="form-message">{status}</p>}
      <div className="admin-view-body">
```

Replace the final closing `</section>` with:

```tsx
      </div>
    </div>
  </section>
);
```

Delete the old `.admin-config-head`, horizontal `.admin-config-nav`, and `.admin-overview-grid` markup from the return. Keep every existing view-specific form block inside `admin-view-body`.

- [ ] **Step 2: Simplify shell toolbar**

In `src/components/admin-shell.tsx`, keep the logout button but remove duplicated page-title noise from the toolbar by changing the authenticated return toolbar to:

```tsx
<div className="admin-page-toolbar">
  <div>
    <span>PC 后台</span>
    <strong>{adminTitle(view)}</strong>
  </div>
  <button className="secondary-button" type="button" onClick={logout}><LogOut size={16} aria-hidden="true" />退出后台</button>
</div>
```

If the file already contains this structure, only ensure the visible strings are valid Chinese text and keep the button accessible name `退出后台`.

- [ ] **Step 3: Run layout tests**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx -t "active admin sidebar"
npm test -- tests/app/admin-routes.test.tsx -t "root admin route"
```

Expected: PASS.

## Task 6: Convert Logs and Config Pages to Dense PC Sections

**Files:**
- Modify: `src/components/admin-panel.tsx`
- Modify: `tests/app/admin-routes.test.tsx`

- [ ] **Step 1: Update logs route test**

In `tests/app/admin-routes.test.tsx`, keep the existing log-data fetch assertion and update the heading expectation to the final Chinese string:

```tsx
expect((await screen.findAllByRole("heading", { name: "微信下单日志" })).length).toBeGreaterThan(0);
```

- [ ] **Step 2: Change logs markup to table-like rows**

Replace the `view === "logs"` block with:

```tsx
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
          <span>{channelName(log.channel as InboundMessageRecord["channel"])}</span>
          <strong>{actionName(log.action as InboundMessageRecord["analysis"]["suggestedAction"])}</strong>
          <p>{log.summary}</p>
          <small>{log.ticketId ?? "未关联"}</small>
          <em>{log.status}</em>
        </article>
      ))}
      {recentLogs.length === 0 && <p className="admin-empty-note">暂无微信下单日志</p>}
    </div>
  </div>
)}
```

- [ ] **Step 3: Wrap config sections in `admin-card`**

For each existing config section root, add the `admin-card` class while preserving IDs:

```tsx
<div className="admin-card config-list" id="admin-groups">
<div className="admin-card config-list" id="admin-issues">
<div className="admin-card config-list" id="admin-ai">
<div className="admin-card config-list" id="admin-message">
<div className="admin-card config-list" id="admin-keywords">
<div className="admin-card config-list" id="admin-master-data">
```

Keep existing form controls, labels, submit handlers, and button text intact.

- [ ] **Step 4: Run route and component tests**

Run:

```powershell
npm test -- tests/app/admin-routes.test.tsx
npm test -- tests/components/admin-panel.test.tsx
```

Expected: PASS. Existing save behavior tests must still pass.

## Task 7: Rewrite Admin CSS for the Approved PC Design

**Files:**
- Modify: `src/styles/globals.css`

- [ ] **Step 1: Replace old admin layout rules**

Replace the CSS block from `.admin-page-shell` through `.keyword-rule-row` media rules with the new admin styles below. Keep mobile app styles before and after this block untouched.

```css
.admin-login-shell,
.admin-page-shell {
  min-height: 100dvh;
}

.admin-login-shell {
  display: grid;
  place-items: center;
  padding: 28px;
}

.admin-login-card {
  display: grid;
  gap: 12px;
  width: min(100%, 420px);
  border: 1px solid rgba(31, 106, 77, 0.12);
  border-radius: 8px;
  padding: 26px;
  background: rgba(255, 253, 247, 0.94);
  box-shadow: var(--surface-shadow);
}

.admin-login-card h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.12;
}

.admin-page-shell {
  width: min(100% - 32px, 1400px);
  margin: 0 auto;
  padding: 22px 0 40px;
}

.admin-page-shell.loading {
  display: grid;
  place-items: center;
}

.admin-page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.admin-page-toolbar div {
  display: grid;
  gap: 2px;
}

.admin-page-toolbar span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 900;
}

.admin-page-toolbar strong {
  color: var(--green-deep);
  font-size: 20px;
}

.admin-console {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: calc(100dvh - 102px);
  border: 1px solid rgba(31, 106, 77, 0.13);
  border-radius: 8px;
  background: rgba(247, 249, 246, 0.94);
  box-shadow: var(--tight-shadow);
  overflow: hidden;
}

.admin-sidebar {
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 18px;
  border-right: 1px solid rgba(31, 106, 77, 0.12);
  padding: 18px 14px;
  background: rgba(255, 253, 247, 0.96);
}

.admin-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.admin-brand-mark {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border-radius: 8px;
  background: var(--green);
  color: #fff;
}

.admin-brand strong,
.admin-brand small {
  display: block;
}

.admin-brand strong {
  color: var(--green-deep);
  font-size: 15px;
  line-height: 1.2;
}

.admin-brand small {
  color: var(--muted);
  font-size: 11.5px;
}

.admin-side-nav {
  display: grid;
  align-content: start;
  gap: 7px;
}

.admin-side-label {
  margin-top: 6px;
  padding: 0 9px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 900;
}

.admin-side-nav a {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 38px;
  border-radius: 8px;
  padding: 7px 9px;
  color: #4f5b54;
  font-size: 13px;
  font-weight: 900;
  text-decoration: none;
}

.admin-side-nav a.active,
.admin-side-nav a[aria-current="page"] {
  background: var(--green-soft);
  color: var(--green-deep);
}

.admin-side-nav a em {
  border-radius: 999px;
  padding: 2px 7px;
  background: #fff1dd;
  color: var(--amber);
  font-size: 11px;
  font-style: normal;
}

.admin-side-status {
  display: grid;
  gap: 5px;
  border-radius: 8px;
  padding: 10px;
  background: #f4f7f4;
  color: var(--muted);
  font-size: 12px;
}

.admin-side-status strong {
  color: var(--green-deep);
  font-size: 13px;
}

.admin-main-panel {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr;
}

.admin-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid rgba(31, 106, 77, 0.12);
  padding: 18px 22px;
  background: rgba(255, 253, 247, 0.86);
}

.admin-page-head h2 {
  margin: 0;
  color: var(--green-deep);
  font-size: 24px;
  line-height: 1.15;
}

.admin-page-head span {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
}

.admin-page-actions {
  display: flex;
  gap: 8px;
}

.admin-view-body {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 14px;
  padding: 18px 22px 24px;
  overflow: auto;
}

.admin-workbench,
.admin-workbench-layout,
.admin-side-stack,
.admin-metric-grid {
  display: grid;
  gap: 12px;
}

.admin-metric-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.admin-metric-card,
.admin-card {
  border: 1px solid rgba(31, 106, 77, 0.11);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.82);
}

.admin-metric-card {
  display: grid;
  gap: 7px;
  min-height: 104px;
  padding: 13px;
}

.admin-metric-card span,
.admin-metric-card small {
  color: var(--muted);
  font-size: 12px;
  font-weight: 900;
}

.admin-metric-card strong {
  color: var(--green-deep);
  font-size: 30px;
  line-height: 1;
}

.admin-metric-card i {
  height: 7px;
  border-radius: 999px;
  background: rgba(31, 106, 77, 0.1);
  overflow: hidden;
}

.admin-metric-card i b {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--green);
}

.admin-metric-warning i b { background: var(--amber); }
.admin-metric-danger i b { background: var(--red); }
.admin-metric-info i b { background: var(--blue); }

.admin-workbench-layout {
  grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.8fr);
}

.admin-card {
  min-width: 0;
  overflow: hidden;
}

.admin-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid rgba(31, 106, 77, 0.09);
  padding: 12px 14px;
}

.admin-card-head h3 {
  margin: 0;
  color: var(--green-deep);
  font-size: 15px;
}

.admin-card-head p,
.admin-card-head span,
.admin-card-head a {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}

.admin-card-head a {
  color: var(--green);
  text-decoration: none;
}

.admin-table,
.admin-log-table {
  display: grid;
}

.admin-table-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.2fr) 88px 96px 100px 78px;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  border-bottom: 1px solid rgba(31, 106, 77, 0.08);
  padding: 9px 14px;
  color: #4f5b54;
  font-size: 12.5px;
}

.admin-table-head,
.admin-log-head {
  min-height: 36px;
  background: rgba(247, 249, 246, 0.9);
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 900;
}

.admin-table-row strong {
  min-width: 0;
  color: var(--ink);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.admin-table-row em,
.admin-log-row em {
  justify-self: start;
  border-radius: 999px;
  padding: 4px 8px;
  background: var(--green-soft);
  color: var(--green);
  font-size: 11.5px;
  font-style: normal;
  font-weight: 900;
}

.admin-table-row em.warning,
.admin-log-row em.warning {
  background: #fff1dd;
  color: var(--amber);
}

.admin-table-row em.danger,
.admin-log-row em.danger {
  background: #ffe8e4;
  color: var(--red);
}

.admin-timeline {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
}

.admin-timeline article {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  gap: 9px;
}

.admin-timeline i {
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 999px;
  background: var(--green);
}

.admin-timeline strong {
  color: var(--ink);
  font-size: 13px;
}

.admin-timeline p {
  margin: 3px 0 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.35;
}

.admin-timeline time,
.admin-table-row time {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 900;
}

.admin-quick-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 12px 14px;
}

.admin-quick-grid a {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 50px;
  border: 1px solid rgba(31, 106, 77, 0.1);
  border-radius: 8px;
  padding: 10px;
  background: rgba(247, 249, 246, 0.9);
  color: var(--green-deep);
  font-size: 13px;
  font-weight: 900;
  text-decoration: none;
}

.admin-data-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  color: var(--green);
}

.admin-data-card strong {
  display: block;
  color: var(--green-deep);
  font-size: 14px;
}

.admin-data-card p,
.admin-empty-note {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
}

.admin-empty-note {
  padding: 12px 14px;
}

.admin-log-row {
  display: grid;
  grid-template-columns: 92px 84px 100px minmax(220px, 1fr) 108px 88px;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  border-bottom: 1px solid rgba(31, 106, 77, 0.08);
  padding: 9px 14px;
  color: #4f5b54;
  font-size: 12.5px;
}

.admin-log-row p {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.admin-log-row strong {
  color: var(--green-deep);
  font-size: 12.5px;
}

.admin-log-row time,
.admin-log-row small {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 900;
}

.config-list {
  display: grid;
  gap: 10px;
  margin-top: 0;
  padding: 14px;
}

.config-list > h3 {
  margin: 0;
  color: var(--green-deep);
  font-size: 16px;
}

.config-list-form {
  display: grid;
  gap: 8px;
}

.config-edit-card {
  display: grid;
  gap: 8px;
  border: 1px solid rgba(31, 106, 77, 0.11);
  border-radius: 8px;
  padding: 10px;
  background: rgba(255, 253, 247, 0.72);
}

.config-edit-title {
  color: var(--green-deep);
  font-size: 13.5px;
  line-height: 1.2;
}

.config-edit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.config-edit-card label {
  display: grid;
  gap: 5px;
}

.config-edit-card label span {
  color: var(--muted);
  font-size: 11.5px;
  font-weight: 900;
}

.config-edit-card input,
.config-edit-card select {
  min-height: 38px;
  padding: 8px 10px;
  font-size: 13px;
}

.config-lock-note {
  margin: 0;
  border-radius: 8px;
  padding: 9px 10px;
  background: rgba(159, 132, 72, 0.11);
  color: var(--amber);
  font-size: 12.5px;
  font-weight: 900;
}

.config-check-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.keyword-rule-grid {
  display: grid;
  gap: 7px;
}

.keyword-rule-row {
  display: grid;
  grid-template-columns: minmax(220px, 2fr) 112px 132px minmax(120px, 1fr) 82px auto;
  gap: 7px;
  align-items: center;
  border: 1px solid rgba(31, 106, 77, 0.1);
  border-radius: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.62);
}

.keyword-rule-row textarea {
  min-height: 42px;
  resize: vertical;
}

@media (max-width: 1100px) {
  .admin-metric-grid,
  .admin-workbench-layout {
    grid-template-columns: 1fr 1fr;
  }

  .admin-workbench-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .admin-console {
    grid-template-columns: 1fr;
  }

  .admin-sidebar {
    border-right: 0;
    border-bottom: 1px solid rgba(31, 106, 77, 0.12);
  }

  .admin-side-nav {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .admin-side-label,
  .admin-side-status {
    grid-column: 1 / -1;
  }

  .admin-metric-grid,
  .config-edit-grid,
  .config-check-grid,
  .keyword-rule-row {
    grid-template-columns: 1fr;
  }

  .admin-table-row,
  .admin-log-row {
    grid-template-columns: 1fr;
    gap: 5px;
  }
}
```

- [ ] **Step 2: Run CSS-sensitive tests**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx
npm test -- tests/app/admin-routes.test.tsx
```

Expected: PASS. Testing Library ignores most CSS, but this catches class-related markup mistakes.

## Task 8: Fix Login Copy and Existing Mojibake Assertions If Needed

**Files:**
- Modify: `src/components/admin-shell.tsx`
- Modify: `tests/app/admin-page.test.tsx`
- Modify: `tests/app/admin-routes.test.tsx`

- [ ] **Step 1: Normalize visible admin shell copy**

If `src/components/admin-shell.tsx` contains mojibake strings, replace them with these exact visible strings:

```tsx
function adminTitle(view: AdminView) {
  if (view === "logs") return "微信下单日志";
  if (view === "work-order-settings") return "工单设置";
  if (view === "exhibition-data") return "展览数据";
  if (view === "system") return "系统配置";
  return "后台工作台";
}
```

Also use:

```tsx
if (!authReady) return <main className="admin-page-shell loading">加载中</main>;
```

and for login copy:

```tsx
<p className="eyebrow">PC 后台</p>
<h1>后台配置登录</h1>
<p className="auth-copy">登录后可进入工作台、查看微信下单日志、维护工单设置、集成配置和展览数据。</p>
```

- [ ] **Step 2: Update login tests to final copy**

In `tests/app/admin-page.test.tsx`, assert the final Chinese labels:

```tsx
expect(await screen.findByText("后台配置登录")).not.toBeNull();
expect(screen.getByLabelText("后台口令")).not.toBeNull();
expect(screen.queryByText("后台工作台")).toBeNull();
```

and:

```tsx
await user.type(await screen.findByLabelText("后台口令"), "admin123");
await user.click(screen.getByRole("button", { name: "进入后台" }));
expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
```

- [ ] **Step 3: Run login tests**

Run:

```powershell
npm test -- tests/app/admin-page.test.tsx
```

Expected: PASS.

## Task 9: Full Verification and Browser Review

**Files:**
- No source edits unless verification finds a defect.

- [ ] **Step 1: Run focused admin tests**

Run:

```powershell
npm test -- tests/components/admin-panel.test.tsx tests/app/admin-page.test.tsx tests/app/admin-routes.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```powershell
npm test -- --run
```

Expected: PASS.

- [ ] **Step 3: Build the app**

Run:

```powershell
npm run build
```

Expected: PASS with a successful Next.js production build.

- [ ] **Step 4: Start or reuse the dev server**

Run:

```powershell
npm run dev
```

Expected: server starts on an available local port. If port 3000 is busy, use the existing server URL shown in the terminal or start Next on another port with `npx next dev -p 3001`.

- [ ] **Step 5: Verify in the in-app browser**

Open `/admin` in the browser, log in with the existing admin password, and verify:

```text
1. Left sidebar is visible with all five modules.
2. Workbench first screen shows four metric cards.
3. Exception queue, WeChat dynamics, quick config and exhibition-data card are visible.
4. /admin/logs shows the log table or an empty state.
5. /admin/work-order-settings keeps user group and issue type save buttons working.
6. /admin/system keeps AI, MCP and keyword save buttons visible.
7. At approximately 1280px and 900px wide, text does not overlap and no horizontal page scroll appears.
```

Expected: visual layout matches `docs/superpowers/specs/2026-05-30-pc-admin-ui-design.md`.

## Self-Review

- Spec coverage: The plan covers the sidebar, operational workbench, log page, focused config sections, visual system, responsive behavior, existing data reuse, and testing.
- Placeholder scan: The plan contains concrete task instructions, exact file paths, code snippets, commands, and expected outcomes.
- Type consistency: `AdminView`, `Ticket`, `InboundMessageRecord`, `OutboundMessage`, `WechatOrderLog`, and `AppConfig` names match existing source types. Helper names are introduced before use.
