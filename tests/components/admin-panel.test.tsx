import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as XLSX from "xlsx";
import { AdminConfigCenter } from "@/components/admin-panel";
import type { AiPromptTemplate, ChatIdentity, Conversation, OutboundMessage, PendingWorkOrderSession, Person, InboundMessageRecord, Ticket } from "@/lib/domain/types";
import type { AppConfig } from "@/lib/seed";

const config: AppConfig = {
  issueTypes: [
    { id: "auto", name: "自动", urgencyMinutes: 0, priorityWeight: 0, enabled: true },
    { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "搭建组", enabled: true }
  ],
  aiModels: [
    { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  messageIntegrations: [
    { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: false, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false },
    { id: "wecom", channel: "wecom", label: "企业微信 MCP", enabled: true, mcpServerName: "wecom-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECOM_MCP_SECRET", autoCreateTickets: false }
  ],
  userGroups: [
    { id: "business", name: "业务组", description: "业务人员验收", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "organizer", name: "主场组", description: "主场运营验收", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "搭建组", description: "认领并处理现场搭建问题", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
  ],
  assignmentRules: []
};

const customClassifyPrompt: AiPromptTemplate = {
  id: "custom-classify-site",
  scenario: "classify",
  name: "现场分类自定义",
  description: "复制后编辑的分类提示词",
  systemPrompt: "你是主场客服AI，只返回JSON。",
  builtIn: false,
  enabled: true,
  updatedAt: "2026-06-04T08:00:00.000Z"
};

const configWithCustomPrompt: AppConfig = {
  ...config,
  aiPromptTemplates: [customClassifyPrompt],
  aiPromptDefaults: {
    classify: "builtin-classify-standard",
    dedupe: "builtin-dedupe-standard",
    escalation: "builtin-escalation-standard"
  }
};

const configWithSavedAiKey: AppConfig = {
  ...config,
  aiModels: config.aiModels.map((model) => model.id === "fast" ? {
    ...model,
    provider: "http",
    endpoint: "https://api.openai.example/v1/chat/completions",
    modelName: "gpt-fast",
    apiKeyConfigured: true
  } : model)
};

const MASKED_API_KEY = "••••••••";

const configWithDefaultCustomPrompt: AppConfig = {
  ...configWithCustomPrompt,
  aiPromptDefaults: {
    ...configWithCustomPrompt.aiPromptDefaults,
    classify: "custom-classify-site"
  }
};

const ticketAssignedToBuilder: Ticket = {
  id: "ticket-1",
  title: "A01 星河科技 搭建",
  boothNumber: "A01",
  companyName: "上海星河科技有限公司",
  companyShortName: "星河科技",
  description: "展位背板需要处理",
  imageUrls: [],
  issueType: "搭建",
  submitterId: "member-13800138000",
  submitterName: "张三",
  submitterPhone: "13800138000",
  feedbackUsers: [],
  status: "待受理",
  assignmentGroup: "搭建组",
  urgeCount: 0,
  urgeLevel: 0,
  priorityScore: 20,
  aiDecisions: [],
  replies: [],
  timeline: [],
  createdAt: "2026-05-22T08:00:00.000Z",
  updatedAt: "2026-05-22T08:00:00.000Z"
};

const issueDeletionConfig: AppConfig = {
  ...config,
  issueTypes: [
    { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "搭建组", enabled: true },
    { id: "power", name: "电力", urgencyMinutes: 15, priorityWeight: 30, assignmentGroup: "搭建组", enabled: true }
  ],
  assignmentRules: [
    { id: "power-a", boothPattern: "A", issueType: "电力", handlerId: "h-power", handlerName: "电力值班", groupName: "搭建组" },
    { id: "network-a", boothPattern: "A", issueType: "网络", handlerId: "h-network", handlerName: "网络值班", groupName: "搭建组" }
  ]
};

const configWithStaleIssueGroup: AppConfig = {
  ...config,
  issueTypes: [
    { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true }
  ],
  userGroups: [
    { id: "business", name: "业务组", description: "业务人员验收", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "organizer", name: "主场组", description: "主场运营验收", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "搭建", description: "认领并处理现场搭建问题", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
  ]
};

const ticketWithNetworkIssue: Ticket = {
  ...ticketAssignedToBuilder,
  id: "ticket-network",
  title: "A01 星河科技 网络",
  issueType: "网络"
};

const messageRecord: InboundMessageRecord = {
  id: "message-1",
  channel: "wecom",
  externalMessageId: "wx-msg-1",
  senderName: "业务王宁",
  senderPhone: "13700137000",
  text: "A01 展位网络断了，客户扫码失败",
  imageUrls: [],
  receivedAt: "2026-05-22T08:20:00.000Z",
  createdAt: "2026-05-22T08:20:01.000Z",
  analysis: {
    boothNumber: "A01",
    issueType: "网络",
    confidence: 0.8,
    suggestedAction: "create-ticket",
    reason: "识别到展位号和问题类型，可形成新工单"
  }
};

const person: Person = {
  id: "person-1",
  name: "张三",
  phone: "13800138000",
  role: "handler",
  groupName: "搭建组",
  nameConflict: { attemptedName: "张三微信", observedAt: "2026-05-22T08:21:00.000Z" },
  enabled: true,
  createdAt: "2026-05-22T08:20:00.000Z",
  updatedAt: "2026-05-22T08:21:00.000Z"
};

const chatIdentity: ChatIdentity = {
  id: "chat-1",
  platform: "wechat",
  externalUserId: "wxid-zhangsan",
  displayName: "张三微信",
  personId: "person-1",
  verifiedBy: "phone",
  verifiedAt: "2026-05-22T08:21:00.000Z",
  firstSeenAt: "2026-05-22T08:20:00.000Z",
  lastSeenAt: "2026-05-22T08:21:00.000Z"
};

const pendingSession: PendingWorkOrderSession = {
  id: "pending-1",
  platform: "wechat",
  conversationId: "conversation-1",
  chatIdentityId: "chat-1",
  draftText: "这里没电了，麻烦处理",
  draftImages: [],
  missingFields: ["boothNumber"],
  createdAt: "2026-05-22T08:21:00.000Z",
  updatedAt: "2026-05-22T08:22:00.000Z"
};

const conversation: Conversation = {
  id: "conversation-1",
  platform: "wechat",
  type: "group",
  externalConversationId: "现场群",
  title: "现场保障群",
  linkedPersonIds: ["person-1"],
  defaultNotify: true,
  createdAt: "2026-05-22T08:20:00.000Z",
  updatedAt: "2026-05-22T08:22:00.000Z"
};

const outboundMessage: OutboundMessage = {
  id: "outbound-1",
  channel: "wechat",
  targetConversationId: "conv-site",
  targetChatIdentityId: "chat-1",
  targetName: "现场群",
  text: "工单已解决：A01 星河科技 搭建",
  relatedTicketId: "ticket-1",
  status: "failed",
  retryCount: 1,
  lastError: "窗口不存在",
  createdAt: "2026-05-22T08:23:00.000Z",
  updatedAt: "2026-05-22T08:24:00.000Z"
};

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

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminConfigCenter user groups", () => {
  it("renders work-order settings as table-style configuration panels", () => {
    render(<AdminConfigCenter config={config} view="work-order-settings" onRefresh={vi.fn()} />);

    const editor = screen.getByRole("region", { name: "工单设置配置台" });
    const groupPanel = within(editor).getByRole("region", { name: "用户分组" });
    const issuePanel = within(editor).getByRole("region", { name: "问题类型" });
    const groupTable = within(groupPanel).getByRole("table", { name: "用户分组配置表" });
    const issueTable = within(issuePanel).getByRole("table", { name: "问题类型配置表" });

    expect(editor.className).toContain("work-order-settings-grid");
    expect(groupPanel.querySelectorAll(".compact-config-row")).toHaveLength(4);
    expect(issuePanel.querySelectorAll(".compact-config-row")).toHaveLength(2);
    expect(groupTable.className).toContain("settings-config-table");
    expect(issueTable.className).toContain("settings-config-table");
    ["分组信息", "权限", "状态", "操作"].forEach((header) => {
      expect(within(groupTable).getByRole("columnheader", { name: header })).not.toBeNull();
    });
    ["问题类型", "规则", "处理组", "状态", "操作"].forEach((header) => {
      expect(within(issueTable).getByRole("columnheader", { name: header })).not.toBeNull();
    });
    expect(within(groupTable).queryByRole("columnheader", { name: "名称" })).toBeNull();
    expect(within(groupTable).queryByRole("columnheader", { name: "说明" })).toBeNull();
    expect(within(issueTable).queryByRole("columnheader", { name: "催单" })).toBeNull();
    expect(within(issueTable).queryByRole("columnheader", { name: "权重" })).toBeNull();
    expect(groupTable.querySelectorAll(".settings-info-cell")).toHaveLength(4);
    expect(issueTable.querySelectorAll(".settings-rule-cell")).toHaveLength(2);
    expect(within(groupPanel).queryByText("分组配置")).toBeNull();
    expect(within(groupPanel).getByRole("button", { name: "保存用户分组配置" })).not.toBeNull();
    expect(within(issuePanel).getByRole("button", { name: "保存问题类型配置" })).not.toBeNull();
  });

  it("saves user groups as one editable list and disables instead of deleting rows", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    expect(screen.getAllByText("用户分组").length).toBeGreaterThan(0);
    expect(screen.getByText("业务组")).not.toBeNull();
    expect(screen.getByText("主场组")).not.toBeNull();
    expect(screen.getByText("搭建组")).not.toBeNull();

    await user.clear(screen.getByLabelText("业务组名称"));
    await user.type(screen.getByLabelText("业务组名称"), "业务团队");
    await user.click(screen.getByLabelText("业务组可认领"));
    await user.click(screen.getByLabelText("业务组可管理后台"));
    await user.click(screen.getByLabelText("搭建组启用"));
    await user.type(screen.getByLabelText("新增分组名称"), "客服组");
    await user.type(screen.getByLabelText("新增分组说明"), "负责现场答疑和回访");
    await user.click(screen.getByLabelText("新增分组可验收"));
    await user.click(screen.getByLabelText("新增分组可管理后台"));
    await user.click(screen.getByRole("button", { name: "保存用户分组配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ id: "business", name: "业务团队", canClaim: true, canAdmin: true, enabled: true }));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ id: "builder", name: "搭建组", enabled: false }));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ name: "客服组", description: "负责现场答疑和回访", canAccept: true, canAdmin: true, enabled: true }));
    await waitFor(() => expect((screen.getByLabelText("新增分组名称") as HTMLInputElement).value).toBe(""));
  });

  it("deletes groups with no tickets and keeps used groups disable-only", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} tickets={[ticketAssignedToBuilder]} onRefresh={vi.fn()} />);

    expect(screen.getByRole("button", { name: "删除业务组" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "删除搭建组" })).toBeNull();
    expect(screen.getAllByRole("note", { name: "已有工单，仅可停用" }).at(0)?.className).toContain("compact-status-chip");

    await user.click(screen.getByRole("button", { name: "删除业务组" }));
    expect(screen.getByRole("note", { name: "待删除，保存后生效" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "撤销删除业务组" })).not.toBeNull();
    expect(document.querySelector(".form-message")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存用户分组配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.userGroups).not.toContainEqual(expect.objectContaining({ id: "business" }));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ id: "builder", name: "搭建组" }));
  });

  it("saves issue types as one list, excludes automatic option and uses configured group choices", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    expect(screen.queryByLabelText("自动名称")).toBeNull();
    expect(screen.getByRole("option", { name: "业务组" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "主场组" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "搭建组" })).not.toBeNull();

    await user.clear(screen.getByLabelText("网络催单分钟"));
    await user.type(screen.getByLabelText("网络催单分钟"), "25");
    await user.selectOptions(screen.getByLabelText("网络默认处理组"), "业务组");
    await user.type(screen.getByLabelText("新增问题类型名称"), "报馆");
    await user.clear(screen.getByLabelText("新增问题类型催单分钟"));
    await user.type(screen.getByLabelText("新增问题类型催单分钟"), "35");
    await user.clear(screen.getByLabelText("新增问题类型优先权重"));
    await user.type(screen.getByLabelText("新增问题类型优先权重"), "12");
    await user.selectOptions(screen.getByLabelText("新增问题类型默认处理组"), "主场组");
    await user.click(screen.getByRole("button", { name: "保存问题类型配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const statusToast = await screen.findByRole("status");
    expect(statusToast.className).toContain("admin-feedback-toast");
    expect(statusToast.className).not.toContain("form-message");
    expect(statusToast.textContent).toBe("问题类型配置已保存");

    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.issueTypes).not.toContainEqual(expect.objectContaining({ name: "自动" }));
    expect(body.issueTypes).toContainEqual(expect.objectContaining({ id: "network", urgencyMinutes: 25, assignmentGroup: "业务组" }));
    expect(body.issueTypes).toContainEqual(expect.objectContaining({ name: "报馆", urgencyMinutes: 35, priorityWeight: 12, assignmentGroup: "主场组", enabled: true }));
    await waitFor(() => expect((screen.getByLabelText("新增问题类型名称") as HTMLInputElement).value).toBe(""));
  });

  it("uses real default values for new issue urgency and priority", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    expect((screen.getByLabelText("新增问题类型催单分钟") as HTMLInputElement).value).toBe("30");
    expect((screen.getByLabelText("新增问题类型优先权重") as HTMLInputElement).value).toBe("10");

    await user.type(screen.getByLabelText("新增问题类型名称"), "保洁");
    await user.click(screen.getByRole("button", { name: "保存问题类型配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.issueTypes).toContainEqual(expect.objectContaining({
      name: "保洁",
      urgencyMinutes: 30,
      priorityWeight: 10,
      enabled: true
    }));
  });

  it("shows validation feedback as a floating admin toast instead of occupying the settings layout", async () => {
    const user = userEvent.setup();
    render(<AdminConfigCenter config={config} view="work-order-settings" onRefresh={vi.fn()} />);

    await user.clear(screen.getByLabelText("网络名称"));
    await user.click(screen.getByRole("button", { name: "保存问题类型配置" }));

    const statusToast = await screen.findByRole("status");
    expect(statusToast.className).toContain("admin-feedback-toast");
    expect(statusToast.className).not.toContain("form-message");
    expect(statusToast.textContent).toBe("请检查问题类型名称、催单时间和优先权重");
  });

  it("queues feedback toasts", () => {
    render(<AdminConfigCenter config={config} view="work-order-settings" onRefresh={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("网络名称"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存问题类型配置" }));
    fireEvent.change(screen.getByLabelText("业务组名称"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存用户分组配置" }));

    expect(screen.getByRole("region", { name: "操作提示" }).className).toContain("admin-feedback-stack");
    expect(screen.getAllByRole("status").map((toast) => toast.textContent)).toEqual([
      "请检查问题类型名称、催单时间和优先权重",
      "请填写所有已配置分组的名称"
    ]);
  });

  it("removes queued feedback toasts in order", async () => {
    render(<AdminConfigCenter config={config} view="work-order-settings" onRefresh={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("网络名称"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存问题类型配置" }));
    fireEvent.change(screen.getByLabelText("业务组名称"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存用户分组配置" }));

    await waitFor(() => {
      expect(screen.getAllByRole("status").map((toast) => toast.textContent)).toEqual([
        "请填写所有已配置分组的名称"
      ]);
    }, { timeout: 1800 });

    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    }, { timeout: 1800 });
  });

  it("syncs issue default group options with all actual user group edits before saving", async () => {
    const user = userEvent.setup();
    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    const networkGroupSelect = screen.getByLabelText("网络默认处理组") as HTMLSelectElement;
    const optionTexts = () => Array.from(networkGroupSelect.options).map((option) => option.textContent);

    await user.clear(screen.getByLabelText("业务组名称"));
    await user.type(screen.getByLabelText("业务组名称"), "业务团队");
    await user.click(screen.getByLabelText("主场组启用"));
    await user.type(screen.getByLabelText("新增分组名称"), "客服组");

    expect(optionTexts()).toContain("业务团队");
    expect(optionTexts()).toContain("客服组");
    expect(optionTexts()).toContain("主场组");
    expect(optionTexts()).not.toContain("业务组");
  });

  it("does not include stale issue assignment groups that are not actual user groups", () => {
    render(<AdminConfigCenter config={configWithStaleIssueGroup} onRefresh={vi.fn()} />);

    const networkGroupSelect = screen.getByLabelText("网络默认处理组") as HTMLSelectElement;
    const optionTexts = Array.from(networkGroupSelect.options).map((option) => option.textContent);

    expect(optionTexts).toEqual(["未指定", "业务组", "主场组", "搭建"]);
    expect(optionTexts).not.toContain("网络组");
  });

  it("deletes issue types with no tickets and keeps used issue types disable-only", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config: issueDeletionConfig }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={issueDeletionConfig} tickets={[ticketWithNetworkIssue]} onRefresh={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "删除网络" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除电力" })).not.toBeNull();
    expect(screen.getAllByRole("note", { name: "已有工单，仅可停用" }).at(0)?.className).toContain("compact-status-chip");

    await user.click(screen.getByRole("button", { name: "删除电力" }));
    expect(screen.getByLabelText("电力名称")).not.toBeNull();
    expect(screen.getByRole("note", { name: "待删除，保存后生效" })).not.toBeNull();
    expect(document.querySelector(".form-message")).toBeNull();
    await user.click(screen.getByRole("button", { name: "撤销删除电力" }));
    expect(screen.queryByRole("note", { name: "待删除，保存后生效" })).toBeNull();
    expect(document.querySelector(".form-message")).toBeNull();
    await user.click(screen.getByRole("button", { name: "删除电力" }));
    await user.click(screen.getByRole("button", { name: "保存问题类型配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.issueTypes).toContainEqual(expect.objectContaining({ id: "network", name: "网络" }));
    expect(body.issueTypes).not.toContainEqual(expect.objectContaining({ id: "power" }));
    expect(body.assignmentRules).not.toContainEqual(expect.objectContaining({ issueType: "电力" }));
  });

  it("edits ai http settings", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/ai-models") {
        return new Response(JSON.stringify({ models: ["gpt-fast", "gpt-smart"] }), { status: 200 });
      }
      return new Response(JSON.stringify({ config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("快速智能模型供应商"), "http");
    await user.clear(screen.getByLabelText("快速智能模型接口地址"));
    await user.type(screen.getByLabelText("快速智能模型接口地址"), "https://api.openai.example/v1/chat/completions");
    await user.type(screen.getByLabelText("快速智能模型接口密钥"), "sk-test-fast");
    await user.click(screen.getByRole("button", { name: "获取快速智能模型列表" }));
    await screen.findByRole("option", { name: "gpt-fast" });
    await user.selectOptions(screen.getByLabelText("快速智能模型名称"), "gpt-fast");
    await user.click(screen.getByRole("button", { name: "保存快速智能模型" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" })));
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/ai-models", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://api.openai.example/v1/chat/completions",
        apiKey: "sk-test-fast"
      })
    }));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    const fastAiModel = body.aiModels.find((model: { id: string }) => model.id === "fast");
    expect(fastAiModel).toEqual(expect.objectContaining({
      id: "fast",
      provider: "http",
      endpoint: "https://api.openai.example/v1/chat/completions",
      modelName: "gpt-fast",
      apiKey: "sk-test-fast"
    }));
    expect(fastAiModel.apiKeyEnv).toBeUndefined();
  });

  it("uses a saved ai api key marker to fetch models after refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin/ai-models") {
        return new Response(JSON.stringify({ models: ["gpt-smart", "gpt-fast"] }), { status: 200 });
      }
      return new Response(JSON.stringify({ config: configWithSavedAiKey }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={configWithSavedAiKey} view="system" onRefresh={vi.fn()} />);

    expect(screen.queryByText("已配置接口密钥，留空保存不变。")).toBeNull();
    expect(screen.queryByText("保存后接口密钥不会在页面回显。")).toBeNull();
    expect((screen.getByLabelText("快速智能模型接口密钥") as HTMLInputElement).value).toBe(MASKED_API_KEY);
    expect((screen.getByLabelText("快速智能模型名称") as HTMLSelectElement).value).toBe("gpt-fast");
    await user.click(screen.getByRole("button", { name: "获取快速智能模型列表" }));
    await screen.findByRole("option", { name: "gpt-smart" });
    expect((screen.getByLabelText("快速智能模型名称") as HTMLSelectElement).value).toBe("gpt-fast");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/ai-models", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://api.openai.example/v1/chat/completions",
        modelId: "fast"
      })
    }));

    await user.click(screen.getByRole("button", { name: "保存快速智能模型" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    const fastAiModel = body.aiModels.find((model: { id: string }) => model.id === "fast");
    expect(fastAiModel.apiKey).toBeUndefined();
    expect(fastAiModel.apiKeyConfigured).toBeUndefined();
  });

  it("fills common ai provider settings automatically when a preset is selected", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "应用快速智能模型供应商推荐值" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("快速智能模型供应商预设"), "deepseek");

    expect((screen.getByLabelText("快速智能模型供应商") as HTMLSelectElement).value).toBe("http");
    expect((screen.getByLabelText("快速智能模型接口地址") as HTMLInputElement).value).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((screen.getByLabelText("快速智能模型名称") as HTMLSelectElement).value).toBe("deepseek-chat");
    expect(screen.getByRole("button", { name: "获取快速智能模型列表" })).not.toBeNull();
    expect((screen.getByLabelText("快速智能模型接口密钥") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("快速智能模型接口密钥") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("快速智能模型超时毫秒") as HTMLInputElement).value).toBe("8000");

    await user.click(screen.getByRole("button", { name: "保存快速智能模型" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.aiModels).toContainEqual(expect.objectContaining({
      id: "fast",
      providerPreset: "deepseek",
      provider: "http",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      modelName: "deepseek-chat",
      timeoutMs: 8000
    }));
  });

  it("renders ai prompt scenarios and copies a built-in prompt before editing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "智能调用预设" })).not.toBeNull();
    expect(screen.getByText("识别顺序：自定义关键词优先判断是否处理和问题类型；未命中问题类型时才调用智能分类。创建工单时，智能模型仍会参与相似工单判重。智能提示词只影响实际调用智能模型的场景，不会覆盖已命中的关键词规则。")).not.toBeNull();
    expect(screen.getByText("工单分类")).not.toBeNull();
    expect(screen.getByText("相似工单判重")).not.toBeNull();
    expect(screen.getByText("超时研判")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "复制标准分类" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    const copied = body.aiPromptTemplates.find((template: AiPromptTemplate) => template.scenario === "classify" && !template.builtIn);
    expect(copied).toMatchObject({
      scenario: "classify",
      name: "标准分类 - 自定义",
      builtIn: false,
      enabled: true
    });
    expect(body.aiPromptDefaults.classify).toBe(copied.id);
  });

  it("edits a copied prompt template and makes it the default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config: configWithCustomPrompt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={configWithCustomPrompt} view="system" onRefresh={vi.fn()} />);

    await user.clear(screen.getByLabelText("现场分类自定义模板名称"));
    await user.type(screen.getByLabelText("现场分类自定义模板名称"), "现场分类提示词");
    await user.clear(screen.getByLabelText("现场分类自定义系统提示词"));
    await user.type(screen.getByLabelText("现场分类自定义系统提示词"), "只允许返回系统内问题类型JSON。");
    await user.click(screen.getByRole("button", { name: "保存并设为现场分类自定义默认模板" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.aiPromptTemplates).toContainEqual(expect.objectContaining({
      id: "custom-classify-site",
      scenario: "classify",
      name: "现场分类提示词",
      systemPrompt: "只允许返回系统内问题类型JSON。",
      builtIn: false,
      enabled: true
    }));
    expect(body.aiPromptDefaults.classify).toBe("custom-classify-site");
  });

  it("deletes a copied prompt template and restores the built-in default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config: configWithDefaultCustomPrompt }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={configWithDefaultCustomPrompt} view="system" onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "删除现场分类自定义模板" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.aiPromptTemplates).not.toContainEqual(expect.objectContaining({ id: "custom-classify-site" }));
    expect(body.aiPromptDefaults.classify).toBe("builtin-classify-standard");
  });

  it("configures the embedded wxauto MCP service without legacy server fields", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/wxauto-mcp" && init?.method === "PUT") {
        return new Response(JSON.stringify({
          wxautoMcp: {
            enabled: true,
            endpoint: "/api/mcp",
            accessToken: "manual-token",
            tokenPreview: "manual...oken",
            autoCreateTickets: true
          }
        }), { status: 200 });
      }
      if (url === "/api/admin/wxauto-mcp") {
        return new Response(JSON.stringify({
          wxautoMcp: {
            enabled: false,
            endpoint: "/api/mcp",
            accessToken: "generated-token",
            tokenPreview: "generat...oken",
            autoCreateTickets: false
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "wxauto 桌面服务" })).not.toBeNull();
    expect(screen.queryByLabelText("微信 MCP服务名称")).toBeNull();
    expect(screen.queryByLabelText("微信 MCP密钥环境变量")).toBeNull();
    expect((screen.getByLabelText("MCP 服务地址") as HTMLInputElement).value).toBe("/api/mcp");

    await user.click(screen.getByLabelText("启用 wxauto 桌面服务"));
    await user.click(screen.getByLabelText("自动建单"));
    await user.clear(screen.getByLabelText("wxauto访问令牌"));
    await user.type(screen.getByLabelText("wxauto访问令牌"), "manual-token");
    await user.click(screen.getByRole("button", { name: "保存 wxauto 设置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wxauto-mcp", expect.objectContaining({ method: "PUT" })));
    const putCall = fetchMock.mock.calls.find((call) => call[0] === "/api/admin/wxauto-mcp" && call[1]?.method === "PUT");
    const body = JSON.parse(String(putCall?.[1]?.body));
    expect(body).toMatchObject({
      enabled: true,
      autoCreateTickets: true,
      accessToken: "manual-token"
    });
  });

  it("rotates the wxauto access token from the system page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/wxauto-mcp" && init?.method === "PUT") {
        return new Response(JSON.stringify({
          wxautoMcp: {
            enabled: true,
            endpoint: "/api/mcp",
            accessToken: "new-token",
            tokenPreview: "new...oken",
            autoCreateTickets: false
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        wxautoMcp: {
          enabled: true,
          endpoint: "/api/mcp",
          accessToken: "old-token",
          tokenPreview: "old...oken",
          autoCreateTickets: false
        }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

    await screen.findByRole("heading", { name: "wxauto 桌面服务" });
    await user.click(screen.getByRole("button", { name: "重置访问令牌" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wxauto-mcp", expect.objectContaining({ method: "PUT" })));
    const putCall = fetchMock.mock.calls.find((call) => call[0] === "/api/admin/wxauto-mcp" && call[1]?.method === "PUT");
    expect(JSON.parse(String(putCall?.[1]?.body))).toEqual({ rotateToken: true });
  });

  it("edits auto acceptance settings on the system page", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={{ ...config, autoAcceptance: { enabled: true, timeoutMinutes: 30 } }} view="system" onRefresh={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "自动验收" })).not.toBeNull();
    await user.click(screen.getByLabelText("启用自动验收"));
    await user.clear(screen.getByLabelText("处理完成后自动验收时效（分钟）"));
    await user.type(screen.getByLabelText("处理完成后自动验收时效（分钟）"), "45");
    await user.click(screen.getByRole("button", { name: "保存自动验收配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.autoAcceptance).toEqual({ enabled: false, timeoutMinutes: 45 });
  });

  it("blocks invalid auto acceptance timeout minutes before saving", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={{ ...config, autoAcceptance: { enabled: true, timeoutMinutes: 30 } }} view="system" onRefresh={vi.fn()} />);

    await user.clear(screen.getByLabelText("处理完成后自动验收时效（分钟）"));
    await user.type(screen.getByLabelText("处理完成后自动验收时效（分钟）"), "0");
    await user.click(screen.getByRole("button", { name: "保存自动验收配置" }));

    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" }));
    expect(screen.getByText("自动验收时效需为 1 至 10080 分钟的整数")).not.toBeNull();
  });

  it("edits one keyword rule set as comma-separated terms", async () => {
    const keywordConfig: AppConfig = {
      ...config,
      keywordGroups: [
        {
          id: "site-intent",
          name: "现场诉求",
          description: "同规则关键词集合",
          enabled: true,
          ruleSets: [
            {
              id: "site-intent-report",
              matchType: "contains",
              action: "operational-intent",
              priority: 50,
              enabled: true,
              terms: [
                { id: "term-repair", value: "报修", enabled: true, sortOrder: 1 },
                { id: "term-broken", value: "故障", enabled: true, sortOrder: 2 }
              ]
            }
          ]
        }
      ]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ keywordGroups: keywordConfig.keywordGroups }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminConfigCenter config={keywordConfig} view="system" onRefresh={vi.fn()} />);

    expect(screen.queryByLabelText("现场诉求名称")).toBeNull();
    expect(screen.queryByLabelText("现场诉求说明")).toBeNull();
    expect(screen.getByText("现场诉求")).not.toBeNull();
    const keywords = screen.getByLabelText("现场诉求关键词") as HTMLTextAreaElement;
    expect(keywords.value).toBe("报修，故障");

    await user.clear(keywords);
    await user.type(keywords, "报修，故障，坏了");
    await user.click(screen.getByRole("button", { name: "保存关键词配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/keywords", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.keywordGroups[0].name).toBe("现场诉求");
    expect(body.keywordGroups[0].description).toBe("同规则关键词集合");
    expect(body.keywordGroups[0].ruleSets[0]).toEqual(expect.objectContaining({
      id: "site-intent-report",
      matchType: "contains",
      action: "operational-intent",
      priority: 50,
      enabled: true
    }));
    expect(body.keywordGroups[0].ruleSets[0].terms).toEqual([
      expect.objectContaining({ id: "term-repair", value: "报修", enabled: true, sortOrder: 1 }),
      expect.objectContaining({ id: "term-broken", value: "故障", enabled: true, sortOrder: 2 }),
      expect.objectContaining({ value: "坏了", enabled: true, sortOrder: 3 })
    ]);
    expect(body.keywordGroups[0].rules).toBeUndefined();
  });

  it("renders the PC workbench with operational metrics, exception queue and quick config links", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="workbench"
        tickets={[ticketAssignedToBuilder, resolvedTicket]}
        messageRecords={[messageRecord, reviewMessageRecord]}
        outboundMessages={[outboundMessage]}
        wechatOrderLogs={[processedWechatLog]}
        people={[person]}
        chatIdentities={[chatIdentity]}
        conversations={[conversation]}
        pendingWorkOrderSessions={[pendingSession]}
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

    expect(screen.getByRole("heading", { level: 1, name: "后台工作台" })).not.toBeNull();
    expect(screen.getByText("未关闭工单")).not.toBeNull();
    expect(screen.getByText("待处理工单")).not.toBeNull();
    expect(screen.getByText("失败通知")).not.toBeNull();
    expect(screen.getByText("自动建单率")).not.toBeNull();
    expect(screen.getByText("待处理与异常队列")).not.toBeNull();
    expect(screen.getByText("A01 星河科技 搭建")).not.toBeNull();
    expect(screen.getByText("通知失败")).not.toBeNull();
    expect(screen.getByText("微信下单动态")).not.toBeNull();
    expect(screen.getByText("A01 展位网络问题已自动建单")).not.toBeNull();
    expect(screen.getByText("消息身份联通")).not.toBeNull();
    expect(screen.getByText("人员 1")).not.toBeNull();
    expect(screen.getByText("身份 1")).not.toBeNull();
    expect(screen.getByText("会话 1")).not.toBeNull();
    expect(screen.getByText("待补全 1")).not.toBeNull();
    expect(screen.getByText("这里没电了，麻烦处理")).not.toBeNull();
    expect(screen.getByRole("link", { name: "用户分组" }).getAttribute("href")).toBe("/admin/work-order-settings#admin-groups");
    expect(screen.getByRole("link", { name: "关键词规则" }).getAttribute("href")).toBe("/admin/system#admin-keywords");
  });

  it("marks the active admin sidebar item and exposes all primary admin modules", () => {
    render(<AdminConfigCenter config={config} view="system" onRefresh={vi.fn()} />);

    expect(screen.getByRole("navigation", { name: "后台主导航" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "后台工作台" }).getAttribute("href")).toBe("/admin");
    expect(screen.getByRole("link", { name: "微信下单日志" }).getAttribute("href")).toBe("/admin/logs");
    expect(screen.getByRole("link", { name: "工单设置" }).getAttribute("href")).toBe("/admin/work-order-settings");
    expect(screen.getByRole("link", { name: "展览数据" }).getAttribute("href")).toBe("/admin/exhibition-data");
    expect(screen.getByRole("link", { name: "系统配置" }).getAttribute("aria-current")).toBe("page");
  });

  it("imports exhibition data from an uploaded workbook file", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);

    const worksheet = XLSX.utils.json_to_sheet([{ boothNumber: "A09", companyName: "测试公司" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "booths.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "A01",
          companyName: "上海星河科技有限公司",
          companyShortName: "星河科技",
          salesOwner: "王宁",
          builder: "搭建组"
        }]}
        onRefresh={onRefresh}
      />
    );

    expect(screen.getByRole("heading", { name: "展商数据看板" })).not.toBeNull();
    expect(screen.getByText("系统展商")).not.toBeNull();
    expect(within(screen.getByRole("table", { name: "展商数据表格" })).getByText("上海星河科技有限公司")).not.toBeNull();

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/master-data", expect.objectContaining({ method: "POST" })));
    const requestInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(requestInit.headers).toBeUndefined();
    const body = requestInit.body as FormData;
    expect(typeof body.get).toBe("function");
    const uploadedFile = body.get("file") as File;
    expect(uploadedFile.name).toBe("booths.xlsx");
    expect(uploadedFile.size).toBeGreaterThan(0);
    expect(body.get("dryRun")).toBe("false");
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("shows imported booth records from the import response before parent refresh completes", async () => {
    const importedBooth = {
      boothNumber: "A09",
      companyName: "测试公司",
      companyShortName: "测试公司",
      salesOwner: "赵测试",
      builder: "李铁：13607664172",
      location: "1A",
      area: "9",
      boothType: "精标"
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, booths: [importedBooth] }), { status: 200 }));
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);

    const worksheet = XLSX.utils.json_to_sheet([{ boothNumber: "A09", companyName: "测试公司" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "booths.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
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

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await waitFor(() => expect(within(table).getByRole("button", { name: "查看测试公司" })).not.toBeNull());
    expect(within(table).getByText("A09")).not.toBeNull();
    expect(within(table).getByText("赵测试")).not.toBeNull();
    expect(within(table).queryByText("上海星河科技有限公司")).toBeNull();
  });

  it("keeps imported booth records visible when parent refresh first returns stale booth props", async () => {
    const importedBooth = {
      boothNumber: "A09",
      companyName: "测试公司",
      companyShortName: "测试公司",
      salesOwner: "赵测试",
      builder: "李铁：13607664172",
      location: "1A",
      area: "9",
      boothType: "精标"
    };
    const staleBooth = {
      boothNumber: "A01",
      companyName: "上海星河科技有限公司",
      companyShortName: "星河科技",
      salesOwner: "王宁",
      builder: "搭建组"
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, booths: [importedBooth] }), { status: 200 }));
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);

    const worksheet = XLSX.utils.json_to_sheet([{ boothNumber: "A09", companyName: "测试公司" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "booths.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const { rerender } = render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[staleBooth]}
        onRefresh={vi.fn()}
      />
    );

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    const tableBeforeRefresh = screen.getByRole("table", { name: "展商数据表格" });
    await waitFor(() => expect(within(tableBeforeRefresh).getByRole("button", { name: "查看测试公司" })).not.toBeNull());
    rerender(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{ ...staleBooth }]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await waitFor(() => expect(within(table).getByRole("button", { name: "查看测试公司" })).not.toBeNull());
    expect(within(table).getByText("A09")).not.toBeNull();
    expect(within(table).queryByText("上海星河科技有限公司")).toBeNull();
  });

  it("accepts refreshed booth props once they match the import response", async () => {
    const importedBooth = {
      boothNumber: "A09",
      companyName: "测试公司",
      companyShortName: "测试公司",
      salesOwner: "赵测试",
      builder: "李铁：13607664172",
      location: "1A",
      area: "9",
      boothType: "精标"
    };
    const refreshedBooth = { ...importedBooth, salesOwner: "刷新销售" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, booths: [importedBooth] }), { status: 200 }));
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);

    const worksheet = XLSX.utils.json_to_sheet([{ boothNumber: "A09", companyName: "测试公司" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "booths.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    const { rerender } = render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[]}
        onRefresh={vi.fn()}
      />
    );

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);
    const tableBeforeRefresh = screen.getByRole("table", { name: "展商数据表格" });
    await waitFor(() => expect(within(tableBeforeRefresh).getByText("赵测试")).not.toBeNull());

    rerender(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[importedBooth]}
        onRefresh={vi.fn()}
      />
    );
    rerender(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[refreshedBooth]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    await waitFor(() => expect(within(table).getByText("刷新销售")).not.toBeNull());
    expect(within(table).queryByText("赵测试")).toBeNull();
  });

  it("renders the approved exhibitor dashboard shell for exhibition data", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1ET06",
            companyName: "汕头市昌隆机械科技有限公司",
            companyShortName: "昌隆机械",
            location: "一楼 / 1E",
            area: "36",
            boothType: "普通绿搭",
            salesOwner: "孙晓晓",
            builder: "李铁：13607664172"
          },
          {
            boothNumber: "1E05",
            companyName: "山东省聊城经济开发区齐龙精细化工厂",
            companyShortName: "齐龙精细化工厂",
            location: "1E",
            area: "9",
            boothType: "精标",
            salesOwner: "韩世军",
            builder: ""
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "展商数据看板" })).not.toBeNull();
    expect(screen.getByLabelText("当前展览项目")).not.toBeNull();
    ["系统展商", "已分配搭建成员", "待分配成员", "待确认导入差异"].forEach((metric) => {
      expect(screen.getByText(metric)).not.toBeNull();
    });
    expect(screen.getByPlaceholderText("搜索展位、展商、销售、搭建成员")).not.toBeNull();
    expect(screen.getByLabelText("按位置筛选")).not.toBeNull();
    expect(screen.getByLabelText("按类型筛选")).not.toBeNull();
    expect(screen.getByLabelText("按成员分配状态筛选")).not.toBeNull();
    expect(screen.getByRole("button", { name: "导入历史" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "处理导入差异" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "上传项目表格" })).not.toBeNull();
    expect(screen.getByLabelText("导入展位数据文件")).not.toBeNull();

    const table = screen.getByRole("table", { name: "展商数据表格" });
    ["展位号", "展商", "位置", "面积", "类型", "销售", "现场搭建成员", "操作"].forEach((header) => {
      expect(within(table).getByRole("columnheader", { name: header })).not.toBeNull();
    });
  });

  it("searches and filters the exhibitor dashboard", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1ET06",
            companyName: "汕头市昌隆机械科技有限公司",
            companyShortName: "昌隆机械",
            location: "一楼 / 1E",
            area: "36",
            boothType: "普通绿搭",
            salesOwner: "孙晓晓",
            builder: "李铁：13607664172"
          },
          {
            boothNumber: "2D02",
            companyName: "山西惠农生物有机肥有限公司",
            companyShortName: "惠农生物",
            location: "2D",
            area: "9",
            boothType: "普标",
            salesOwner: "潘金生",
            builder: ""
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    await user.type(screen.getByPlaceholderText("搜索展位、展商、销售、搭建成员"), "孙晓晓");

    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).getByText("汕头市昌隆机械科技有限公司")).not.toBeNull();
    expect(within(table).queryByText("山西惠农生物有机肥有限公司")).toBeNull();

    await user.clear(screen.getByPlaceholderText("搜索展位、展商、销售、搭建成员"));
    await user.selectOptions(screen.getByLabelText("按成员分配状态筛选"), "unassigned");

    expect(within(table).queryByText("汕头市昌隆机械科技有限公司")).toBeNull();
    expect(within(table).getByText("山西惠农生物有机肥有限公司")).not.toBeNull();
  });

  it("filters exhibitors by a specific onsite builder member", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1ET06",
            companyName: "汕头市昌隆机械科技有限公司",
            companyShortName: "昌隆机械",
            location: "一楼 / 1E",
            area: "36",
            boothType: "普通绿搭",
            salesOwner: "孙晓晓",
            builder: "李铁：13607664172"
          },
          {
            boothNumber: "1AT27",
            companyName: "郑州鼎来瑞农业科技有限公司",
            companyShortName: "鼎来瑞农业",
            location: "一楼 / 1A",
            area: "18",
            boothType: "普通绿搭",
            salesOwner: "马永波",
            builder: "崔晓安：13803812794"
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    await user.selectOptions(screen.getByLabelText("按现场搭建成员筛选"), "崔晓安");

    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).queryByText("汕头市昌隆机械科技有限公司")).toBeNull();
    expect(within(table).getByText("郑州鼎来瑞农业科技有限公司")).not.toBeNull();
  });

  it("renders responsive exhibitor cards with the same key actions for narrow screens", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 / 1E",
          area: "36",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    const cards = screen.getByRole("list", { name: "展商数据卡片列表" });
    const card = within(cards).getByRole("listitem", { name: "汕头市昌隆机械科技有限公司 1ET06" });
    expect(within(card).getByText("一楼 / 1E")).not.toBeNull();
    expect(within(card).getByText("36㎡")).not.toBeNull();
    expect(within(card).getByText("孙晓晓")).not.toBeNull();
    expect(within(card).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" })).not.toBeNull();
    expect(within(card).getByRole("button", { name: "添加汕头市昌隆机械科技有限公司搭建成员" })).not.toBeNull();
  });

  it("shows bulk actions and opens the exhibitor detail drawer", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 / 1E",
          area: "36",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });

    await user.click(within(table).getByLabelText("选择汕头市昌隆机械科技有限公司"));
    expect(screen.getByText("已选择 1 个展商")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批量分配搭建成员" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "批量修改类型" })).not.toBeNull();

    await user.click(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" }));
    const drawer = screen.getByRole("complementary", { name: "展商详情" });
    expect(within(drawer).getByRole("heading", { name: "汕头市昌隆机械科技有限公司" })).not.toBeNull();
    expect(within(drawer).getByText("展位 1ET06")).not.toBeNull();
    expect(within(drawer).getByText("展商基础数据")).not.toBeNull();
    expect(within(drawer).getByText("现场搭建成员")).not.toBeNull();
    expect(within(drawer).getByText("李铁")).not.toBeNull();

    await user.click(within(drawer).getByRole("button", { name: "关闭详情" }));
    expect(screen.queryByRole("complementary", { name: "展商详情" })).toBeNull();
  });

  it("opens import history and import-diff review panels from the dashboard toolbar", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 / 1E",
          area: "",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "导入历史" }));
    const historyPanel = screen.getByRole("region", { name: "导入历史面板" });
    expect(within(historyPanel).getByText("最近导入记录")).not.toBeNull();
    expect(within(historyPanel).getByText("第23届中原农资双交会后勤表.xlsx")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "处理导入差异" }));
    const diffDialog = screen.getByRole("dialog", { name: "导入差异数值确认" });
    expect(within(diffDialog).getByText("导入差异数值确认")).not.toBeNull();
    expect(within(diffDialog).getByText("这些记录缺少看板必需字段，先在这里补齐；点击应用后只更新当前看板字段。")).not.toBeNull();
    expect(within(diffDialog).getByText("汕头市昌隆机械科技有限公司")).not.toBeNull();
    expect(within(diffDialog).getByText("缺失面积")).not.toBeNull();
    const applyButton = within(diffDialog).getByRole("button", { name: "应用到看板并移出待确认" }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    await user.type(within(diffDialog).getByLabelText("汕头市昌隆机械科技有限公司面积"), "36");
    expect(applyButton.disabled).toBe(false);
  });

  it("opens member assignment dialogs from row, bulk bar and detail drawer actions", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1ET06",
            companyName: "汕头市昌隆机械科技有限公司",
            companyShortName: "昌隆机械",
            location: "一楼 / 1E",
            area: "36",
            boothType: "普通绿搭",
            salesOwner: "孙晓晓",
            builder: "李铁：13607664172"
          },
          {
            boothNumber: "1E05",
            companyName: "山东省聊城经济开发区齐龙精细化工厂",
            companyShortName: "齐龙精细化工厂",
            location: "1E",
            area: "9",
            boothType: "精标",
            salesOwner: "韩世军",
            builder: ""
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });

    await user.click(within(table).getByRole("button", { name: "分配山东省聊城经济开发区齐龙精细化工厂搭建成员" }));
    let dialog = screen.getByRole("dialog", { name: "分配现场搭建成员" });
    expect(within(dialog).getByText("山东省聊城经济开发区齐龙精细化工厂")).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: "确认分配" })).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "关闭成员分配" }));

    await user.click(within(table).getByLabelText("选择汕头市昌隆机械科技有限公司"));
    await user.click(screen.getByRole("button", { name: "批量分配搭建成员" }));
    dialog = screen.getByRole("dialog", { name: "批量分配现场搭建成员" });
    expect(within(dialog).getByText("已选择 1 个展商")).not.toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "关闭成员分配" }));

    await user.click(within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" }));
    const drawer = screen.getByRole("complementary", { name: "展商详情" });
    await user.click(within(drawer).getByRole("button", { name: "添加现场搭建成员" }));
    dialog = screen.getByRole("dialog", { name: "分配现场搭建成员" });
    expect(within(dialog).getByText("汕头市昌隆机械科技有限公司")).not.toBeNull();
  });

  it("opens exhibitor type settings from the type filter controls", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 / 1E",
          area: "36",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "类型设置" }));
    const dialog = screen.getByRole("dialog", { name: "展商类型设置" });
    expect(within(dialog).getByText("普通绿搭")).not.toBeNull();
    expect(within(dialog).getByText("普标")).not.toBeNull();
    expect(within(dialog).getByText("精标")).not.toBeNull();

    await user.type(within(dialog).getByLabelText("新增类型名称"), "彩搭");
    await user.click(within(dialog).getByRole("button", { name: "新增类型" }));
    expect(within(dialog).getByText("彩搭")).not.toBeNull();
  });

  it("renders prototype-style member avatars and dashboard pagination footer", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1ET06",
            companyName: "汕头市昌隆机械科技有限公司",
            companyShortName: "昌隆机械",
            location: "一楼 / 1E",
            area: "36",
            boothType: "普通绿搭",
            salesOwner: "孙晓晓",
            builder: "李铁：13607664172"
          },
          {
            boothNumber: "1E05",
            companyName: "山东省聊城经济开发区齐龙精细化工厂",
            companyShortName: "齐龙精细化工厂",
            location: "1E",
            area: "9",
            boothType: "精标",
            salesOwner: "韩世军",
            builder: ""
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).getByTitle("李铁")).not.toBeNull();
    expect(within(table).getByText("李")).not.toBeNull();
    expect(screen.getByText("共 2 条，显示 1-2 条")).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "分页" })).not.toBeNull();
  });

  it("closes the detail drawer with Escape and restores focus to the row action", async () => {
    const user = userEvent.setup();
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 / 1E",
          area: "36",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    const viewButton = within(table).getByRole("button", { name: "查看汕头市昌隆机械科技有限公司" });
    await user.click(viewButton);
    const drawer = screen.getByRole("complementary", { name: "展商详情" });
    expect(within(drawer).getByText("李铁")).not.toBeNull();
    expect(within(drawer).getByText("136****4172")).not.toBeNull();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("complementary", { name: "展商详情" })).toBeNull();
    expect(document.activeElement).toBe(viewButton);
  });

  it("shows a text notice when one booth contains multiple exhibitors", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[
          {
            boothNumber: "1AT27",
            companyName: "郑州鼎来瑞农业科技有限公司",
            companyShortName: "鼎来瑞农业",
            location: "一楼 / 1A",
            area: "18",
            boothType: "普通绿搭",
            salesOwner: "马永波",
            builder: "崔晓安"
          },
          {
            boothNumber: "1AT27",
            companyName: "郑州鑫利农农业科技有限公司",
            companyShortName: "鑫利农农业",
            location: "一楼 / 1A",
            area: "18",
            boothType: "普通绿搭",
            salesOwner: "马永波",
            builder: "崔晓安"
          }
        ]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    expect(within(table).getAllByText("同展位存在其他展商")).toHaveLength(2);
  });

  it("renders imported booth records as a visible exhibition data table", () => {
    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[{
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "昌隆机械",
          location: "一楼 1E",
          area: "36",
          boothType: "普通绿搭",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172"
        }]}
        onRefresh={vi.fn()}
      />
    );

    const table = screen.getByRole("table", { name: "展商数据表格" });
    ["展位号", "展商", "位置", "面积", "类型", "销售", "现场搭建成员", "操作"].forEach((header) => {
      expect(within(table).getByRole("columnheader", { name: header })).not.toBeNull();
    });
    ["1ET06", "汕头市昌隆机械科技有限公司", "一楼 1E", "36㎡", "普通绿搭", "孙晓晓", "李铁"].forEach((value) => {
      expect(within(table).getByText(value)).not.toBeNull();
    });
  });

  it("uploads titled logistics workbook for server-side sheet inspection instead of parsing only the first sheet", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const onRefresh = vi.fn();
    const user = userEvent.setup();
    vi.stubGlobal("fetch", fetchMock);

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["普通绿色搭建汇总"],
        ["企业名称", "楼层", "展馆", "展位号", "面积", "方案类型", "销售人员", "搭建商"],
        ["汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", "36", "普通绿搭", "孙晓晓", "李铁：13607664172"]
      ]),
      "普通绿色搭建汇总"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["标展楣牌下单情况"],
        ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "销售人员"],
        ["安徽省安邦矿物股份有限公司", "1E", "1E01", "精标", "6", "孙晓晓"]
      ]),
      "标展楣牌"
    );
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const file = new File([buffer], "logistics.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    render(
      <AdminConfigCenter
        config={config}
        view="exhibition-data"
        booths={[]}
        onRefresh={onRefresh}
      />
    );

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/master-data", expect.objectContaining({ method: "POST" })));
    const requestInit = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
    expect(requestInit.headers).toBeUndefined();
    const body = requestInit.body as FormData;
    expect(typeof body.get).toBe("function");
    const uploadedFile = body.get("file") as File;
    expect(uploadedFile.name).toBe("logistics.xlsx");
    expect(uploadedFile.size).toBeGreaterThan(0);
    expect(body.get("dryRun")).toBe("false");
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("does not render record management modules in the PC config center", () => {
    render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

    expect(screen.queryByText("微信/企微消息")).toBeNull();
    expect(screen.queryByText("微信身份绑定")).toBeNull();
    expect(screen.queryByText("追问会话")).toBeNull();
    expect(screen.queryByText("出站通知")).toBeNull();
  });
});

