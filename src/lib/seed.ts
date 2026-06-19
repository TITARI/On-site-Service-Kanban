import { normalizeKeywordGroups } from "./domain/keyword-config";
import { defaultAiPromptDefaults, defaultAiPromptTemplates } from "./domain/ai-config";
import type { AiModelConfig, AiPromptDefaults, AiPromptTemplate, AutoAcceptanceConfig, IssueType, KeywordGroup, MessageIntegrationConfig, UserGroup, WxautoMcpConfig } from "./domain/types";
import { defaultWxautoMcpConfig, WXAUTO_MCP_ENDPOINT, WXAUTO_MCP_SECRET_ENV, WXAUTO_MCP_SERVER_NAME } from "./integrations/wxauto/config";

export type AppConfig = {
  issueTypes: IssueType[];
  aiModels: AiModelConfig[];
  messageIntegrations?: MessageIntegrationConfig[];
  wxautoMcp?: WxautoMcpConfig;
  userGroups?: UserGroup[];
  keywordGroups?: KeywordGroup[];
  aiPromptTemplates?: AiPromptTemplate[];
  aiPromptDefaults?: Partial<AiPromptDefaults>;
  autoAcceptance?: AutoAcceptanceConfig;
  assignmentRules: Array<{ id: string; boothPattern: string; issueType: string; handlerId: string; handlerName: string; groupName: string }>;
};

export function defaultUserGroups(): UserGroup[] {
  return [
    { id: "business", name: "业务组", description: "业务人员负责最终验收和展商反馈闭环。", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "organizer", name: "主场组", description: "主场运营负责现场统筹、复核和验收。", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "搭建组", description: "搭建人员可认领工单，并提交处理内容和现场照片。", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
  ];
}

export function userGroupsOf(config: AppConfig): UserGroup[] {
  const groups = config.userGroups?.filter((group) => group.enabled) ?? [];
  return (groups.length > 0 ? groups : defaultUserGroups()).map((group) => ({
    ...group,
    canAdmin: group.canAdmin ?? false
  }));
}

export function defaultMessageIntegrations(): MessageIntegrationConfig[] {
  return [
    {
      id: "wechat",
      channel: "wechat",
      label: "wxauto 桌面服务",
      enabled: false,
      mcpServerName: WXAUTO_MCP_SERVER_NAME,
      endpoint: WXAUTO_MCP_ENDPOINT,
      secretEnv: WXAUTO_MCP_SECRET_ENV,
      autoCreateTickets: false
    },
    {
      id: "wecom",
      channel: "wecom",
      label: "企业微信 MCP",
      enabled: false,
      mcpServerName: "wecom-mcp",
      endpoint: "/api/integrations/wechat/messages",
      secretEnv: "WECOM_MCP_SECRET",
      autoCreateTickets: false
    }
  ];
}

export function messageIntegrationsOf(config: AppConfig): MessageIntegrationConfig[] {
  return config.messageIntegrations?.length ? config.messageIntegrations : defaultMessageIntegrations();
}

export function defaultKeywordGroups(): KeywordGroup[] {
  return [
    {
      id: "operational-intent",
      name: "现场诉求关键词",
      description: "用于判断微信消息是否属于报修、催单或现场服务诉求。",
      enabled: true,
      ruleSets: [
        {
          id: "intent-reporting",
          matchType: "contains",
          action: "operational-intent",
          priority: 100,
          enabled: true,
          sortOrder: 1,
          terms: [
            "报修",
            "故障",
            "处理",
            "需要",
            "不能",
            "无法",
            "没有",
            "坏",
            "断",
            "催",
            "加急",
            "尽快",
            "失败",
            "不亮",
            "漏水",
            "跳闸",
            "电联",
            "电话",
            "联系",
            "联系不上",
            "联络",
            "打不通",
            "不通"
          ].map((value, index) => ({
            id: `intent-term-${index + 1}`,
            value,
            enabled: true,
            sortOrder: index + 1
          }))
        }
      ]
    },
    {
      id: "issue-type-keywords",
      name: "问题类型关键词",
      description: "用于把微信消息映射到后台配置的问题类型。",
      enabled: true,
      ruleSets: [
        {
          id: "issue-service",
          matchType: "contains",
          action: "issue-type",
          issueType: "综合服务",
          priority: 90,
          enabled: true,
          sortOrder: 1,
          terms: ["电联", "电话", "联系", "联系不上", "联络", "打不通", "不通", "桌", "椅", "物料", "租赁", "会刊", "证件", "服务"].map((value, index) => ({
            id: `issue-service-term-${index + 1}`,
            value,
            enabled: true,
            sortOrder: index + 1
          }))
        },
        {
          id: "issue-network",
          matchType: "contains",
          action: "issue-type",
          issueType: "网络",
          priority: 80,
          enabled: true,
          sortOrder: 2,
          terms: ["网络", "断网", "网线", "wifi", "wi-fi", "扫码", "收款"].map((value, index) => ({
            id: `issue-network-term-${index + 1}`,
            value,
            enabled: true,
            sortOrder: index + 1
          }))
        },
        {
          id: "issue-power",
          matchType: "contains",
          action: "issue-type",
          issueType: "电力",
          priority: 70,
          enabled: true,
          sortOrder: 3,
          terms: ["电力", "没电", "断电", "电源", "接电", "用电", "电箱", "插座", "跳闸", "照明", "不亮", "灯"].map((value, index) => ({
            id: `issue-power-term-${index + 1}`,
            value,
            enabled: true,
            sortOrder: index + 1
          }))
        },
        {
          id: "issue-build",
          matchType: "contains",
          action: "issue-type",
          issueType: "搭建",
          priority: 60,
          enabled: true,
          sortOrder: 4,
          terms: ["搭建", "门头", "背板", "地毯", "展板", "结构", "施工"].map((value, index) => ({
            id: `issue-build-term-${index + 1}`,
            value,
            enabled: true,
            sortOrder: index + 1
          }))
        }
      ]
    }
  ];
}

export function keywordGroupsOf(config: AppConfig): KeywordGroup[] {
  return normalizeKeywordGroups(config.keywordGroups?.length ? config.keywordGroups : defaultKeywordGroups());
}

export function defaultConfig(): AppConfig {
  return {
    issueTypes: [
      { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true },
      { id: "power", name: "电力", urgencyMinutes: 15, priorityWeight: 30, assignmentGroup: "工程组", enabled: true },
      { id: "build", name: "搭建", urgencyMinutes: 30, priorityWeight: 20, assignmentGroup: "搭建组", enabled: true },
      { id: "service", name: "综合服务", urgencyMinutes: 45, priorityWeight: 10, assignmentGroup: "客服组", enabled: true }
    ],
    aiModels: [
      { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
      { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
    ],
    messageIntegrations: defaultMessageIntegrations(),
    wxautoMcp: defaultWxautoMcpConfig(),
    userGroups: defaultUserGroups(),
    keywordGroups: defaultKeywordGroups(),
    aiPromptTemplates: defaultAiPromptTemplates(),
    aiPromptDefaults: defaultAiPromptDefaults(),
    autoAcceptance: { enabled: true, timeoutMinutes: 30 },
    assignmentRules: [
      { id: "network-a", boothPattern: "A", issueType: "网络", handlerId: "h-network", handlerName: "网络值班", groupName: "网络组" },
      { id: "power-a", boothPattern: "A", issueType: "电力", handlerId: "h-power", handlerName: "工程值班", groupName: "工程组" }
    ]
  };
}
