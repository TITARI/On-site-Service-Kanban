import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    { id: "fast", label: "快速AI", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高智商AI", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
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
  vi.useRealTimers();
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
    await user.click(screen.getByLabelText("搭建组启用"));
    await user.type(screen.getByLabelText("新增分组名称"), "客服组");
    await user.type(screen.getByLabelText("新增分组说明"), "负责现场答疑和回访");
    await user.click(screen.getByLabelText("新增分组可验收"));
    await user.click(screen.getByRole("button", { name: "保存用户分组配置" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({ method: "PUT" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ id: "business", name: "业务团队", canClaim: true, enabled: true }));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ id: "builder", name: "搭建组", enabled: false }));
    expect(body.userGroups).toContainEqual(expect.objectContaining({ name: "客服组", description: "负责现场答疑和回访", canAccept: true, enabled: true }));
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

  it("queues feedback toasts and gives each message its own 1.5 second turn", () => {
    vi.useFakeTimers();
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

    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getAllByRole("status").map((toast) => toast.textContent)).toEqual([
      "请填写所有已配置分组的名称"
    ]);

    act(() => vi.advanceTimersByTime(1499));
    expect(screen.getByRole("status").textContent).toBe("请填写所有已配置分组的名称");

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
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

    await user.selectOptions(screen.getByLabelText("快速AI供应商"), "http");
    await user.clear(screen.getByLabelText("快速AI接口地址"));
    await user.type(screen.getByLabelText("快速AI接口地址"), "https://api.openai.example/v1/chat/completions");
    await user.type(screen.getByLabelText("快速AIAPI密钥"), "sk-test-fast");
    await user.click(screen.getByRole("button", { name: "获取快速AI模型列表" }));
    await screen.findByRole("option", { name: "gpt-fast" });
    await user.selectOptions(screen.getByLabelText("快速AI模型名称"), "gpt-fast");
    await user.click(screen.getByRole("button", { name: "保存快速AI" }));

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

    expect(screen.queryByText("已配置API密钥，留空保存不变。")).toBeNull();
    expect(screen.queryByText("保存后API密钥不会在页面回显。")).toBeNull();
    expect((screen.getByLabelText("快速AIAPI密钥") as HTMLInputElement).value).toBe(MASKED_API_KEY);
    expect((screen.getByLabelText("快速AI模型名称") as HTMLSelectElement).value).toBe("gpt-fast");
    await user.click(screen.getByRole("button", { name: "获取快速AI模型列表" }));
    await screen.findByRole("option", { name: "gpt-smart" });
    expect((screen.getByLabelText("快速AI模型名称") as HTMLSelectElement).value).toBe("gpt-fast");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/ai-models", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        endpoint: "https://api.openai.example/v1/chat/completions",
        modelId: "fast"
      })
    }));

    await user.click(screen.getByRole("button", { name: "保存快速AI" }));
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

    expect(screen.queryByRole("button", { name: "应用快速AI供应商推荐值" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("快速AI供应商预设"), "deepseek");

    expect((screen.getByLabelText("快速AI供应商") as HTMLSelectElement).value).toBe("http");
    expect((screen.getByLabelText("快速AI接口地址") as HTMLInputElement).value).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((screen.getByLabelText("快速AI模型名称") as HTMLSelectElement).value).toBe("deepseek-chat");
    expect(screen.getByRole("button", { name: "获取快速AI模型列表" })).not.toBeNull();
    expect((screen.getByLabelText("快速AIAPI密钥") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("快速AIAPI密钥") as HTMLInputElement).type).toBe("password");
    expect((screen.getByLabelText("快速AI超时毫秒") as HTMLInputElement).value).toBe("8000");

    await user.click(screen.getByRole("button", { name: "保存快速AI" }));

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

    expect(screen.getByRole("heading", { name: "AI调用预设" })).not.toBeNull();
    expect(screen.getByText("识别顺序：自定义关键词优先判断是否处理和问题类型；未命中问题类型时才调用 AI 分类。创建工单时，AI 仍会参与相似工单判重。AI 提示词只影响实际调用 AI 的场景，不会覆盖已命中的关键词规则。")).not.toBeNull();
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

    expect(screen.getAllByRole("heading", { name: "展览数据" }).length).toBeGreaterThan(0);
    expect(screen.getByText("当前展位数据 1 条")).not.toBeNull();

    await user.upload(screen.getByLabelText("导入展位数据文件"), file);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/master-data", expect.objectContaining({ method: "POST" })));
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.dryRun).toBe(false);
    expect(body.rows).toContainEqual(expect.objectContaining({ boothNumber: "A09", companyName: "测试公司" }));
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

