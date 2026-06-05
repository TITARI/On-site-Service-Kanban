# wxauto 完整值守接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a wxauto-powered watchtower that listens to all WeChat messages, filters ordinary chat, auto-registers WeChat users, asks follow-up questions, creates or urges tickets, and sends WeChat notifications back through wxauto.

**Architecture:** Keep wxauto as a transport bridge and keep business decisions inside the Next.js app. Add focused services for outbound messages, WeChat identity registration, pending work-order sessions, and watchtower orchestration; API routes stay thin and call those services. Preserve file-backed storage but add migration defaults so existing `data/app-state.json` continues to load.

**Tech Stack:** Next.js App Router, TypeScript, Zod, Vitest, file-backed JSON state, existing wxauto REST bridge script, wxauto-restful-api endpoints `/v1/wechat/getnextnewmessage` and `/v1/wechat/send`.

---

## Scope Check

The design includes several pieces, but they are one end-to-end subsystem: WeChat message intake, user identity, follow-up sessions, ticket actions, and outbound notifications. The tasks below keep each piece independently testable and commit-sized while producing a working vertical slice by Task 5.

## File Structure

- Modify `src/lib/domain/types.ts`: add outbound message types, add `identityGroup` to pending session fields, and add small fields needed for wxauto source tracking.
- Modify `src/lib/storage/file-store.ts`: add `outboundMessages` to `AppState` and migration defaults.
- Create `src/lib/services/outbound-message-service.ts`: queue, claim, mark sent, mark failed, and ticket notification helpers.
- Create `src/lib/services/wechat-identity-service.ts`: registration command parsing, person creation/update, chat identity binding, and identity prompt text.
- Create `src/lib/services/wechat-watchtower-service.ts`: orchestrate message filtering, registration, follow-up sessions, ticket intake, and notification queueing.
- Modify `src/lib/services/message-intake-service.ts`: support reporter identity fields already present in `IntakeMessageInput`, add duplicate-message short-circuit, and keep analysis reusable by watchtower.
- Modify `src/app/api/integrations/wechat/messages/route.ts`: call the watchtower service instead of direct intake recording.
- Create `src/app/api/integrations/wechat/outbound/route.ts`: bridge endpoint to claim pending outbound messages.
- Create `src/app/api/integrations/wechat/outbound/[messageId]/route.ts`: bridge endpoint to mark sent or failed.
- Modify `src/app/api/tickets/[ticketId]/route.ts`: enqueue solve/close/rework notifications after status actions.
- Modify `src/app/api/tickets/[ticketId]/replies/route.ts`: fix mojibake errors while touching this file and optionally enqueue reply notifications.
- Modify `src/app/api/bootstrap/route.ts`: include people, chat identities, pending sessions, and outbound messages for admin display.
- Modify `src/components/admin-panel.tsx`: show WeChat identities, pending sessions, and outbound failures.
- Modify `scripts/wxauto-rest-bridge.mjs`: refactor for exports, claim outbound messages, send via wxauto, and mark results.
- Modify `docs/wxauto-rest-bridge-trial.md`, `README.md`, and `deploy/windows/app.env.sample.ps1`: document full watchtower setup.

## Task 1: State Model And Migration

**Files:**
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/storage/file-store.ts`
- Test: `tests/services/watchtower-state.test.ts`

- [ ] **Step 1: Write failing state migration tests**

Create `tests/services/watchtower-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initialState, parseStoredState } from "@/lib/storage/file-store";

describe("watchtower state shape", () => {
  it("initializes watchtower collections", () => {
    const state = initialState();

    expect(state.people).toEqual([]);
    expect(state.chatIdentities).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.pendingWorkOrderSessions).toEqual([]);
    expect(state.outboundMessages).toEqual([]);
  });

  it("migrates old stored state with watchtower defaults", () => {
    const state = parseStoredState(JSON.stringify({
      booths: [],
      tickets: [],
      messageRecords: [],
      config: { issueTypes: [], aiModels: [], assignmentRules: [] }
    }));

    expect(state.people).toEqual([]);
    expect(state.chatIdentities).toEqual([]);
    expect(state.conversations).toEqual([]);
    expect(state.pendingWorkOrderSessions).toEqual([]);
    expect(state.outboundMessages).toEqual([]);
    expect(state.config.messageIntegrations?.map((item) => item.channel)).toEqual(["wechat", "wecom"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
npm run test:run -- tests/services/watchtower-state.test.ts
```

Expected: FAIL because `outboundMessages` does not exist on `AppState` or `initialState()`.

- [ ] **Step 3: Add domain types**

Modify `src/lib/domain/types.ts`:

```ts
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
```

Also add optional source metadata to `InboundMessageRecord`:

```ts
  sourceConversationId?: string;
  raw?: Record<string, unknown>;
```

- [ ] **Step 4: Add outbound messages to storage**

Modify `src/lib/storage/file-store.ts` imports and `AppState`:

```ts
import type {
  BoothRecord,
  ChatIdentity,
  Conversation,
  InboundMessageRecord,
  OutboundMessage,
  PendingWorkOrderSession,
  Person,
  Ticket
} from "../domain/types";

export type AppState = {
  booths: BoothRecord[];
  tickets: Ticket[];
  messageRecords: InboundMessageRecord[];
  people?: Person[];
  chatIdentities?: ChatIdentity[];
  conversations?: Conversation[];
  pendingWorkOrderSessions?: PendingWorkOrderSession[];
  outboundMessages?: OutboundMessage[];
  config: AppConfig;
};
```

Update `initialState()`:

```ts
    pendingWorkOrderSessions: [],
    outboundMessages: [],
```

Update `parseStoredState()`:

```ts
      pendingWorkOrderSessions: parsed.pendingWorkOrderSessions ?? [],
      outboundMessages: parsed.outboundMessages ?? [],
```

- [ ] **Step 5: Run the state tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/services/watchtower-state.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/lib/domain/types.ts src/lib/storage/file-store.ts tests/services/watchtower-state.test.ts
git commit -m "feat: add watchtower state model"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 2: Outbound Message Queue

**Files:**
- Create: `src/lib/services/outbound-message-service.ts`
- Create: `tests/services/outbound-message-service.test.ts`
- Create: `src/app/api/integrations/wechat/outbound/route.ts`
- Create: `src/app/api/integrations/wechat/outbound/[messageId]/route.ts`
- Create: `tests/api/wechat-outbound-route.test.ts`

- [ ] **Step 1: Write failing outbound service tests**

Create `tests/services/outbound-message-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import {
  claimPendingOutboundMessages,
  markOutboundMessageFailed,
  markOutboundMessageSent,
  queueOutboundMessage
} from "@/lib/services/outbound-message-service";

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig()
  };
}

describe("outbound message service", () => {
  it("queues pending WeChat messages", () => {
    const appState = state();

    const message = queueOutboundMessage(appState, {
      channel: "wechat",
      targetName: "搭建群",
      text: "A01 网络工单已创建",
      relatedTicketId: "ticket-1"
    });

    expect(message).toMatchObject({
      channel: "wechat",
      targetName: "搭建群",
      text: "A01 网络工单已创建",
      relatedTicketId: "ticket-1",
      status: "pending",
      retryCount: 0
    });
    expect(appState.outboundMessages).toHaveLength(1);
  });

  it("claims pending messages and marks them sending", () => {
    const appState = state();
    queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const claimed = claimPendingOutboundMessages(appState, { limit: 1, now: "2026-05-27T12:00:00.000Z" });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("sending");
    expect(claimed[0].claimedAt).toBe("2026-05-27T12:00:00.000Z");
  });

  it("marks sent and failed messages", () => {
    const appState = state();
    const message = queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "已创建工单" });

    markOutboundMessageSent(appState, message.id, "2026-05-27T12:01:00.000Z");
    expect(message.status).toBe("sent");
    expect(message.sentAt).toBe("2026-05-27T12:01:00.000Z");

    const failed = queueOutboundMessage(appState, { channel: "wechat", targetName: "李四", text: "发送失败测试" });
    markOutboundMessageFailed(appState, failed.id, "窗口不存在", "2026-05-27T12:02:00.000Z");

    expect(failed.status).toBe("failed");
    expect(failed.retryCount).toBe(1);
    expect(failed.lastError).toBe("窗口不存在");
  });
});
```

- [ ] **Step 2: Run the outbound service tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/services/outbound-message-service.test.ts
```

Expected: FAIL because `outbound-message-service.ts` does not exist.

- [ ] **Step 3: Implement outbound service**

Create `src/lib/services/outbound-message-service.ts`:

```ts
import type { AppState } from "../storage/file-store";
import type { MessageChannel, OutboundMessage, Ticket } from "../domain/types";

export type QueueOutboundMessageInput = {
  channel: MessageChannel;
  targetConversationId?: string;
  targetChatIdentityId?: string;
  targetName: string;
  text: string;
  relatedTicketId?: string;
  relatedSessionId?: string;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function outboundMessagesOf(state: AppState) {
  state.outboundMessages ??= [];
  return state.outboundMessages;
}

export function queueOutboundMessage(state: AppState, input: QueueOutboundMessageInput): OutboundMessage {
  const createdAt = now();
  const message: OutboundMessage = {
    id: id("outbound"),
    channel: input.channel,
    targetConversationId: input.targetConversationId,
    targetChatIdentityId: input.targetChatIdentityId,
    targetName: input.targetName,
    text: input.text.trim(),
    relatedTicketId: input.relatedTicketId,
    relatedSessionId: input.relatedSessionId,
    status: "pending",
    retryCount: 0,
    createdAt,
    updatedAt: createdAt
  };
  outboundMessagesOf(state).push(message);
  return message;
}

export function claimPendingOutboundMessages(
  state: AppState,
  { limit = 10, now: nowIso = now() }: { limit?: number; now?: string } = {}
) {
  const messages = outboundMessagesOf(state)
    .filter((message) => message.status === "pending" || (message.status === "failed" && message.retryCount < 3))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, limit);

  for (const message of messages) {
    message.status = "sending";
    message.claimedAt = nowIso;
    message.updatedAt = nowIso;
  }

  return messages;
}

export function markOutboundMessageSent(state: AppState, messageId: string, nowIso = now()) {
  const message = outboundMessagesOf(state).find((item) => item.id === messageId);
  if (!message) throw new Error("出站消息不存在");
  message.status = "sent";
  message.sentAt = nowIso;
  message.lastError = undefined;
  message.updatedAt = nowIso;
  return message;
}

export function markOutboundMessageFailed(state: AppState, messageId: string, error: string, nowIso = now()) {
  const message = outboundMessagesOf(state).find((item) => item.id === messageId);
  if (!message) throw new Error("出站消息不存在");
  message.status = "failed";
  message.retryCount += 1;
  message.lastError = error.trim() || "发送失败";
  message.updatedAt = nowIso;
  return message;
}

function conversationTargetForTicket(state: AppState, ticket: Ticket) {
  if (ticket.sourceConversationId) return ticket.sourceConversationId;
  const identity = state.chatIdentities?.find((item) => item.id === ticket.reporterChatIdentityId);
  if (identity?.displayName) return identity.displayName;
  return ticket.submitterName;
}

export function queueTicketFeedbackMessage(state: AppState, ticket: Ticket, text: string) {
  return queueOutboundMessage(state, {
    channel: "wechat",
    targetConversationId: ticket.sourceConversationId,
    targetChatIdentityId: ticket.reporterChatIdentityId,
    targetName: conversationTargetForTicket(state, ticket),
    text,
    relatedTicketId: ticket.id
  });
}

export function queueProcessingGroupMessage(state: AppState, ticket: Ticket, text: string) {
  const targetName = ticket.assignmentGroup ?? ticket.handlerName ?? "管理员";
  return queueOutboundMessage(state, {
    channel: "wechat",
    targetName,
    text,
    relatedTicketId: ticket.id
  });
}
```

- [ ] **Step 4: Run outbound service tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/services/outbound-message-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing outbound route tests**

Create `tests/api/wechat-outbound-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import { queueOutboundMessage } from "@/lib/services/outbound-message-service";

const store = vi.hoisted(() => ({ state: undefined as AppState | undefined, writeState: vi.fn() }));

vi.mock("@/lib/storage/file-store", () => ({
  readState: vi.fn(async () => store.state),
  writeState: store.writeState
}));

const outboundRoute = await import("@/app/api/integrations/wechat/outbound/route");
const outboundResultRoute = await import("@/app/api/integrations/wechat/outbound/[messageId]/route");

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig()
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/integrations/wechat/outbound", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  store.state = state();
  store.writeState.mockClear();
  process.env.WECHAT_MCP_SECRET = "bridge-secret";
});

describe("wechat outbound routes", () => {
  it("claims pending outbound messages for the bridge", async () => {
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));

    expect(response.status).toBe(200);
    const { messages } = await response.json();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ targetName: "张三", text: "请补充展位号", status: "sending" });
    expect(store.writeState).toHaveBeenCalledWith(store.state);
  });

  it("marks a claimed message as sent", async () => {
    const message = queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "已创建工单" });

    const response = await outboundResultRoute.PATCH(request({ status: "sent" }, { "x-mcp-secret": "bridge-secret" }), {
      params: Promise.resolve({ messageId: message.id })
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.[0].status).toBe("sent");
  });

  it("rejects bridge calls with a wrong secret", async () => {
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bad-secret" }));

    expect(response.status).toBe(401);
    expect(store.writeState).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run outbound route tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/api/wechat-outbound-route.test.ts
```

Expected: FAIL because the outbound routes do not exist.

- [ ] **Step 7: Implement outbound routes**

Create `src/app/api/integrations/wechat/outbound/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { claimPendingOutboundMessages } from "@/lib/services/outbound-message-service";
import { readState, writeState } from "@/lib/storage/file-store";

const claimSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) });

function isAuthorized(request: Request, stateSecretEnv = "WECHAT_MCP_SECRET") {
  const expected = process.env[stateSecretEnv];
  if (!expected) return true;
  const headerSecret = request.headers.get("x-mcp-secret") ?? request.headers.get("x-wechat-mcp-secret");
  const authorization = request.headers.get("authorization");
  const actual = headerSecret ?? (authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined);
  return actual === expected;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });
  let input: z.infer<typeof claimSchema>;
  try {
    input = claimSchema.parse(await parseJson(request));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const state = await readState();
  const messages = claimPendingOutboundMessages(state, { limit: input.limit });
  await writeState(state);
  return NextResponse.json({ messages });
}
```

Create `src/app/api/integrations/wechat/outbound/[messageId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { markOutboundMessageFailed, markOutboundMessageSent } from "@/lib/services/outbound-message-service";
import { readState, writeState } from "@/lib/storage/file-store";

const resultSchema = z.object({
  status: z.enum(["sent", "failed"]),
  error: z.string().optional()
});

function isAuthorized(request: Request, stateSecretEnv = "WECHAT_MCP_SECRET") {
  const expected = process.env[stateSecretEnv];
  if (!expected) return true;
  const headerSecret = request.headers.get("x-mcp-secret") ?? request.headers.get("x-wechat-mcp-secret");
  const authorization = request.headers.get("authorization");
  const actual = headerSecret ?? (authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined);
  return actual === expected;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  if (!isAuthorized(request)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });
  const { messageId } = await params;
  let input: z.infer<typeof resultSchema>;
  try {
    input = resultSchema.parse(await parseJson(request));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const state = await readState();
  const message = input.status === "sent"
    ? markOutboundMessageSent(state, messageId)
    : markOutboundMessageFailed(state, messageId, input.error ?? "发送失败");
  await writeState(state);
  return NextResponse.json({ message });
}
```

- [ ] **Step 8: Run outbound route tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/services/outbound-message-service.test.ts tests/api/wechat-outbound-route.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```powershell
git add src/lib/services/outbound-message-service.ts src/app/api/integrations/wechat/outbound tests/services/outbound-message-service.test.ts tests/api/wechat-outbound-route.test.ts
git commit -m "feat: add wechat outbound queue"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 3: WeChat Identity Registration

**Files:**
- Create: `src/lib/services/wechat-identity-service.ts`
- Test: `tests/services/wechat-identity-service.test.ts`

- [ ] **Step 1: Write failing identity service tests**

Create `tests/services/wechat-identity-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import {
  bindWechatIdentityFromRegistration,
  ensureConversationAndIdentity,
  identityPromptText,
  parseRegistrationCommand
} from "@/lib/services/wechat-identity-service";

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: {
      ...defaultConfig(),
      userGroups: [
        { id: "builder", name: "搭建组", description: "搭建", canClaim: true, canProcess: true, canAccept: false, enabled: true },
        { id: "business", name: "业务组", description: "业务", canClaim: false, canProcess: false, canAccept: true, enabled: true }
      ]
    }
  };
}

describe("wechat identity service", () => {
  it("parses registration commands", () => {
    expect(parseRegistrationCommand("注册 搭建组 张三 13800138000")).toEqual({
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });
    expect(parseRegistrationCommand("绑定 业务组 李四 13900139000")).toEqual({
      identityGroup: "业务组",
      name: "李四",
      phone: "13900139000"
    });
    expect(parseRegistrationCommand("A01 网络断了")).toBeUndefined();
  });

  it("creates conversation and chat identity from inbound message fields", () => {
    const appState = state();

    const result = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    expect(result.identity).toMatchObject({
      platform: "wechat",
      externalUserId: "wxid-zhangsan",
      displayName: "张三微信"
    });
    expect(result.conversation).toMatchObject({
      platform: "wechat",
      externalConversationId: "conv-builder",
      title: "搭建群"
    });
  });

  it("auto-registers and immediately binds a wechat identity", () => {
    const appState = state();
    const { identity } = ensureConversationAndIdentity(appState, {
      channel: "wechat",
      senderId: "wxid-zhangsan",
      senderName: "张三微信",
      senderGroup: "搭建群",
      sourceConversationId: "conv-builder"
    });

    const person = bindWechatIdentityFromRegistration(appState, identity.id, {
      identityGroup: "搭建组",
      name: "张三",
      phone: "13800138000"
    });

    expect(person).toMatchObject({
      name: "张三",
      phone: "13800138000",
      groupName: "搭建组",
      enabled: true
    });
    expect(appState.chatIdentities?.[0].personId).toBe(person.id);
  });

  it("returns a useful prompt for missing identity fields", () => {
    expect(identityPromptText(["identityGroup", "name", "phone"], ["搭建组", "业务组"])).toBe(
      "请补充身份组、真实姓名、手机号，例如：注册 搭建组 张三 13800138000。可选身份组：搭建组、业务组"
    );
  });
});
```

- [ ] **Step 2: Run identity tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/services/wechat-identity-service.test.ts
```

Expected: FAIL because `wechat-identity-service.ts` does not exist.

- [ ] **Step 3: Implement identity service**

Create `src/lib/services/wechat-identity-service.ts`:

```ts
import type { ChatIdentity, Conversation, MessageChannel, PendingWorkOrderField, Person } from "../domain/types";
import { userGroupsOf } from "../seed";
import type { AppState } from "../storage/file-store";

export type IdentitySource = {
  channel: MessageChannel;
  senderId?: string;
  senderName?: string;
  senderGroup?: string;
  sourceConversationId?: string;
};

export type RegistrationDraft = {
  identityGroup: string;
  name: string;
  phone: string;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function parseRegistrationCommand(text: string): RegistrationDraft | undefined {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(?:注册|绑定)\s+(\S+)\s+(\S+)\s+(1[3-9]\d{9})$/);
  if (!match) return undefined;
  return { identityGroup: match[1], name: match[2], phone: match[3] };
}

export function isValidPhone(phone: string) {
  return /^1[3-9]\d{9}$/.test(phone);
}

export function enabledIdentityGroups(state: AppState) {
  return userGroupsOf(state.config).filter((group) => group.enabled).map((group) => group.name);
}

export function ensureConversationAndIdentity(state: AppState, source: IdentitySource): { conversation: Conversation; identity: ChatIdentity } {
  state.conversations ??= [];
  state.chatIdentities ??= [];
  const timestamp = now();
  const externalConversationId = normalizeText(source.sourceConversationId) || normalizeText(source.senderGroup) || normalizeText(source.senderId) || normalizeText(source.senderName) || "unknown-conversation";
  const externalUserId = normalizeText(source.senderId) || normalizeText(source.senderName) || externalConversationId;
  let conversation = state.conversations.find((item) => item.platform === source.channel && item.externalConversationId === externalConversationId);
  if (!conversation) {
    conversation = {
      id: id("conversation"),
      platform: source.channel,
      type: source.senderGroup ? "group" : "direct",
      externalConversationId,
      title: normalizeText(source.senderGroup) || normalizeText(source.senderName) || "微信会话",
      linkedPersonIds: [],
      defaultNotify: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.conversations.push(conversation);
  } else {
    conversation.title = normalizeText(source.senderGroup) || conversation.title;
    conversation.updatedAt = timestamp;
  }

  let identity = state.chatIdentities.find((item) => item.platform === source.channel && item.externalUserId === externalUserId);
  if (!identity) {
    identity = {
      id: id("chat"),
      platform: source.channel,
      externalUserId,
      displayName: normalizeText(source.senderName) || "微信用户",
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    };
    state.chatIdentities.push(identity);
  } else {
    identity.displayName = normalizeText(source.senderName) || identity.displayName;
    identity.lastSeenAt = timestamp;
  }

  return { conversation, identity };
}

export function bindWechatIdentityFromRegistration(state: AppState, chatIdentityId: string, draft: RegistrationDraft): Person {
  const groups = enabledIdentityGroups(state);
  if (!groups.includes(draft.identityGroup)) throw new Error(`身份组不存在：${draft.identityGroup}`);
  if (!draft.name.trim()) throw new Error("真实姓名不能为空");
  if (!isValidPhone(draft.phone)) throw new Error("手机号格式不正确");

  state.people ??= [];
  state.chatIdentities ??= [];
  const timestamp = now();
  const identity = state.chatIdentities.find((item) => item.id === chatIdentityId);
  if (!identity) throw new Error("微信身份不存在");

  let person = state.people.find((item) => item.phone === draft.phone);
  if (!person) {
    person = {
      id: `person-${crypto.randomUUID()}`,
      name: draft.name,
      phone: draft.phone,
      role: draft.identityGroup === "业务组" ? "manager" : "handler",
      groupName: draft.identityGroup,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.people.push(person);
  } else {
    person.name = draft.name;
    person.groupName = draft.identityGroup;
    person.enabled = true;
    person.updatedAt = timestamp;
  }

  identity.personId = person.id;
  identity.verifiedBy = "phone";
  identity.verifiedAt = timestamp;
  identity.lastSeenAt = timestamp;
  for (const conversation of state.conversations ?? []) {
    if (!conversation.linkedPersonIds.includes(person.id)) {
      conversation.linkedPersonIds.push(person.id);
      conversation.updatedAt = timestamp;
    }
  }

  return person;
}

export function missingIdentityFields(draft: Partial<RegistrationDraft>): PendingWorkOrderField[] {
  const fields: PendingWorkOrderField[] = [];
  if (!draft.identityGroup) fields.push("identityGroup");
  if (!draft.name) fields.push("name");
  if (!draft.phone) fields.push("phone");
  return fields;
}

export function identityPromptText(fields: PendingWorkOrderField[], groups: string[]) {
  const labels = fields
    .filter((field) => ["identityGroup", "name", "phone"].includes(field))
    .map((field) => field === "identityGroup" ? "身份组" : field === "name" ? "真实姓名" : "手机号");
  const uniqueLabels = Array.from(new Set(labels));
  const groupText = groups.length ? `。可选身份组：${groups.join("、")}` : "";
  return `请补充${uniqueLabels.join("、")}，例如：注册 搭建组 张三 13800138000${groupText}`;
}
```

- [ ] **Step 4: Run identity tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/services/wechat-identity-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```powershell
git add src/lib/services/wechat-identity-service.ts tests/services/wechat-identity-service.test.ts
git commit -m "feat: add wechat identity registration"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 4: Watchtower Orchestration Service

**Files:**
- Create: `src/lib/services/wechat-watchtower-service.ts`
- Modify: `src/lib/services/message-intake-service.ts`
- Test: `tests/services/wechat-watchtower-service.test.ts`

- [ ] **Step 1: Write failing watchtower service tests**

Create `tests/services/wechat-watchtower-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import { processWechatWatchtowerMessage } from "@/lib/services/wechat-watchtower-service";

function state(): AppState {
  return {
    booths: [
      { boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }
    ],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: {
      ...defaultConfig(),
      messageIntegrations: [
        { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
      ],
      userGroups: [
        { id: "builder", name: "搭建组", description: "搭建", canClaim: true, canProcess: true, canAccept: false, enabled: true },
        { id: "business", name: "业务组", description: "业务", canClaim: false, canProcess: false, canAccept: true, enabled: true }
      ]
    }
  };
}

describe("wechat watchtower service", () => {
  it("silently records ordinary chat from an unknown user", async () => {
    const appState = state();

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-chat-1",
      senderId: "wxid-1",
      senderName: "路人甲",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "大家辛苦了"
    });

    expect(result.action).toBe("ignored");
    expect(appState.messageRecords).toHaveLength(1);
    expect(appState.outboundMessages).toEqual([]);
  });

  it("prompts an unknown user to register before processing an operational request", async () => {
    const appState = state();

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01 网络断了，扫码收款失败"
    });

    expect(result.action).toBe("prompted");
    expect(appState.pendingWorkOrderSessions).toHaveLength(1);
    expect(appState.pendingWorkOrderSessions?.[0].missingFields).toEqual(["identityGroup", "name", "phone"]);
    expect(appState.outboundMessages?.[0].text).toContain("请补充身份组、真实姓名、手机号");
  });

  it("registers from command and continues the pending request", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01 网络断了，扫码收款失败"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-1",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 张三 13800138000"
    });

    expect(result.action).toBe("processed");
    expect(appState.people).toHaveLength(1);
    expect(appState.tickets).toHaveLength(1);
    expect(appState.tickets[0]).toMatchObject({ boothNumber: "A01", issueType: "网络", submitterName: "张三" });
    expect(appState.outboundMessages?.some((message) => message.text.includes("已创建工单"))).toBe(true);
  });

  it("prompts a registered user for missing booth number", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-2",
      senderId: "wxid-3",
      senderName: "李四微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 李四 13900139000"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-missing-booth",
      senderId: "wxid-3",
      senderName: "李四微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "这里没电了，麻烦处理"
    });

    expect(result.action).toBe("prompted");
    expect(appState.pendingWorkOrderSessions?.at(-1)?.missingFields).toContain("boothNumber");
    expect(appState.outboundMessages?.at(-1)?.text).toContain("请补充展位号");
  });
});
```

- [ ] **Step 2: Run watchtower tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/services/wechat-watchtower-service.test.ts
```

Expected: FAIL because `wechat-watchtower-service.ts` does not exist.

- [ ] **Step 3: Add duplicate short-circuit to message intake**

Modify `src/lib/services/message-intake-service.ts` inside `recordMessage` before analysis:

```ts
      if (input.externalMessageId) {
        const existing = state.messageRecords.find((record) => record.channel === input.channel && record.externalMessageId === input.externalMessageId);
        if (existing) return existing;
      }
```

Include `raw` when building `record` if Task 1 added it to `IntakeMessageInput`:

```ts
        raw: input.raw,
```

- [ ] **Step 4: Implement watchtower service**

Create `src/lib/services/wechat-watchtower-service.ts`:

```ts
import type { InboundMessageRecord, PendingWorkOrderField, PendingWorkOrderSession } from "../domain/types";
import type { AppState } from "../storage/file-store";
import { analyzeIntakeMessage, createMessageIntakeService, type IntakeMessageInput } from "./message-intake-service";
import { queueOutboundMessage, queueProcessingGroupMessage, queueTicketFeedbackMessage } from "./outbound-message-service";
import {
  bindWechatIdentityFromRegistration,
  enabledIdentityGroups,
  ensureConversationAndIdentity,
  identityPromptText,
  parseRegistrationCommand
} from "./wechat-identity-service";

export type WatchtowerAction = "ignored" | "prompted" | "registered" | "processed" | "duplicate";

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function normalizeText(value?: string) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isOperationalText(text: string, imageUrls: string[] = []) {
  const normalized = normalizeText(text).toLowerCase();
  const keywords = ["报修", "故障", "处理", "需要", "不能", "无法", "没有", "坏", "断", "催", "加急", "尽快", "失败", "不亮", "漏水", "跳闸", "网络", "断网", "没电", "桌", "椅", "搭建"];
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase())) || (imageUrls.length > 0 && normalized.length > 0);
}

function messageTargetName(input: IntakeMessageInput) {
  return input.senderGroup || input.senderName || "微信会话";
}

function activeSessionFor(state: AppState, chatIdentityId: string) {
  return state.pendingWorkOrderSessions?.find((session) => session.chatIdentityId === chatIdentityId);
}

function createPromptSession(
  state: AppState,
  input: IntakeMessageInput,
  conversationId: string,
  chatIdentityId: string,
  missingFields: PendingWorkOrderField[],
  originalMessageRecordId?: string
) {
  state.pendingWorkOrderSessions ??= [];
  const timestamp = now();
  const session: PendingWorkOrderSession = {
    id: id("pending"),
    platform: input.channel,
    conversationId,
    chatIdentityId,
    originalMessageRecordId,
    draftText: normalizeText(input.text),
    draftImages: input.imageUrls ?? [],
    missingFields,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastPromptAt: timestamp
  };
  state.pendingWorkOrderSessions.push(session);
  return session;
}

function removeSession(state: AppState, sessionId: string) {
  state.pendingWorkOrderSessions = (state.pendingWorkOrderSessions ?? []).filter((session) => session.id !== sessionId);
}

function boothPromptText() {
  return "请补充展位号，例如：A01 网络断了，扫码收款失败";
}

function issuePromptText(state: AppState) {
  const issueTypes = state.config.issueTypes.filter((item) => item.enabled).map((item) => item.name).join("、");
  return `请补充问题类型。可选类型：${issueTypes}`;
}

async function recordRawMessage(state: AppState, input: IntakeMessageInput) {
  return createMessageIntakeService({ state }).recordMessage(input);
}

async function processCompleteRequest(state: AppState, input: IntakeMessageInput, personId?: string, chatIdentityId?: string, conversationId?: string) {
  const person = state.people?.find((item) => item.id === personId);
  const record = await createMessageIntakeService({ state }).recordMessage({
    ...input,
    senderName: person?.name ?? input.senderName,
    senderPhone: person?.phone ?? input.senderPhone,
    reporterPersonId: person?.id,
    reporterChatIdentityId: chatIdentityId,
    sourceConversationId: conversationId
  });

  if (record.analysis.matchedTicketId) {
    const ticket = state.tickets.find((item) => item.id === record.analysis.matchedTicketId);
    if (ticket) {
      const feedbackText = record.analysis.suggestedAction === "urge-existing"
        ? `已关联已有工单并催单：${ticket.title}\n当前催单次数：${ticket.urgeCount}`
        : `已创建工单：${ticket.title}\n展位：${ticket.boothNumber}\n类型：${ticket.issueType}\n当前状态：${ticket.status}`;
      queueTicketFeedbackMessage(state, ticket, feedbackText);
      if (record.analysis.suggestedAction === "create-ticket") {
        queueProcessingGroupMessage(state, ticket, `新工单：${ticket.title}\n${ticket.description}`);
      }
    }
  }

  return record;
}

export async function processWechatWatchtowerMessage(state: AppState, input: IntakeMessageInput): Promise<{ action: WatchtowerAction; record?: InboundMessageRecord }> {
  if (input.externalMessageId && state.messageRecords.some((record) => record.channel === input.channel && record.externalMessageId === input.externalMessageId)) {
    return { action: "duplicate" };
  }

  const { conversation, identity } = ensureConversationAndIdentity(state, {
    channel: input.channel,
    senderId: input.senderId,
    senderName: input.senderName,
    senderGroup: input.senderGroup,
    sourceConversationId: input.sourceConversationId
  });
  const registration = parseRegistrationCommand(input.text ?? "");
  const session = activeSessionFor(state, identity.id);

  if (registration) {
    const person = bindWechatIdentityFromRegistration(state, identity.id, registration);
    queueOutboundMessage(state, {
      channel: input.channel,
      targetConversationId: conversation.externalConversationId,
      targetChatIdentityId: identity.id,
      targetName: messageTargetName(input),
      text: `${person.name}已注册并绑定：${person.groupName} ${person.phone}`,
      relatedSessionId: session?.id
    });

    if (session) {
      removeSession(state, session.id);
      const record = await processCompleteRequest(state, {
        ...input,
        text: session.draftText,
        imageUrls: session.draftImages
      }, person.id, identity.id, conversation.externalConversationId);
      return { action: "processed", record };
    }

    const record = await recordRawMessage(state, input);
    return { action: "registered", record };
  }

  const identityPerson = identity.personId ? state.people?.find((person) => person.id === identity.personId) : undefined;
  const imageUrls = input.imageUrls ?? [];
  const operational = isOperationalText(input.text ?? "", imageUrls);

  if (!identityPerson && operational) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["identityGroup", "name", "phone"], record.id);
    queueOutboundMessage(state, {
      channel: input.channel,
      targetConversationId: conversation.externalConversationId,
      targetChatIdentityId: identity.id,
      targetName: messageTargetName(input),
      text: identityPromptText(promptSession.missingFields, enabledIdentityGroups(state)),
      relatedSessionId: promptSession.id
    });
    return { action: "prompted", record };
  }

  if (!operational && !session) {
    const record = await recordRawMessage(state, input);
    return { action: "ignored", record };
  }

  const analysis = await analyzeIntakeMessage(state, { ...input, channel: input.channel });
  if (!analysis.boothNumber) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["boothNumber"], record.id);
    queueOutboundMessage(state, {
      channel: input.channel,
      targetConversationId: conversation.externalConversationId,
      targetChatIdentityId: identity.id,
      targetName: messageTargetName(input),
      text: boothPromptText(),
      relatedSessionId: promptSession.id
    });
    return { action: "prompted", record };
  }

  if (!analysis.issueType) {
    const record = await recordRawMessage(state, input);
    const promptSession = createPromptSession(state, input, conversation.id, identity.id, ["issueType"], record.id);
    queueOutboundMessage(state, {
      channel: input.channel,
      targetConversationId: conversation.externalConversationId,
      targetChatIdentityId: identity.id,
      targetName: messageTargetName(input),
      text: issuePromptText(state),
      relatedSessionId: promptSession.id
    });
    return { action: "prompted", record };
  }

  const record = await processCompleteRequest(state, input, identityPerson?.id, identity.id, conversation.externalConversationId);
  return { action: "processed", record };
}
```

- [ ] **Step 5: Run watchtower tests and adjust only to satisfy tested behavior**

Run:

```powershell
npm run test:run -- tests/services/wechat-watchtower-service.test.ts
```

Expected: PASS. If TypeScript reports missing `raw` on `IntakeMessageInput`, add:

```ts
  raw?: Record<string, unknown>;
```

to `IntakeMessageInput` in `src/lib/services/message-intake-service.ts`.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/lib/services/wechat-watchtower-service.ts src/lib/services/message-intake-service.ts tests/services/wechat-watchtower-service.test.ts
git commit -m "feat: add wechat watchtower orchestration"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 5: Wire Inbound API To Watchtower

**Files:**
- Modify: `src/app/api/integrations/wechat/messages/route.ts`
- Modify: `tests/api/message-intake-route.test.ts`

- [ ] **Step 1: Add failing API tests for registration and prompting**

Append to `tests/api/message-intake-route.test.ts`:

```ts
  it("prompts unknown WeChat users to register before creating a ticket", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
    ];

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-1",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "A01 网络断了，扫码收款失败"
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("prompted");
    expect(store.state?.pendingWorkOrderSessions).toHaveLength(1);
    expect(store.state?.outboundMessages?.at(-1)?.text).toContain("请补充身份组、真实姓名、手机号");
  });

  it("registers a WeChat user and resumes the pending ticket request", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
    ];

    await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-2",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "A01 网络断了，扫码收款失败"
    }));

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-3",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "注册 搭建组 张三 13800138000"
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("processed");
    expect(store.state?.people).toHaveLength(1);
    expect(store.state?.tickets).toHaveLength(1);
    expect(store.state?.outboundMessages?.some((message) => message.text.includes("已创建工单"))).toBe(true);
  });
```

- [ ] **Step 2: Run the API tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/api/message-intake-route.test.ts
```

Expected: FAIL because the route still calls `createMessageIntakeService` directly.

- [ ] **Step 3: Normalize extra wxauto fields in the route**

Modify `normalizePayload` in `src/app/api/integrations/wechat/messages/route.ts`:

```ts
    sourceConversationId: pickString(record, ["sourceConversationId", "conversationId", "chatId", "roomId"]),
    raw: record.raw && typeof record.raw === "object" ? record.raw as Record<string, unknown> : undefined
```

- [ ] **Step 4: Call the watchtower service from the route**

Replace the final direct intake call in `POST`:

```ts
  const result = await processWechatWatchtowerMessage(state, body);
  await writeState(state);
  return NextResponse.json(result);
```

Update imports:

```ts
import { processWechatWatchtowerMessage } from "@/lib/services/wechat-watchtower-service";
```

Remove the unused `createMessageIntakeService` import.

- [ ] **Step 5: Run inbound API tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/api/message-intake-route.test.ts tests/services/wechat-watchtower-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/app/api/integrations/wechat/messages/route.ts tests/api/message-intake-route.test.ts
git commit -m "feat: route wechat intake through watchtower"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 6: Ticket Lifecycle WeChat Notifications

**Files:**
- Modify: `src/app/api/tickets/[ticketId]/route.ts`
- Modify: `src/app/api/tickets/[ticketId]/replies/route.ts`
- Modify: `tests/api/ticket-actions-route.test.ts`

- [ ] **Step 1: Add failing lifecycle notification tests**

Append to `tests/api/ticket-actions-route.test.ts`:

```ts
  it("queues a WeChat completion receipt when resolving a ticket from WeChat", async () => {
    store.state!.outboundMessages = [];
    store.state!.tickets[0] = {
      ...ticket,
      status: "处理中",
      handlerId: "member-13700137000",
      handlerName: "搭建王工",
      reporterChatIdentityId: "chat-1",
      sourceConversationId: "conv-site"
    };

    const response = await patch({
      action: "progress",
      status: "已解决",
      actorId: "member-13700137000",
      actorName: "搭建王工",
      actorGroupName: "搭建组",
      processBody: "已加固门头并复核稳定性",
      imageUrls: ["data:image/jpeg;base64,abc"]
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.at(-1)).toMatchObject({
      targetConversationId: "conv-site",
      relatedTicketId: "ticket-1",
      status: "pending"
    });
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("工单已解决");
  });

  it("queues a WeChat close receipt when accepting a ticket", async () => {
    store.state!.outboundMessages = [];
    store.state!.tickets[0] = {
      ...ticket,
      status: "已解决",
      reporterChatIdentityId: "chat-1",
      sourceConversationId: "conv-site"
    };

    const response = await patch({
      action: "accept",
      status: "已关闭",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组"
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("工单已关闭");
  });
```

- [ ] **Step 2: Run lifecycle tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/api/ticket-actions-route.test.ts
```

Expected: FAIL because ticket actions do not enqueue outbound messages.

- [ ] **Step 3: Queue notifications in ticket action route**

Import helper:

```ts
import { queueTicketFeedbackMessage } from "@/lib/services/outbound-message-service";
```

After timeline updates and before `writeState(state)` in `PATCH`, add:

```ts
  if (ticket.reporterChatIdentityId || ticket.sourceConversationId) {
    if (input.action === "progress" && input.status === "已解决") {
      queueTicketFeedbackMessage(state, ticket, `工单已解决：${ticket.title}\n处理说明：${input.processBody?.trim()}`);
    }
    if (input.action === "accept" && input.status === "已关闭") {
      queueTicketFeedbackMessage(state, ticket, `工单已关闭：${ticket.title}\n感谢反馈，处理已闭环。`);
    }
    if (input.action === "reject" && input.status === "待再次处理") {
      queueTicketFeedbackMessage(state, ticket, `工单验收未通过，已退回处理：${ticket.title}\n原因：${input.reason?.trim()}`);
    }
  }
```

- [ ] **Step 4: Fix mojibake while editing replies route**

In `src/app/api/tickets/[ticketId]/replies/route.ts`, replace the two mojibake strings:

```ts
    if (!parsed.success) return badRequest("回复参数无效", parsed.error.flatten());
```

and:

```ts
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
```

- [ ] **Step 5: Run lifecycle tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/api/ticket-actions-route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```powershell
git add src/app/api/tickets/[ticketId]/route.ts src/app/api/tickets/[ticketId]/replies/route.ts tests/api/ticket-actions-route.test.ts
git commit -m "feat: queue wechat ticket lifecycle receipts"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 7: Bidirectional wxauto Bridge

**Files:**
- Modify: `scripts/wxauto-rest-bridge.mjs`
- Create: `tests/scripts/wxauto-rest-bridge.test.ts`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add failing bridge helper tests**

Create `tests/scripts/wxauto-rest-bridge.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

// @ts-ignore importing the local ESM bridge script is intentional for script helper tests.
const bridge = await import("../../scripts/wxauto-rest-bridge.mjs");

describe("wxauto rest bridge helpers", () => {
  it("maps outbound messages to wxauto send payloads", () => {
    expect(bridge.mapOutboundToWxautoSend({
      id: "outbound-1",
      targetName: "现场群",
      text: "请补充展位号"
    })).toEqual({
      who: "现场群",
      msg: "请补充展位号",
      clear: true,
      exact: false
    });
  });

  it("sends outbound messages and marks them sent", async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} })
      };
    });

    await bridge.sendOutboundMessage({
      message: { id: "outbound-1", targetName: "现场群", text: "已创建工单" },
      fetchImpl,
      config: {
        wxautoBaseUrl: "http://127.0.0.1:8001",
        wxautoToken: "token",
        intakeSecret: "secret",
        outboundUrl: "http://127.0.0.1:3000/api/integrations/wechat/outbound",
        requestTimeoutMs: 1000
      }
    });

    expect(calls[0].url).toBe("http://127.0.0.1:8001/v1/wechat/send");
    expect(calls[1].url).toBe("http://127.0.0.1:3000/api/integrations/wechat/outbound/outbound-1");
  });
});
```

- [ ] **Step 2: Include script tests in Vitest**

Modify `vitest.config.ts`:

```ts
include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "tests/**/*.test.mjs"]
```

- [ ] **Step 3: Run bridge tests to verify they fail**

Run:

```powershell
npm run test:run -- tests/scripts/wxauto-rest-bridge.test.ts
```

Expected: FAIL because the bridge script does not export `mapOutboundToWxautoSend` or `sendOutboundMessage`.

- [ ] **Step 4: Refactor bridge script for exports and main guard**

At the top of `scripts/wxauto-rest-bridge.mjs`, add:

```js
import { pathToFileURL } from "node:url";
```

Add config fields:

```js
  outboundUrl: process.env.OUTBOUND_URL ?? "http://127.0.0.1:3000/api/integrations/wechat/outbound",
  outboundPollIntervalMs: Number.parseInt(process.env.BRIDGE_OUTBOUND_POLL_INTERVAL_MS ?? "1500", 10),
```

Export helper functions:

```js
export function mapOutboundToWxautoSend(message) {
  return {
    who: message.targetName,
    msg: message.text,
    clear: true,
    exact: false
  };
}

export async function sendOutboundMessage({ message, fetchImpl = fetch, config: runtimeConfig = config }) {
  const sendResponse = await fetchImpl(`${runtimeConfig.wxautoBaseUrl}/v1/wechat/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtimeConfig.wxautoToken}`
    },
    body: JSON.stringify(mapOutboundToWxautoSend(message))
  });
  const sendBody = await sendResponse.json().catch(() => ({}));
  const status = sendResponse.ok && sendBody?.success !== false ? "sent" : "failed";
  const error = status === "failed" ? sendBody?.message ?? `HTTP ${sendResponse.status}` : undefined;

  await fetchImpl(`${runtimeConfig.outboundUrl}/${message.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(runtimeConfig.intakeSecret ? { "x-mcp-secret": runtimeConfig.intakeSecret } : {})
    },
    body: JSON.stringify({ status, error })
  });

  if (status === "failed") throw new Error(`outbound send failed: ${error}`);
}

export async function pullOutboundMessages(fetchImpl = fetch, runtimeConfig = config) {
  const response = await fetchImpl(runtimeConfig.outboundUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(runtimeConfig.intakeSecret ? { "x-mcp-secret": runtimeConfig.intakeSecret } : {})
    },
    body: JSON.stringify({ limit: 10 })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`outbound claim failed: HTTP ${response.status}`);
  return Array.isArray(body.messages) ? body.messages : [];
}
```

Change the final call:

```js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bridge] fatal: ${message}`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Add outbound loop in main**

Inside `main()`, before the `while (true)` loop:

```js
  let lastOutboundPollAt = 0;
```

Inside the loop, after inbound message processing:

```js
      if (!config.dryRun && Date.now() - lastOutboundPollAt >= config.outboundPollIntervalMs) {
        lastOutboundPollAt = Date.now();
        const outboundMessages = await pullOutboundMessages();
        for (const message of outboundMessages) {
          await sendOutboundMessage({ message });
          console.log(`[bridge] sent outbound ${message.id} (${message.targetName})`);
        }
      }
```

In dry-run mode, log outbound messages but do not call wxauto send:

```js
      if (config.dryRun && Date.now() - lastOutboundPollAt >= config.outboundPollIntervalMs) {
        lastOutboundPollAt = Date.now();
        const outboundMessages = await pullOutboundMessages();
        for (const message of outboundMessages) {
          console.log(`[dry-run-outbound] ${JSON.stringify(message)}`);
        }
      }
```

- [ ] **Step 6: Run bridge tests to verify they pass**

Run:

```powershell
npm run test:run -- tests/scripts/wxauto-rest-bridge.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```powershell
git add scripts/wxauto-rest-bridge.mjs tests/scripts/wxauto-rest-bridge.test.ts vitest.config.ts
git commit -m "feat: send outbound wechat messages from bridge"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 8: Admin Visibility And Documentation

**Files:**
- Modify: `src/app/api/bootstrap/route.ts`
- Modify: `src/components/admin-panel.tsx`
- Modify: `docs/wxauto-rest-bridge-trial.md`
- Modify: `README.md`
- Modify: `deploy/windows/app.env.sample.ps1`
- Test: `tests/app/page-navigation.test.tsx` or existing admin tests if they cover bootstrap data

- [ ] **Step 1: Include watchtower collections in bootstrap**

Modify `src/app/api/bootstrap/route.ts`:

```ts
    people: state.people ?? [],
    chatIdentities: state.chatIdentities ?? [],
    conversations: state.conversations ?? [],
    pendingWorkOrderSessions: state.pendingWorkOrderSessions ?? [],
    outboundMessages: state.outboundMessages ?? [],
```

- [ ] **Step 2: Update AdminPanel props and rendering**

Modify the `AdminPanel` props type in `src/components/admin-panel.tsx`:

```ts
export function AdminPanel({
  config,
  messageRecords = [],
  tickets = [],
  people = [],
  chatIdentities = [],
  pendingWorkOrderSessions = [],
  outboundMessages = [],
  onRefresh
}: {
  config: AppConfig;
  messageRecords?: InboundMessageRecord[];
  tickets?: Ticket[];
  people?: Person[];
  chatIdentities?: ChatIdentity[];
  pendingWorkOrderSessions?: PendingWorkOrderSession[];
  outboundMessages?: OutboundMessage[];
  onRefresh: () => void;
}) {
```

Add imports:

```ts
import type { ChatIdentity, InboundMessageRecord, OutboundMessage, PendingWorkOrderSession, Person, Ticket } from "@/lib/domain/types";
```

Add three sections near the existing 微信/企微消息 section:

```tsx
      <div className="config-list">
        <h3>微信身份绑定</h3>
        <div className="message-record-list">
          {chatIdentities.length === 0 && <p className="config-lock-note">暂未识别微信身份。</p>}
          {chatIdentities.slice(0, 8).map((identity) => {
            const person = people.find((item) => item.id === identity.personId);
            return (
              <article key={identity.id} className="message-record-card">
                <div className="message-record-head">
                  <strong>{identity.displayName}</strong>
                  <span>{person ? "已绑定" : "未绑定"}</span>
                </div>
                <p className="message-record-summary">{person ? `${person.groupName} · ${person.name} · ${person.phone}` : identity.externalUserId}</p>
              </article>
            );
          })}
        </div>
      </div>
      <div className="config-list">
        <h3>追问会话</h3>
        <div className="message-record-list">
          {pendingWorkOrderSessions.length === 0 && <p className="config-lock-note">暂无追问中的微信会话。</p>}
          {pendingWorkOrderSessions.slice(0, 8).map((session) => (
            <article key={session.id} className="message-record-card">
              <div className="message-record-head">
                <strong>{session.missingFields.join("、")}</strong>
                <span>{shortDateTime(session.updatedAt)}</span>
              </div>
              <p>{session.draftText || "图片诉求"}</p>
            </article>
          ))}
        </div>
      </div>
      <div className="config-list">
        <h3>出站通知</h3>
        <div className="message-record-list">
          {outboundMessages.length === 0 && <p className="config-lock-note">暂无微信出站通知。</p>}
          {outboundMessages.slice(0, 8).map((message) => (
            <article key={message.id} className="message-record-card">
              <div className="message-record-head">
                <strong>{message.targetName}</strong>
                <span>{message.status}</span>
              </div>
              <p>{message.text}</p>
              {message.lastError && <small>{message.lastError}</small>}
            </article>
          ))}
        </div>
      </div>
```

- [ ] **Step 3: Pass bootstrap data from page**

Modify the `Bootstrap` type and admin render in `src/app/page.tsx`:

```ts
type Bootstrap = {
  tickets: Ticket[];
  config: AppConfig;
  messageRecords: InboundMessageRecord[];
  people: Person[];
  chatIdentities: ChatIdentity[];
  pendingWorkOrderSessions: PendingWorkOrderSession[];
  outboundMessages: OutboundMessage[];
};
```

Pass props:

```tsx
<AdminPanel
  config={data.config}
  messageRecords={data.messageRecords}
  tickets={data.tickets}
  people={data.people}
  chatIdentities={data.chatIdentities}
  pendingWorkOrderSessions={data.pendingWorkOrderSessions}
  outboundMessages={data.outboundMessages}
  onRefresh={refresh}
/>
```

- [ ] **Step 4: Update deployment env sample**

Append to `deploy/windows/app.env.sample.ps1`:

```powershell
# wxauto REST bridge settings.
# $env:WXAUTO_REST_BASE_URL = "http://127.0.0.1:8001"
# $env:WXAUTO_REST_TOKEN = "replace-with-wxauto-token"
# $env:INTAKE_URL = "http://127.0.0.1:3000/api/integrations/wechat/messages"
# $env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
# $env:INTAKE_SECRET = "replace-with-wechat-secret"
```

- [ ] **Step 5: Update wxauto bridge docs**

In `docs/wxauto-rest-bridge-trial.md`, add a “完整值守” section:

```md
## 完整值守模式

完整值守模式会同时执行：

1. 从 wxauto REST 拉取所有新微信消息。
2. 转发到 `/api/integrations/wechat/messages`。
3. 从 `/api/integrations/wechat/outbound` 拉取待发通知。
4. 调用 wxauto `/v1/wechat/send` 回发微信。
5. 回调系统标记发送成功或失败。

新增环境变量：

```powershell
$env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
$env:BRIDGE_OUTBOUND_POLL_INTERVAL_MS = "1500"
```

注册格式：

```text
注册 搭建组 张三 13800138000
```
```

- [ ] **Step 6: Run focused app tests**

Run:

```powershell
npm run test:run -- tests/components/admin-panel.test.tsx tests/app/page-navigation.test.tsx
```

Expected: PASS. If existing tests do not cover the new props, add default empty arrays in `AdminPanel` so existing renders still pass.

- [ ] **Step 7: Commit**

Run:

```powershell
git add src/app/api/bootstrap/route.ts src/app/page.tsx src/components/admin-panel.tsx docs/wxauto-rest-bridge-trial.md README.md deploy/windows/app.env.sample.ps1
git commit -m "docs: document wxauto watchtower operations"
```

If `git` is unavailable, record that the commit was skipped and continue.

## Task 9: Full Verification

**Files:**
- No code edits expected.

- [ ] **Step 1: Run the full test suite**

Run:

```powershell
npm run test:run
```

Expected: all tests pass. Do not continue while any test is failing.

- [ ] **Step 2: Run the production build**

Run:

```powershell
npm run build
```

Expected: Next.js production build completes without TypeScript or route errors.

- [ ] **Step 3: Run bridge dry-run in one terminal**

Set environment variables:

```powershell
$env:WXAUTO_REST_BASE_URL = "http://127.0.0.1:8001"
$env:WXAUTO_REST_TOKEN = "token"
$env:INTAKE_URL = "http://127.0.0.1:3000/api/integrations/wechat/messages"
$env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
$env:INTAKE_SECRET = "replace-with-secret"
$env:BRIDGE_DRY_RUN = "true"
npm run bridge:wxauto
```

Expected: inbound messages print as `[dry-run] ...`; outbound messages print as `[dry-run-outbound] ...`; no actual WeChat send occurs.

- [ ] **Step 4: Manual acceptance path**

With the app and wxauto REST service running:

1. Enable 微信 MCP in the admin page.
2. Set `WECHAT_MCP_SECRET` and matching `INTAKE_SECRET`.
3. Send ordinary chat from WeChat, for example `大家辛苦了`.
4. Confirm the message is recorded and no outbound reply is queued.
5. Send `A01 网络断了，扫码收款失败` from an unknown WeChat user.
6. Confirm the system queues a registration prompt.
7. Send `注册 搭建组 张三 13800138000`.
8. Confirm the system creates a `Person`, binds the chat identity, creates the ticket, and queues feedback.
9. Resolve the ticket from the app.
10. Confirm the system queues a solved receipt for WeChat.

- [ ] **Step 5: Final commit or working note**

Run:

```powershell
git status --short
git add src tests docs deploy scripts vitest.config.ts README.md
git commit -m "feat: add wxauto watchtower integration"
```

If `git` is unavailable, note the exact verification commands that passed and the files changed.

## Self-Review Checklist

Spec coverage:

- Listens to all WeChat messages: Task 7 keeps `getnextnewmessage` polling without a whitelist.
- System-side filtering: Task 4 implements `isOperationalText` and silent record behavior.
- Auto registration and binding: Task 3 and Task 4.
- Follow-up prompts: Task 4.
- Auto ticket creation and urging: Task 4 reuses `message-intake-service` with `autoCreateTickets`.
- Outbound notification queue: Task 2.
- Ticket solve and close receipts: Task 6.
- Admin visibility: Task 8.
- Bridge send-back: Task 7.
- Verification: Task 9.

Placeholder scan:

- This plan avoids empty instruction language.
- Each code-changing task includes exact files, concrete snippets, and commands.

Type consistency:

- `OutboundMessage` is defined in Task 1 and consumed by Tasks 2, 7, and 8.
- `identityGroup` is added to `PendingWorkOrderField` in Task 1 and used by Tasks 3 and 4.
- `sourceConversationId` is preserved from intake through ticket notification targets.
