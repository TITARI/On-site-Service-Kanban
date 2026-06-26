export type TicketStatus = "待受理" | "处理中" | "挂起" | "已解决" | "待再次处理" | "已关闭";
export type IssueTypeName = "自动" | string;
export type UserRole = "member" | "admin" | "handler" | "system-ai";

export type UserGroup = {
  id: string;
  name: string;
  description: string;
  canClaim: boolean;
  canProcess: boolean;
  canAccept: boolean;
  canAdmin: boolean;
  enabled: boolean;
};

export type BoothRecord = {
  boothNumber: string;
  companyName: string;
  companyShortName: string;
  salesOwner: string;
  builder: string;
  location?: string;
  area?: string;
  boothType?: string;
};

export type IssueType = {
  id: string;
  name: string;
  urgencyMinutes: number;
  priorityWeight: number;
  assignmentGroup?: string;
  enabled: boolean;
};

export type AiModelConfig = {
  id: "fast" | "smart";
  label: string;
  provider: "mock" | "http";
  providerPreset?: AiProviderPresetId;
  endpoint?: string;
  apiKey?: string;
  apiKeyConfigured?: boolean;
  apiKeyEnv?: string;
  modelName: string;
  timeoutMs: number;
  enabled: boolean;
};

export type AiProviderPresetId = "deepseek" | "openai" | "qwen" | "kimi" | "zhipu" | "custom";

export type ImportSystemField =
  | "boothNumber"
  | "companyName"
  | "floor"
  | "hall"
  | "area"
  | "areaSpecification"
  | "exhibitorType"
  | "salesOwner"
  | "builder";

export type AiPromptScenario = "classify" | "dedupe" | "escalation" | "customer-service" | "exhibitor-import";

export type AiPromptTemplate = {
  id: string;
  scenario: AiPromptScenario;
  name: string;
  description: string;
  systemPrompt: string;
  builtIn: boolean;
  enabled: boolean;
  updatedAt?: string;
};

export type AiPromptDefaults = Record<AiPromptScenario, string>;

export type MessageChannel = "wechat" | "wecom";

export type PersonRole = "reporter" | "handler" | "manager" | "admin";

export type Person = {
  id: string;
  name: string;
  phone: string;
  role: PersonRole;
  groupId?: string;
  groupName: string;
  groupLocked?: boolean;
  nameConflict?: { attemptedName: string; observedAt: string };
  boothScope?: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatIdentity = {
  id: string;
  platform: MessageChannel;
  externalUserId: string;
  displayName: string;
  isTemporary?: boolean;
  personId?: string;
  verifiedBy?: "phone" | "admin" | "import";
  verifiedAt?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ChatIdentityRebindExpectation = {
  platform: MessageChannel;
  identityId: string;
  fromPersonId: string;
  toPersonId: string;
};

export type Conversation = {
  id: string;
  platform: MessageChannel;
  type: "direct" | "group";
  externalConversationId: string;
  title?: string;
  linkedPersonIds: string[];
  defaultNotify: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PendingWorkOrderField = "identityGroup" | "name" | "phone" | "boothNumber" | "issueType";

export type PendingWorkOrderSession = {
  id: string;
  platform: MessageChannel;
  conversationId: string;
  chatIdentityId: string;
  originalMessageRecordId?: string;
  draftText: string;
  draftImages: string[];
  identityGroup?: string;
  contactName?: string;
  contactPhone?: string;
  personId?: string;
  boothNumber?: string;
  issueType?: string;
  missingFields: PendingWorkOrderField[];
  createdAt: string;
  updatedAt: string;
  lastPromptAt?: string;
};

export type OutboundMessageStatus = "pending" | "sending" | "sent" | "failed";

export type AutoAcceptanceConfig = {
  enabled: boolean;
  timeoutMinutes: number;
};

export type OutboundMessage = {
  id: string;
  channel: MessageChannel;
  targetConversationId?: string;
  targetChatIdentityId?: string;
  targetName: string;
  text: string;
  relatedTicketId?: string;
  relatedSessionId?: string;
  status: OutboundMessageStatus;
  retryCount: number;
  lastError?: string;
  claimedAt?: string;
  sentAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type MessageIntegrationConfig = {
  id: string;
  channel: MessageChannel;
  label: string;
  enabled: boolean;
  mcpServerName: string;
  endpoint?: string;
  secretEnv?: string;
  autoCreateTickets: boolean;
};

export type WxautoMcpConfig = {
  enabled: boolean;
  endpoint: string;
  accessToken?: string;
  autoCreateTickets: boolean;
};

export type KeywordRule = {
  id: string;
  keyword: string;
  matchType: "contains" | "exact";
  action: "operational-intent" | "issue-type";
  issueType?: string;
  priority: number;
  enabled: boolean;
};

export type KeywordTerm = {
  id: string;
  value: string;
  aliases?: string[];
  enabled: boolean;
  sortOrder?: number;
};

export type KeywordRuleSet = {
  id: string;
  matchType: "contains" | "exact";
  action: "operational-intent" | "issue-type";
  issueType?: string;
  priority: number;
  enabled: boolean;
  channels?: MessageChannel[];
  conditions?: Record<string, unknown>;
  actionConfig?: Record<string, unknown>;
  sortOrder?: number;
  terms: KeywordTerm[];
};

export type KeywordGroup = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  ruleSets?: KeywordRuleSet[];
  rules?: KeywordRule[];
};

export type MessageTicketAnalysis = {
  boothNumber?: string;
  issueType?: string;
  confidence: number;
  suggestedAction: "create-ticket" | "urge-existing" | "needs-review" | "ignore";
  matchedTicketId?: string;
  reason: string;
};

export type InboundMessageRecord = {
  id: string;
  channel: MessageChannel;
  externalMessageId?: string;
  senderId?: string;
  senderName: string;
  senderPhone?: string;
  senderGroup?: string;
  text: string;
  imageUrls: string[];
  receivedAt: string;
  createdAt: string;
  reporterPersonId?: string;
  reporterChatIdentityId?: string;
  sourceConversationId?: string;
  raw?: Record<string, unknown>;
  analysis: MessageTicketAnalysis;
};

export type AiDecision = {
  modelId: "fast" | "smart";
  scenario: AiPromptScenario;
  confidence: number;
  action: "create" | "urge" | "manual-review" | "classify" | "expedite";
  issueType?: string;
  matchedTicketId?: string;
  suggestion?: string;
  latencyMs: number;
};

export type CustomerServiceDecision = {
  modelId: "smart";
  scenario: "customer-service";
  confidence: number;
  pressureLevel: 1 | 2 | 3 | 4 | 5;
  action: "reply" | "ask-follow-up" | "urge-existing" | "expedite" | "manual-review" | "ignore";
  matchedTicketId?: string;
  replyText: string;
  reason: string;
  latencyMs: number;
};

export type TicketReply = {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
  authorPhone?: string;
  role: UserRole;
  body: string;
  imageUrls: string[];
  createdAt: string;
};

export type TicketTimelineItem = {
  id: string;
  ticketId: string;
  type: "submitted" | "assigned" | "status-changed" | "urged" | "reply" | "ai-suggestion" | "receipt";
  body: string;
  createdAt: string;
  actorName: string;
  toStatus?: TicketStatus;
};

export type Ticket = {
  id: string;
  title: string;
  boothNumber: string;
  companyName: string;
  companyShortName: string;
  description: string;
  imageUrls: string[];
  issueType: string;
  submitterId: string;
  submitterName: string;
  submitterPhone?: string;
  reporterPersonId?: string;
  reporterChatIdentityId?: string;
  sourceConversationId?: string;
  feedbackUsers: Array<{ userId: string; userName: string; phone?: string; feedbackAt: string }>;
  status: TicketStatus;
  acceptedAt?: string;
  handlerId?: string;
  handlerName?: string;
  handlerPhone?: string;
  assignmentGroup?: string;
  urgeCount: number;
  lastUrgedAt?: string;
  urgeLevel: 0 | 1 | 2 | 3;
  priorityScore: number;
  aiDecisions: AiDecision[];
  replies: TicketReply[];
  timeline: TicketTimelineItem[];
  createdAt: string;
  updatedAt: string;
};
