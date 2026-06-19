import { chromium } from "playwright";

const edgeExecutable = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await chromium.launch({
  executablePath: edgeExecutable,
  headless: true,
  args: ["--disable-gpu", "--no-sandbox"]
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  deviceScaleFactor: 1
});

const config = {
  issueTypes: [
    { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, enabled: true, assignmentGroup: "搭建组" },
    { id: "build", name: "搭建", urgencyMinutes: 30, priorityWeight: 20, enabled: true, assignmentGroup: "搭建组" },
    { id: "service", name: "综合服务", urgencyMinutes: 45, priorityWeight: 10, enabled: true }
  ],
  aiModels: [
    { id: "fast", label: "快速AI", provider: "http", modelName: "deepseek-v4-flash", timeoutMs: 8000, enabled: true, providerPreset: "deepseek", endpoint: "https://api.deepseek.com/v1/chat/completions", apiKeyConfigured: true },
    { id: "smart", label: "高智商AI", provider: "http", modelName: "deepseek-v4-pro", timeoutMs: 8000, enabled: true, providerPreset: "deepseek", endpoint: "https://api.deepseek.com/v1/chat/completions", apiKeyConfigured: true }
  ],
  messageIntegrations: [
    { id: "wechat", channel: "wechat", label: "wxauto 桌面服务", enabled: true, mcpServerName: "wxauto-desktop", endpoint: "/api/mcp", secretEnv: "WXAUTO_MCP_TOKEN", autoCreateTickets: true }
  ],
  wxautoMcp: { enabled: true, endpoint: "/api/mcp", accessToken: "已设置", autoCreateTickets: true },
  userGroups: [
    { id: "business", name: "业务组", description: "业务人员负责最终验收和展商反馈闭环。", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "搭建组", description: "现场搭建组成员", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true },
    { id: "admin", name: "系统管理员组", description: "系统管理员", canClaim: false, canProcess: false, canAccept: false, canAdmin: true, enabled: true }
  ],
  assignmentRules: [],
  keywordGroups: [],
  aiPromptTemplates: [],
  aiPromptDefaults: {},
  autoAcceptance: { enabled: true, timeoutMinutes: 30 }
};

const booths = [
  { boothNumber: "1ET06", companyName: "汕头市昌隆机械科技有限公司", companyShortName: "昌隆机械", location: "一楼 / 1E", area: "36", boothType: "普通绿搭", salesOwner: "孙晓晓", builder: "李铁：13607664172" },
  { boothNumber: "1AT27", companyName: "郑州鼎来瑞农业科技有限公司", companyShortName: "鼎来瑞农业", location: "一楼 / 1A", area: "18", boothType: "普通绿搭", salesOwner: "马永波", builder: "崔晓安：13803812794" },
  { boothNumber: "1AT27", companyName: "郑州鑫利农农业科技有限公司", companyShortName: "鑫利农农业", location: "一楼 / 1A", area: "18", boothType: "普通绿搭", salesOwner: "马永波", builder: "崔晓安：13803812794" },
  { boothNumber: "1E05", companyName: "山东省聊城经济开发区齐龙精细化工厂", companyShortName: "齐龙精细化工厂", location: "一楼 / 1E", area: "9", boothType: "精标", salesOwner: "韩世军", builder: "" },
  { boothNumber: "2D02", companyName: "山西惠农生物有机肥有限公司", companyShortName: "惠农生物", location: "二楼 / 2D", area: "9", boothType: "普标", salesOwner: "潘金生", builder: "" }
];

const bootstrap = {
  tickets: [],
  booths,
  messageRecords: [],
  people: [],
  chatIdentities: [],
  conversations: [],
  pendingWorkOrderSessions: [],
  outboundMessages: [],
  config
};

await page.route("**/api/auth/session?type=admin", (route) => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({
    authenticated: true,
    user: { id: "person-admin-preview", name: "预览管理员", phone: "18638638860", role: "admin", groupId: "admin", groupName: "系统管理员组" }
  })
}));

await page.route("**/api/bootstrap**", (route) => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(bootstrap)
}));

await page.route("**/api/admin/wechat-order-logs?limit=50", (route) => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ logs: [] })
}));

await page.route("**/api/admin/wxauto-mcp", (route) => route.fulfill({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify({ wxautoMcp: config.wxautoMcp })
}));

await page.goto("http://127.0.0.1:3010/admin/exhibition-data", {
  waitUntil: "networkidle",
  timeout: 90000
});
await page.locator("h1").filter({ hasText: "展商数据看板" }).waitFor({ timeout: 30000 });

const screenshotPath = "C:/Users/TianGong/主场看板/主场看板/preview-exhibitor-dashboard-new.png";
await page.screenshot({ path: screenshotPath, fullPage: true });
console.log(screenshotPath);
console.log((await page.locator("body").innerText()).slice(0, 1200));

await browser.close();
