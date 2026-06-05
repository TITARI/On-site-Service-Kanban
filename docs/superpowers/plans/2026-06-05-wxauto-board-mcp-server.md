# wxauto Board MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standard Streamable HTTP MCP server, reliable wxauto agent/message lease storage, compatibility HTTP adapters, agent visibility, and board-hosted desktop update distribution.

**Architecture:** The Next.js board remains the owner of all WeChat business logic. A new `src/lib/integrations/wxauto` boundary exposes typed contracts and one shared integration service; the standard MCP route and legacy HTTP routes are thin adapters over that service. MariaDB stores agent health, event receipts, outbound leases/attempts, and update releases.

**Tech Stack:** Next.js 16, TypeScript 6, React 19, MariaDB 11, Vitest 4, Zod 4, `@modelcontextprotocol/sdk@1.29.0`

---

## Execution Order

Complete this plan before starting `docs/superpowers/plans/2026-06-05-wxauto-desktop-app.md`. The desktop plan depends on the schemas and tool results defined here.

The current board directory is not a Git repository. Task 1 creates a source baseline so the remaining tasks can use reviewable commits.

## File Structure

### New Integration Boundary

- `src/lib/integrations/wxauto/contracts.ts`: Zod input/output schemas shared by tools and HTTP adapters.
- `src/lib/integrations/wxauto/auth.ts`: bearer-token authentication adapter, ready to be replaced by OAuth later.
- `src/lib/integrations/wxauto/service.ts`: transport-independent agent, event, claim, and completion operations.
- `src/lib/integrations/wxauto/mcp-server.ts`: MCP tool registration only.
- `src/lib/integrations/wxauto/update-service.ts`: release publishing, manifest signing, and download lookup.

### New Routes and UI

- `src/app/api/mcp/route.ts`: stateless Streamable HTTP MCP endpoint.
- `src/app/api/admin/wxauto-updates/route.ts`: publish/list releases using a dedicated publish token.
- `src/app/api/updates/wxauto/latest/route.ts`: public signed update manifest.
- `src/app/api/updates/wxauto/[version]/download/route.ts`: installer download.
- `src/components/admin/wxauto-agent-panel.tsx`: connected-agent health view.
- `src/components/admin/wxauto-update-panel.tsx`: update publishing view.

### Database

- `db/migrations/003_wxauto_mcp.sql`: agents, receipts, leases, attempts, and releases.

## Task 1: Establish the Board Baseline and MCP Dependency

**Files:**
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Extend `.gitignore` before initializing Git**

Add these entries:

```gitignore
.superpowers/
.codex-*.log
release/
*.zip
logs/
```

- [ ] **Step 2: Initialize the source repository and create a baseline commit**

Run:

```powershell
git init
git add .gitignore package.json package-lock.json next.config.ts tsconfig.json vitest.config.ts README.md start-external.cmd start-external.ps1
git add src tests scripts db docs
git commit -m "chore: establish board source baseline"
```

Expected: one root commit containing source and tests, without `node_modules`, release archives, local data, logs, or secrets.

- [ ] **Step 3: Install the stable MCP SDK**

Run:

```powershell
npm.cmd install @modelcontextprotocol/sdk@1.29.0
```

Expected: `package.json` and `package-lock.json` contain `@modelcontextprotocol/sdk`.

- [ ] **Step 4: Run the existing suite before feature work**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
```

Expected: both commands pass before MCP changes begin.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore package.json package-lock.json
git commit -m "build: add stable MCP SDK"
```

## Task 2: Add MariaDB Storage for Agents, Receipts, Leases, and Releases

**Files:**
- Create: `db/migrations/003_wxauto_mcp.sql`
- Modify: `tests/db/migration-schema.test.ts`

- [ ] **Step 1: Write the failing migration-schema test**

Append:

```ts
const wxautoSchema = readFileSync(path.join(process.cwd(), "db", "migrations", "003_wxauto_mcp.sql"), "utf-8");

it("adds durable wxauto MCP agent, receipt, attempt and release storage", () => {
  [
    "wxauto_agents",
    "wxauto_event_receipts",
    "outbound_message_attempts",
    "wxauto_releases"
  ].forEach((table) => {
    expect(wxautoSchema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });
  expect(wxautoSchema).toContain("lease_id varchar(64) NULL");
  expect(wxautoSchema).toContain("lease_expires_at datetime(3) NULL");
  expect(wxautoSchema).toContain("uniq_wxauto_event");
  expect(wxautoSchema).toContain("uniq_outbound_attempt_lease");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts
```

Expected: FAIL because `003_wxauto_mcp.sql` does not exist.

- [ ] **Step 3: Create the migration**

Create `db/migrations/003_wxauto_mcp.sql`:

```sql
CREATE TABLE IF NOT EXISTS wxauto_agents (
  id varchar(128) NOT NULL PRIMARY KEY,
  display_name varchar(160) NOT NULL,
  app_version varchar(64) NOT NULL,
  worker_version varchar(64) NOT NULL,
  windows_version varchar(120) NOT NULL,
  wechat_process_state varchar(32) NOT NULL,
  wechat_login_state varchar(32) NOT NULL,
  safety_mode varchar(32) NOT NULL,
  capabilities_json json NOT NULL,
  last_seen_at datetime(3) NOT NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  KEY idx_wxauto_agents_seen (last_seen_at),
  KEY idx_wxauto_agents_login (wechat_login_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wxauto_event_receipts (
  id varchar(128) NOT NULL PRIMARY KEY,
  agent_id varchar(128) NOT NULL,
  message_id varchar(160) NOT NULL,
  inbound_message_id varchar(64) NULL,
  action varchar(32) NOT NULL,
  result_json json NOT NULL,
  created_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_wxauto_event (agent_id, message_id),
  KEY idx_wxauto_receipts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE outbound_messages
  ADD COLUMN claimed_by_agent_id varchar(128) NULL AFTER claimed_at,
  ADD COLUMN lease_id varchar(64) NULL AFTER claimed_by_agent_id,
  ADD COLUMN lease_expires_at datetime(3) NULL AFTER lease_id,
  ADD COLUMN safety_rule varchar(120) NULL AFTER last_error,
  ADD UNIQUE KEY uniq_outbound_lease (lease_id),
  ADD KEY idx_outbound_agent_lease (claimed_by_agent_id, lease_expires_at);

CREATE TABLE IF NOT EXISTS outbound_message_attempts (
  id varchar(64) NOT NULL PRIMARY KEY,
  message_id varchar(64) NOT NULL,
  agent_id varchar(128) NOT NULL,
  lease_id varchar(64) NOT NULL,
  status varchar(40) NOT NULL,
  error_text text NULL,
  safety_rule varchar(120) NULL,
  attempted_at datetime(3) NOT NULL,
  completed_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_outbound_attempt_lease (lease_id),
  KEY idx_outbound_attempt_message (message_id, completed_at),
  KEY idx_outbound_attempt_agent (agent_id, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wxauto_releases (
  version varchar(64) NOT NULL PRIMARY KEY,
  channel varchar(32) NOT NULL,
  file_name varchar(255) NOT NULL,
  file_path varchar(512) NOT NULL,
  file_size bigint NOT NULL,
  sha256 char(64) NOT NULL,
  release_notes text NOT NULL,
  manifest_json json NOT NULL,
  signature text NOT NULL,
  published_at datetime(3) NOT NULL,
  created_at datetime(3) NOT NULL,
  KEY idx_wxauto_releases_channel (channel, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 4: Run the migration tests**

Run:

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/storage-mode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Apply the migration to the development database**

Run:

```powershell
npm.cmd run db:migrate
```

Expected: output includes `003_wxauto_mcp`.

- [ ] **Step 6: Commit**

```powershell
git add db/migrations/003_wxauto_mcp.sql tests/db/migration-schema.test.ts
git commit -m "feat: add wxauto MCP persistence schema"
```

## Task 3: Define Stable wxauto Contracts and Domain Types

**Files:**
- Create: `src/lib/integrations/wxauto/contracts.ts`
- Modify: `src/lib/domain/types.ts`
- Create: `tests/integrations/wxauto/contracts.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/integrations/wxauto/contracts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "@/lib/integrations/wxauto/contracts";

describe("wxauto MCP contracts", () => {
  it("accepts one registered single-account Windows agent", () => {
    expect(registerAgentInputSchema.parse({
      deviceId: "device-a",
      displayName: "Front Desk PC",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11 23H2",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"]
    }).deviceId).toBe("device-a");
  });

  it("requires ordered events with stable message ids", () => {
    expect(submitEventsInputSchema.parse({
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "现场群",
        conversationType: "group",
        senderName: "张三",
        text: "A01 网络断了",
        imageUrls: [],
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    }).events[0].messageId).toBe("wx-1");
  });

  it("requires lease identity when completing outbound work", () => {
    expect(() => completeOutboundInputSchema.parse({
      deviceId: "device-a",
      messageId: "outbound-1",
      status: "sent",
      attemptedAt: "2026-06-05T08:00:00.000Z"
    })).toThrow();
    expect(claimOutboundInputSchema.parse({ deviceId: "device-a", limit: 10 }).limit).toBe(10);
  });
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/contracts.test.ts
```

Expected: FAIL because the contracts module does not exist.

- [ ] **Step 3: Create the contract schemas**

Create `src/lib/integrations/wxauto/contracts.ts`:

```ts
import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const registerAgentInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(160),
  appVersion: z.string().min(1).max(64),
  workerVersion: z.string().min(1).max(64),
  windowsVersion: z.string().min(1).max(120),
  wechatProcessState: z.enum(["running", "not_running", "unknown"]),
  wechatLoginState: z.enum(["logged_in", "logged_out", "unknown"]),
  safetyMode: z.literal("strict"),
  capabilities: z.array(z.enum(["text", "image"])).min(1)
});

export const wechatEventSchema = z.object({
  messageId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  conversationId: z.string().min(1).max(160),
  conversationType: z.enum(["direct", "group"]),
  senderId: z.string().max(160).optional(),
  senderName: z.string().min(1).max(160),
  text: z.string().default(""),
  imageUrls: z.array(z.string()).default([]),
  receivedAt: isoDateTime
});

export const submitEventsInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  events: z.array(wechatEventSchema).min(1).max(50)
}).superRefine(({ events }, context) => {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence <= events[index - 1].sequence) {
      context.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "events must be ordered" });
    }
  }
});

export const claimOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(50).default(10),
  supportedMessageTypes: z.array(z.literal("text")).default(["text"])
});

export const completeOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(64),
  leaseId: z.string().min(1).max(64),
  status: z.enum(["sent", "failed", "blocked_by_safety_policy"]),
  error: z.string().max(1000).optional(),
  safetyRule: z.string().max(120).optional(),
  attemptedAt: isoDateTime
});

export type RegisterAgentInput = z.infer<typeof registerAgentInputSchema>;
export type WechatEventInput = z.infer<typeof wechatEventSchema>;
export type SubmitEventsInput = z.infer<typeof submitEventsInputSchema>;
export type ClaimOutboundInput = z.infer<typeof claimOutboundInputSchema>;
export type CompleteOutboundInput = z.infer<typeof completeOutboundInputSchema>;

export type AgentRegistrationResult = {
  deviceId: string;
  serverTime: string;
  minimumAppVersion: string;
  recommendedPollIntervalMs: number;
  integrationEnabled: boolean;
};

export type EventReceipt = {
  messageId: string;
  action: "ignored" | "prompted" | "registered" | "processed" | "duplicate";
  inboundMessageId?: string;
};

export type OutboundLease = {
  messageId: string;
  leaseId: string;
  leaseExpiresAt: string;
  targetName: string;
  targetConversationId?: string;
  text: string;
  createdAt: string;
};
```

- [ ] **Step 4: Extend domain types**

Add to `src/lib/domain/types.ts`:

```ts
export type WxautoAgent = {
  id: string;
  displayName: string;
  appVersion: string;
  workerVersion: string;
  windowsVersion: string;
  wechatProcessState: "running" | "not_running" | "unknown";
  wechatLoginState: "logged_in" | "logged_out" | "unknown";
  safetyMode: "strict";
  capabilities: Array<"text" | "image">;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type WxautoRelease = {
  version: string;
  channel: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  sha256: string;
  releaseNotes: string;
  manifest: Record<string, unknown>;
  signature: string;
  publishedAt: string;
};
```

Extend `OutboundMessage`:

```ts
claimedByAgentId?: string;
leaseId?: string;
leaseExpiresAt?: string;
safetyRule?: string;
```

- [ ] **Step 5: Run the contract and type checks**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/contracts.test.ts
npx.cmd tsc --noEmit
```

Expected: contract tests and TypeScript both pass.

- [ ] **Step 6: Commit the contracts**

```powershell
git add src/lib/integrations/wxauto/contracts.ts src/lib/domain/types.ts tests/integrations/wxauto/contracts.test.ts
git commit -m "feat: define wxauto MCP contracts"
```

## Task 4: Implement Agent Registration and Atomic Inbound Event Receipts

**Files:**
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Create: `tests/db/wxauto-agent-store.test.ts`

- [ ] **Step 1: Write failing store tests**

Create `tests/db/wxauto-agent-store.test.ts` with a recording fake connection:

```ts
import { describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";

function connectionWith(receiptRows: unknown[] = []) {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("INSERT IGNORE INTO wxauto_event_receipts")) {
      return [{ affectedRows: receiptRows.length === 0 ? 1 : 0 }];
    }
    if (sql.includes("FROM wxauto_event_receipts")) return [receiptRows];
    if (sql.includes("FROM app_config_versions")) return [[]];
    if (sql.includes("FROM wxauto_agents")) return [[]];
    return [[]];
  });
  return { connection: { execute, query: execute } as unknown as DatabaseConnection, execute };
}

describe("wxauto agent store", () => {
  it("upserts agent health with a fresh last-seen time", async () => {
    const { connection, execute } = connectionWith();
    await new MariaDbStateStore().registerWxautoAgent({
      deviceId: "device-a",
      displayName: "Front Desk",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"]
    }, connection);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO wxauto_agents"))).toBe(true);
  });

  it("returns a stored event receipt without processing the event again", async () => {
    const { connection } = connectionWith([{
      message_id: "wx-1",
      inbound_message_id: "message-1",
      action: "processed",
      result_json: JSON.stringify({ messageId: "wx-1", action: "processed", inboundMessageId: "message-1" })
    }]);
    const receipts = await new MariaDbStateStore().submitWxautoEvents({
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "现场群",
        conversationType: "group",
        senderName: "张三",
        text: "A01 网络断了",
        imageUrls: [],
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    }, connection);
    expect(receipts).toEqual([{ messageId: "wx-1", action: "processed", inboundMessageId: "message-1" }]);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/db/wxauto-agent-store.test.ts
```

Expected: FAIL because the store methods do not exist.

- [ ] **Step 3: Add row mappers and registration**

In `src/lib/db/mariadb-state-store.ts`, add:

```ts
async registerWxautoAgent(input: RegisterAgentInput, connection: DatabaseConnection = getDatabasePool()): Promise<AgentRegistrationResult> {
  const now = new Date();
  await execute(connection, `
    INSERT INTO wxauto_agents (
      id, display_name, app_version, worker_version, windows_version,
      wechat_process_state, wechat_login_state, safety_mode, capabilities_json,
      last_seen_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      app_version = VALUES(app_version),
      worker_version = VALUES(worker_version),
      windows_version = VALUES(windows_version),
      wechat_process_state = VALUES(wechat_process_state),
      wechat_login_state = VALUES(wechat_login_state),
      safety_mode = VALUES(safety_mode),
      capabilities_json = VALUES(capabilities_json),
      last_seen_at = VALUES(last_seen_at),
      updated_at = VALUES(updated_at)
  `, [
    input.deviceId, input.displayName, input.appVersion, input.workerVersion,
    input.windowsVersion, input.wechatProcessState, input.wechatLoginState,
    input.safetyMode, json(input.capabilities), now, now, now
  ]);
  const config = await latestConfig(connection);
  const integration = config.messageIntegrations?.find((item) => item.channel === "wechat");
  return {
    deviceId: input.deviceId,
    serverTime: now.toISOString(),
    minimumAppVersion: "0.1.0",
    recommendedPollIntervalMs: 2000,
    integrationEnabled: Boolean(integration?.enabled)
  };
}
```

- [ ] **Step 4: Add atomic event submission**

Add a mapper:

```ts
function eventToIntake(input: SubmitEventsInput, event: WechatEventInput): IntakeMessageInput {
  return {
    channel: "wechat",
    externalMessageId: event.messageId,
    senderId: event.senderId,
    senderName: event.senderName,
    senderGroup: event.conversationType === "group" ? event.conversationId : undefined,
    sourceConversationId: event.conversationId,
    text: event.text,
    imageUrls: event.imageUrls,
    receivedAt: event.receivedAt,
    raw: { wxautoDeviceId: input.deviceId, sequence: event.sequence }
  };
}
```

Implement:

```ts
async submitWxautoEvents(input: SubmitEventsInput, suppliedConnection?: DatabaseConnection): Promise<EventReceipt[]> {
  const work = async (connection: DatabaseConnection) => {
    const receipts: EventReceipt[] = [];
    for (const event of input.events) {
      const receiptId = stableId("wxauto-receipt", `${input.deviceId}:${event.messageId}`);
      const reservation = await execute(connection, `
        INSERT IGNORE INTO wxauto_event_receipts (
          id, agent_id, message_id, inbound_message_id, action, result_json, created_at
        ) VALUES (?, ?, ?, NULL, 'processing', ?, ?)
      `, [
        receiptId,
        input.deviceId,
        event.messageId,
        json({ messageId: event.messageId, action: "duplicate" }),
        new Date()
      ]);
      if (reservation.affectedRows === 0) {
        const [existing] = await rows<Row>(
          connection,
          "SELECT result_json FROM wxauto_event_receipts WHERE agent_id = ? AND message_id = ? LIMIT 1",
          [input.deviceId, event.messageId]
        );
        receipts.push(parseJsonValue<EventReceipt>(
          existing?.result_json,
          { messageId: event.messageId, action: "duplicate" }
        ));
        continue;
      }
      const state = await this.readState(connection);
      const result = await processWechatWatchtowerMessage(state, eventToIntake(input, event));
      await this.writeState(state, connection);
      const receipt: EventReceipt = {
        messageId: event.messageId,
        action: result.action,
        inboundMessageId: result.record?.id
      };
      await execute(connection, `
        UPDATE wxauto_event_receipts
        SET inbound_message_id = ?, action = ?, result_json = ?
        WHERE id = ?
      `, [result.record?.id ?? null, result.action, json(receipt), receiptId]);
      receipts.push(receipt);
    }
    return receipts;
  };
  return suppliedConnection ? work(suppliedConnection) : withDatabaseTransaction(work);
}
```

`INSERT IGNORE` is the concurrency gate. A competing transaction waits on the same unique key and, after the winning transaction commits, reads the final stored receipt instead of entering the watchtower business logic.

- [ ] **Step 5: Wire repository delegation**

Add the first two typed methods to `AppRepository`:

```ts
registerWxautoAgent(input: RegisterAgentInput): Promise<AgentRegistrationResult>;
submitWxautoEvents(input: SubmitEventsInput): Promise<EventReceipt[]>;
```

Import the contract types, then add these delegates in `createMariaDbAppRepository`:

```ts
registerWxautoAgent: (input) => store.registerWxautoAgent(input),
submitWxautoEvents: (input) => store.submitWxautoEvents(input),
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
npm.cmd run test:run -- tests/db/wxauto-agent-store.test.ts tests/repositories/app-repository.test.ts
npx.cmd tsc --noEmit
```

Expected: store tests and TypeScript both pass.

- [ ] **Step 7: Commit**

```powershell
git add src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts tests/db/wxauto-agent-store.test.ts
git commit -m "feat: persist wxauto agents and event receipts"
```

## Task 5: Implement Outbound Leases and Idempotent Completion

**Files:**
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/domain/types.ts`
- Create: `tests/db/wxauto-outbound-lease.test.ts`

- [ ] **Step 1: Write failing lease tests**

Create `tests/db/wxauto-outbound-lease.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";

it("claims outbound messages with agent-owned expiring leases", async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT * FROM outbound_messages")) return [[{
      id: "outbound-1", channel: "wechat", target_name: "现场群", text: "工单已创建",
      status: "pending", retry_count: 0,
      created_at: new Date("2026-06-05T08:00:00.000Z"),
      updated_at: new Date("2026-06-05T08:00:00.000Z")
    }]];
    return [[]];
  });
  const connection = { execute, query: execute } as unknown as DatabaseConnection;
  const leases = await new MariaDbStateStore().claimWxautoOutbound({
    deviceId: "device-a",
    limit: 10,
    supportedMessageTypes: ["text"]
  }, connection);
  expect(leases[0]).toMatchObject({ messageId: "outbound-1", targetName: "现场群" });
  expect(leases[0].leaseId).toMatch(/^lease-/);
  expect(execute.mock.calls.some(([sql]) => String(sql).includes("lease_expires_at"))).toBe(true);
});

it("treats repeated completion for the same lease as idempotent", async () => {
  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("FROM outbound_message_attempts")) return [[{
      message_id: "outbound-1", agent_id: "device-a", status: "sent"
    }]];
    if (sql.includes("FROM outbound_messages")) return [[{
      id: "outbound-1", channel: "wechat", target_name: "现场群", text: "工单已创建",
      status: "sent", retry_count: 0, lease_id: "lease-1",
      created_at: new Date(), updated_at: new Date(), sent_at: new Date()
    }]];
    return [[]];
  });
  const connection = { execute, query: execute } as unknown as DatabaseConnection;
  const result = await new MariaDbStateStore().completeWxautoOutbound({
    deviceId: "device-a",
    messageId: "outbound-1",
    leaseId: "lease-1",
    status: "sent",
    attemptedAt: "2026-06-05T08:01:00.000Z"
  }, connection);
  expect(result.accepted).toBe(true);
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/db/wxauto-outbound-lease.test.ts
```

Expected: FAIL because lease methods do not exist.

- [ ] **Step 3: Implement atomic claim**

Implement `claimWxautoOutbound` using `FOR UPDATE SKIP LOCKED`:

```ts
async claimWxautoOutbound(input: ClaimOutboundInput, suppliedConnection?: DatabaseConnection): Promise<OutboundLease[]> {
  const work = async (connection: DatabaseConnection) => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 120000);
    const candidates = await rows<Row>(connection, `
      SELECT * FROM outbound_messages
      WHERE status = 'pending'
         OR (status = 'failed' AND retry_count < 3)
         OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      ORDER BY created_at
      LIMIT ?
      FOR UPDATE SKIP LOCKED
    `, [now, input.limit]);
    const leases: OutboundLease[] = [];
    for (const row of candidates) {
      const leaseId = `lease-${crypto.randomUUID()}`;
      await execute(connection, `
        UPDATE outbound_messages
        SET status = 'sending', claimed_at = ?, claimed_by_agent_id = ?,
            lease_id = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `, [now, input.deviceId, leaseId, leaseExpiresAt, now, row.id]);
      leases.push({
        messageId: String(row.id),
        leaseId,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        targetName: String(row.target_name),
        targetConversationId: row.target_conversation_id ? String(row.target_conversation_id) : undefined,
        text: String(row.text),
        createdAt: requiredIso(row.created_at)
      });
    }
    return leases;
  };
  return suppliedConnection ? work(suppliedConnection) : withDatabaseTransaction(work);
}
```

- [ ] **Step 4: Implement idempotent completion**

Implement:

```ts
async completeWxautoOutbound(input: CompleteOutboundInput, suppliedConnection?: DatabaseConnection) {
  const work = async (connection: DatabaseConnection) => {
    const [prior] = await rows<Row>(
      connection,
      "SELECT * FROM outbound_message_attempts WHERE lease_id = ? LIMIT 1",
      [input.leaseId]
    );
    if (prior) {
      if (prior.message_id !== input.messageId || prior.agent_id !== input.deviceId) {
        return { accepted: false };
      }
      const [message] = await rows<Row>(connection, "SELECT * FROM outbound_messages WHERE id = ? LIMIT 1", [input.messageId]);
      return { accepted: true, message: message ? outboundMessageFromRow(message) : undefined };
    }
    const [message] = await rows<Row>(
      connection,
      "SELECT * FROM outbound_messages WHERE id = ? FOR UPDATE",
      [input.messageId]
    );
    if (!message || message.lease_id !== input.leaseId || message.claimed_by_agent_id !== input.deviceId) {
      return { accepted: false };
    }
    const now = new Date();
    const storedStatus = input.status === "blocked_by_safety_policy" ? "blocked" : input.status;
    await execute(connection, `
      INSERT INTO outbound_message_attempts (
        id, message_id, agent_id, lease_id, status, error_text, safety_rule,
        attempted_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      `attempt-${crypto.randomUUID()}`, input.messageId, input.deviceId, input.leaseId,
      input.status, input.error ?? null, input.safetyRule ?? null,
      new Date(input.attemptedAt), now
    ]);
    if (storedStatus === "sent") {
      await execute(connection, `
        UPDATE outbound_messages
        SET status = 'sent', sent_at = ?, last_error = NULL, safety_rule = NULL, updated_at = ?
        WHERE id = ?
      `, [now, now, input.messageId]);
    } else if (storedStatus === "blocked") {
      await execute(connection, `
        UPDATE outbound_messages
        SET status = 'blocked', last_error = ?, safety_rule = ?, updated_at = ?
        WHERE id = ?
      `, [input.error ?? "Blocked by safety policy", input.safetyRule ?? null, now, input.messageId]);
    } else {
      await execute(connection, `
        UPDATE outbound_messages
        SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `, [input.error?.trim() || "发送失败", now, input.messageId]);
    }
    const [updated] = await rows<Row>(connection, "SELECT * FROM outbound_messages WHERE id = ? LIMIT 1", [input.messageId]);
    return { accepted: true, message: updated ? outboundMessageFromRow(updated) : undefined };
  };
  return suppliedConnection ? work(suppliedConnection) : withDatabaseTransaction(work);
}
```

Update `OutboundMessageStatus` to include `"blocked"` and map the new lease fields in `outboundMessageFromRow`.

- [ ] **Step 5: Wire repository delegation**

Add the lease methods to `AppRepository`:

```ts
claimWxautoOutbound(input: ClaimOutboundInput): Promise<OutboundLease[]>;
completeWxautoOutbound(input: CompleteOutboundInput): Promise<{ accepted: boolean; message?: OutboundMessage }>;
```

Then add:

```ts
claimWxautoOutbound: (input) => store.claimWxautoOutbound(input),
completeWxautoOutbound: (input) => store.completeWxautoOutbound(input),
```

- [ ] **Step 6: Preserve lease fields during existing full-state writes**

Update `outboundMessageFromRow` and `writeOutboundMessages` so the existing watchtower transaction reads and rewrites:

```ts
claimedByAgentId?: string;
leaseId?: string;
leaseExpiresAt?: string;
safetyRule?: string;
```

The `INSERT INTO outbound_messages` column list must include `claimed_by_agent_id`, `lease_id`, `lease_expires_at`, and `safety_rule`. Add a regression test that starts with a leased outbound message, processes an inbound event through the existing full-state transaction, and verifies the lease owner, ID, and expiry are unchanged.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm.cmd run test:run -- tests/db/wxauto-outbound-lease.test.ts tests/services/outbound-message-service.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts src/lib/domain/types.ts tests/db/wxauto-outbound-lease.test.ts
git commit -m "feat: add durable outbound message leases"
```

## Task 6: Add Authentication and the Shared Integration Service

**Files:**
- Create: `src/lib/integrations/wxauto/auth.ts`
- Create: `src/lib/integrations/wxauto/service.ts`
- Create: `tests/integrations/wxauto/auth.test.ts`
- Create: `tests/integrations/wxauto/service.test.ts`

- [ ] **Step 1: Write failing authentication tests**

Create `tests/integrations/wxauto/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";

describe("wxauto bearer authentication", () => {
  it("accepts the configured bearer token", () => {
    const request = new Request("https://board.example/api/mcp", {
      headers: { authorization: "Bearer secret-token" }
    });
    expect(authenticateWxautoRequest(request, { WXAUTO_MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv))
      .toEqual({ tokenId: "wxauto-fixed-token" });
  });

  it("rejects missing configuration and wrong tokens", () => {
    expect(authenticateWxautoRequest(new Request("https://board.example/api/mcp"), {} as NodeJS.ProcessEnv)).toBeNull();
    expect(authenticateWxautoRequest(new Request("https://board.example/api/mcp", {
      headers: { authorization: "Bearer wrong" }
    }), { WXAUTO_MCP_TOKEN: "expected" } as NodeJS.ProcessEnv)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/auth.test.ts
```

Expected: FAIL because the auth module does not exist.

- [ ] **Step 3: Implement the replaceable auth adapter**

Create `src/lib/integrations/wxauto/auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";

export type WxautoPrincipal = { tokenId: string };

function equalSecret(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticateWxautoRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): WxautoPrincipal | null {
  const expected = env.WXAUTO_MCP_TOKEN;
  if (!expected) return null;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const actual = authorization.slice("Bearer ".length).trim();
  return equalSecret(actual, expected) ? { tokenId: "wxauto-fixed-token" } : null;
}
```

- [ ] **Step 4: Write and implement the shared service**

Create `tests/integrations/wxauto/service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createWxautoIntegrationService } from "@/lib/integrations/wxauto/service";
import type { AppRepository } from "@/lib/repositories/app-repository";

it("delegates parsed transport inputs to repository operations", async () => {
  const repository = {
    registerWxautoAgent: vi.fn(async (input) => ({
      deviceId: input.deviceId, serverTime: "2026-06-05T08:00:00.000Z",
      minimumAppVersion: "0.1.0", recommendedPollIntervalMs: 2000, integrationEnabled: true
    }))
  } as unknown as AppRepository;
  const result = await createWxautoIntegrationService(repository).registerAgent({
    deviceId: "device-a", displayName: "PC", appVersion: "0.1.0", workerVersion: "0.1.0",
    windowsVersion: "Windows 11", wechatProcessState: "running", wechatLoginState: "logged_in",
    safetyMode: "strict", capabilities: ["text"]
  });
  expect(result.deviceId).toBe("device-a");
  expect(repository.registerWxautoAgent).toHaveBeenCalledOnce();
});
```

Create `src/lib/integrations/wxauto/service.ts`:

```ts
import { getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "./contracts";

export function createWxautoIntegrationService(repository: AppRepository = getAppRepository()) {
  return {
    registerAgent: (input: unknown) => repository.registerWxautoAgent(registerAgentInputSchema.parse(input)),
    submitEvents: (input: unknown) => repository.submitWxautoEvents(submitEventsInputSchema.parse(input)),
    claimOutbound: (input: unknown) => repository.claimWxautoOutbound(claimOutboundInputSchema.parse(input)),
    completeOutbound: (input: unknown) => repository.completeWxautoOutbound(completeOutboundInputSchema.parse(input))
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/auth.test.ts tests/integrations/wxauto/service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/integrations/wxauto/auth.ts src/lib/integrations/wxauto/service.ts tests/integrations/wxauto/auth.test.ts tests/integrations/wxauto/service.test.ts
git commit -m "feat: add wxauto integration service boundary"
```

## Task 7: Expose the Four Standard MCP Tools

**Files:**
- Create: `src/lib/integrations/wxauto/mcp-server.ts`
- Create: `src/app/api/mcp/route.ts`
- Create: `tests/api/mcp-route.test.ts`

- [ ] **Step 1: Write an end-to-end MCP route test with the official client**

Create `tests/api/mcp-route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppRepository } from "@/lib/repositories/app-repository";

const repository = vi.hoisted(() => ({
  registerWxautoAgent: vi.fn(),
  submitWxautoEvents: vi.fn(),
  claimWxautoOutbound: vi.fn(),
  completeWxautoOutbound: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: () => repository as unknown as AppRepository
}));

const route = await import("@/app/api/mcp/route");

function routeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = new Request(String(input), init);
  if (request.method === "GET") return route.GET();
  if (request.method === "DELETE") return route.DELETE();
  return route.POST(request);
}

beforeEach(() => {
  process.env.WXAUTO_MCP_TOKEN = "test-token";
  repository.registerWxautoAgent.mockReset().mockResolvedValue({
    deviceId: "device-a",
    serverTime: "2026-06-05T08:00:00.000Z",
    minimumAppVersion: "0.1.0",
    recommendedPollIntervalMs: 2000,
    integrationEnabled: true
  });
});

describe("POST /api/mcp", () => {
  it("registers an agent through a standard MCP tool call", async () => {
    const client = new Client({ name: "test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://board.example/api/mcp"), {
      requestInit: { headers: { authorization: "Bearer test-token" } },
      fetch: routeFetch
    });
    await client.connect(transport);
    const result = await client.callTool({
      name: "register_wxauto_agent",
      arguments: {
        deviceId: "device-a", displayName: "PC", appVersion: "0.1.0", workerVersion: "0.1.0",
        windowsVersion: "Windows 11", wechatProcessState: "running", wechatLoginState: "logged_in",
        safetyMode: "strict", capabilities: ["text"]
      }
    });
    expect(result.structuredContent).toMatchObject({ deviceId: "device-a", integrationEnabled: true });
    await client.close();
  });

  it("rejects missing bearer authentication", async () => {
    const response = await route.POST(new Request("https://board.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" }
      } })
    }));
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/api/mcp-route.test.ts
```

Expected: FAIL because the MCP server and route do not exist.

- [ ] **Step 3: Register the tools**

Create `src/lib/integrations/wxauto/mcp-server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWxautoIntegrationService } from "./service";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "./contracts";

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function createWxautoMcpServer() {
  const service = createWxautoIntegrationService();
  const server = new McpServer({ name: "main-board-wxauto", version: "1.0.0" });

  server.registerTool("register_wxauto_agent", {
    description: "Register or refresh a wxauto desktop agent",
    inputSchema: registerAgentInputSchema,
    outputSchema: z.object({
      deviceId: z.string(), serverTime: z.string(), minimumAppVersion: z.string(),
      recommendedPollIntervalMs: z.number(), integrationEnabled: z.boolean()
    }),
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => toolResult(await service.registerAgent(input)));

  server.registerTool("submit_wechat_events", {
    description: "Submit an ordered batch of durable inbound WeChat events",
    inputSchema: submitEventsInputSchema,
    outputSchema: z.object({ receipts: z.array(z.object({
      messageId: z.string(), action: z.string(), inboundMessageId: z.string().optional()
    })) }),
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => toolResult({ receipts: await service.submitEvents(input) }));

  server.registerTool("claim_outbound_messages", {
    description: "Lease pending outbound WeChat messages for one desktop agent",
    inputSchema: claimOutboundInputSchema,
    outputSchema: z.object({ messages: z.array(z.object({
      messageId: z.string(), leaseId: z.string(), leaseExpiresAt: z.string(),
      targetName: z.string(), targetConversationId: z.string().optional(),
      text: z.string(), createdAt: z.string()
    })) }),
    annotations: { idempotentHint: false, openWorldHint: false }
  }, async (input) => toolResult({ messages: await service.claimOutbound(input) }));

  server.registerTool("complete_outbound_message", {
    description: "Complete a leased outbound message with sent, failed, or safety-blocked status",
    inputSchema: completeOutboundInputSchema,
    outputSchema: z.object({ accepted: z.boolean() }),
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => {
    const result = await service.completeOutbound(input);
    return toolResult({ accepted: result.accepted });
  });

  return server;
}
```

- [ ] **Step 4: Add the stateless Streamable HTTP route**

Create `src/app/api/mcp/route.ts`:

```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";
import { createWxautoMcpServer } from "@/lib/integrations/wxauto/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const principal = authenticateWxautoRequest(request);
  if (!principal) {
    return Response.json({ message: "Unauthorized" }, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="wxauto-mcp"' }
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createWxautoMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
```

- [ ] **Step 5: Run MCP tests**

Run:

```powershell
npm.cmd run test:run -- tests/api/mcp-route.test.ts tests/integrations/wxauto
```

Expected: PASS, including a real official SDK initialization and tool call.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/integrations/wxauto/mcp-server.ts src/app/api/mcp/route.ts tests/api/mcp-route.test.ts
git commit -m "feat: expose standard wxauto MCP tools"
```

## Task 8: Refactor Legacy HTTP Routes onto the Shared Semantics

**Files:**
- Modify: `src/app/api/integrations/wechat/messages/route.ts`
- Modify: `src/app/api/integrations/wechat/outbound/route.ts`
- Modify: `src/app/api/integrations/wechat/outbound/[messageId]/route.ts`
- Modify: `tests/api/message-intake-route.test.ts`
- Modify: `tests/api/wechat-outbound-route.test.ts`

- [ ] **Step 1: Add failing compatibility assertions**

Update the route tests so they assert:

```ts
expect(messages[0]).toMatchObject({
  messageId: expect.any(String),
  leaseId: expect.stringMatching(/^lease-/)
});
```

Add a test that submits the same legacy HTTP message twice and expects the second result to be `"duplicate"`.

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/api/message-intake-route.test.ts tests/api/wechat-outbound-route.test.ts
```

Expected: FAIL because legacy routes still bypass receipt and lease semantics.

- [ ] **Step 3: Adapt legacy inbound**

Keep the existing normalization, then call:

```ts
import { randomUUID } from "node:crypto";

const service = createWxautoIntegrationService();
const [receipt] = await service.submitEvents({
  deviceId: "legacy-http",
  events: [{
    messageId: body.externalMessageId ?? `legacy-${randomUUID()}`,
    sequence: Date.now(),
    conversationId: body.sourceConversationId ?? body.senderGroup ?? body.senderName ?? "微信会话",
    conversationType: body.senderGroup ? "group" : "direct",
    senderId: body.senderId,
    senderName: body.senderName ?? "微信用户",
    text: body.text ?? "",
    imageUrls: body.imageUrls ?? [],
    receivedAt: body.receivedAt ?? new Date().toISOString()
  }]
});
return NextResponse.json(receipt);
```

Preserve the old `x-mcp-secret`/Bearer compatibility check.

- [ ] **Step 4: Adapt legacy outbound claim and completion**

Claim with:

```ts
const messages = await createWxautoIntegrationService().claimOutbound({
  deviceId: "legacy-http",
  limit: input.limit,
  supportedMessageTypes: ["text"]
});
return NextResponse.json({ messages });
```

For the old completion route, look up the current message lease through a new repository helper:

```ts
completeLegacyOutbound(messageId: string, status: "sent" | "failed", error?: string)
```

The store implementation locks the message, requires `claimed_by_agent_id = 'legacy-http'`, and delegates to `completeWxautoOutbound` with the current lease ID.

- [ ] **Step 5: Run compatibility tests**

Run:

```powershell
npm.cmd run test:run -- tests/api/message-intake-route.test.ts tests/api/wechat-outbound-route.test.ts tests/scripts/wxauto-rest-bridge.test.ts
```

Expected: PASS. The unchanged Node bridge still works while receiving extra lease fields.

- [ ] **Step 6: Commit**

```powershell
git add src/app/api/integrations/wechat src/lib/repositories/app-repository.ts src/lib/db/mariadb-state-store.ts tests/api/message-intake-route.test.ts tests/api/wechat-outbound-route.test.ts
git commit -m "refactor: share wxauto semantics with legacy HTTP"
```

## Task 9: Add Agent Health to Admin Bootstrap and UI

**Files:**
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/app/api/bootstrap/route.ts`
- Modify: `src/components/admin-shell.tsx`
- Create: `src/components/admin/wxauto-agent-panel.tsx`
- Modify: `src/components/admin-panel.tsx`
- Create: `tests/components/wxauto-agent-panel.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `tests/components/wxauto-agent-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WxautoAgentPanel } from "@/components/admin/wxauto-agent-panel";

it("shows agent, WeChat and last-seen health", () => {
  render(<WxautoAgentPanel agents={[{
    id: "device-a", displayName: "Front Desk PC", appVersion: "0.1.0", workerVersion: "0.1.0",
    windowsVersion: "Windows 11", wechatProcessState: "running", wechatLoginState: "logged_in",
    safetyMode: "strict", capabilities: ["text"], lastSeenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }]} />);
  expect(screen.getByText("Front Desk PC")).not.toBeNull();
  expect(screen.getByText("微信已登录")).not.toBeNull();
  expect(screen.getByText("严格安全模式")).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/wxauto-agent-panel.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Add agent listing**

Implement `listWxautoAgents` in the store:

```ts
async listWxautoAgents(connection: DatabaseConnection = getDatabasePool()): Promise<WxautoAgent[]> {
  const agentRows = await rows<Row>(connection, "SELECT * FROM wxauto_agents ORDER BY last_seen_at DESC");
  return agentRows.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
    appVersion: String(row.app_version),
    workerVersion: String(row.worker_version),
    windowsVersion: String(row.windows_version),
    wechatProcessState: row.wechat_process_state as WxautoAgent["wechatProcessState"],
    wechatLoginState: row.wechat_login_state as WxautoAgent["wechatLoginState"],
    safetyMode: "strict",
    capabilities: parseJsonValue<WxautoAgent["capabilities"]>(row.capabilities_json, ["text"]),
    lastSeenAt: requiredIso(row.last_seen_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at)
  }));
}
```

Add `listWxautoAgents(): Promise<WxautoAgent[]>` to `AppRepository`, delegate it through `createMariaDbAppRepository`, include `wxautoAgents` in `AdminBootstrapData`, and return it from `/api/bootstrap`.

- [ ] **Step 4: Create the focused panel**

Create `src/components/admin/wxauto-agent-panel.tsx`:

```tsx
import type { WxautoAgent } from "@/lib/domain/types";

export function WxautoAgentPanel({ agents }: { agents: WxautoAgent[] }) {
  return (
    <section className="admin-card" aria-label="wxauto 桌面客户端">
      <h3>wxauto 桌面客户端</h3>
      {agents.length === 0 ? <p>尚无桌面客户端连接。</p> : agents.map((agent) => (
        <article className="message-record-card" key={agent.id}>
          <div><strong>{agent.displayName}</strong><span>{agent.appVersion}</span></div>
          <p>{agent.wechatLoginState === "logged_in" ? "微信已登录" : "微信未登录"}</p>
          <small>{agent.safetyMode === "strict" ? "严格安全模式" : agent.safetyMode}</small>
        </article>
      ))}
    </section>
  );
}
```

Pass `wxautoAgents` through `AdminBackendShell` and render this panel on the workbench.

- [ ] **Step 5: Run component and bootstrap tests**

Run:

```powershell
npm.cmd run test:run -- tests/components/wxauto-agent-panel.test.tsx tests/api/bootstrap-route.test.ts tests/app/admin-page.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts src/app/api/bootstrap/route.ts src/components/admin-shell.tsx src/components/admin/wxauto-agent-panel.tsx src/components/admin-panel.tsx tests/components/wxauto-agent-panel.test.tsx tests/api/bootstrap-route.test.ts
git commit -m "feat: show wxauto agent health in admin"
```

## Task 10: Implement Signed Update Publishing and Public Downloads

**Files:**
- Create: `src/lib/integrations/wxauto/update-service.ts`
- Create: `src/app/api/admin/wxauto-updates/route.ts`
- Create: `src/app/api/updates/wxauto/latest/route.ts`
- Create: `src/app/api/updates/wxauto/[version]/download/route.ts`
- Create: `scripts/generate-wxauto-update-keys.mjs`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Create: `tests/integrations/wxauto/update-service.test.ts`
- Create: `tests/api/wxauto-update-routes.test.ts`

- [ ] **Step 1: Write failing signature tests**

Create `tests/integrations/wxauto/update-service.test.ts`:

```ts
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSignedManifest } from "@/lib/integrations/wxauto/update-service";

it("signs a canonical update manifest with Ed25519", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = createSignedManifest({
    version: "0.2.0",
    channel: "stable",
    fileName: "wxauto-desktop-Setup-0.2.0.exe",
    fileSize: 123,
    sha256: "a".repeat(64),
    releaseNotes: "Test release",
    downloadUrl: "https://board.example/api/updates/wxauto/0.2.0/download",
    publishedAt: "2026-06-05T08:00:00.000Z"
  }, privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  expect(verify(null, Buffer.from(signed.payload), publicKey, Buffer.from(signed.signature, "base64"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/update-service.test.ts
```

Expected: FAIL because the update service does not exist.

- [ ] **Step 3: Implement canonical signing and safe file storage**

Create `src/lib/integrations/wxauto/update-service.ts` with:

```ts
import { createHash, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type UpdateManifestPayload = {
  version: string;
  channel: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  releaseNotes: string;
  downloadUrl: string;
  publishedAt: string;
};

export function canonicalManifest(payload: UpdateManifestPayload) {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

export function createSignedManifest(payload: UpdateManifestPayload, privateKeyPem: string) {
  const canonical = canonicalManifest(payload);
  return { payload: canonical, signature: sign(null, Buffer.from(canonical), privateKeyPem).toString("base64") };
}

export async function storeInstaller(root: string, version: string, fileName: string, bytes: Uint8Array) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid version");
  const safeName = path.basename(fileName);
  const directory = path.join(root, version);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, safeName);
  await writeFile(filePath, bytes);
  return {
    filePath,
    fileName: safeName,
    fileSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
```

- [ ] **Step 4: Implement release persistence**

Add `listWxautoReleases`, `saveWxautoRelease`, and `getWxautoRelease` to `MariaDbStateStore`. Add these methods to `AppRepository` and delegate them through `createMariaDbAppRepository`:

```ts
listWxautoReleases(): Promise<WxautoRelease[]>;
saveWxautoRelease(release: WxautoRelease): Promise<WxautoRelease>;
getWxautoRelease(version: string): Promise<WxautoRelease | undefined>;
```

Use the `wxauto_releases` table without placing installer bytes in MariaDB. Include `wxautoReleases` in `AdminBootstrapData`, load it from `adminBootstrap`, and return it from `/api/bootstrap`.

- [ ] **Step 5: Add the publishing and public routes**

The admin publish route must:

```ts
const expected = process.env.WXAUTO_UPDATE_PUBLISH_TOKEN;
const actual = request.headers.get("x-update-publish-token");
if (!expected || actual !== expected) return Response.json({ message: "Unauthorized" }, { status: 401 });
```

It parses `FormData` fields `version`, `channel`, `releaseNotes`, and `installer`, stores the file under:

```ts
path.join(process.cwd(), "data", "wxauto-updates")
```

It signs using `WXAUTO_UPDATE_SIGNING_PRIVATE_KEY`.

The public latest route returns:

```json
{
  "payload": "{\"channel\":\"stable\",...}",
  "signature": "base64-ed25519-signature"
}
```

The download route resolves the persisted release, verifies the path remains under `data/wxauto-updates`, and returns the installer as `application/octet-stream`.

Reject installers larger than 250 MiB and files whose basename does not end in `.exe`. Resolve the download path with `path.resolve`, then reject it unless `path.relative(updateRoot, resolvedPath)` is non-empty and does not begin with `..` or contain an absolute path.

- [ ] **Step 6: Write route tests**

Create `tests/api/wxauto-update-routes.test.ts` with direct route tests and a mocked repository:

```ts
it("rejects publishing without the dedicated token", async () => {
  const response = await publishRoute.POST(new Request("https://board.example/api/admin/wxauto-updates", {
    method: "POST",
    body: new FormData()
  }));
  expect(response.status).toBe(401);
});

it("returns the newest signed manifest for the requested channel", async () => {
  repository.listWxautoReleases.mockResolvedValue([release]);
  const response = await latestRoute.GET(new Request(
    "https://board.example/api/updates/wxauto/latest?channel=stable"
  ));
  expect(await response.json()).toEqual({
    payload: release.manifest.payload,
    signature: release.signature
  });
});

it("rejects a persisted installer path outside the update root", async () => {
  repository.getWxautoRelease.mockResolvedValue({
    ...release,
    filePath: path.resolve("..", "outside.exe")
  });
  const response = await downloadRoute.GET(
    new Request("https://board.example/api/updates/wxauto/0.2.0/download"),
    { params: Promise.resolve({ version: "0.2.0" }) }
  );
  expect(response.status).toBe(404);
});
```

Also test a successful multipart publish using a temporary update root injected into `createWxautoUpdateService`, and assert the stored hash matches the uploaded bytes.

- [ ] **Step 7: Add key generation script**

Create `scripts/generate-wxauto-update-keys.mjs`:

```js
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
console.log(`WXAUTO_UPDATE_SIGNING_PRIVATE_KEY=${JSON.stringify(privateKey.export({ format: "pem", type: "pkcs8" }).toString())}`);
console.log(`WXAUTO_UPDATE_SIGNING_PUBLIC_KEY=${JSON.stringify(publicKey.export({ format: "pem", type: "spki" }).toString())}`);
```

Add:

```json
"update:keys": "node scripts/generate-wxauto-update-keys.mjs"
```

- [ ] **Step 8: Run update tests**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto/update-service.test.ts tests/api/wxauto-update-routes.test.ts
npx.cmd tsc --noEmit
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/lib/integrations/wxauto/update-service.ts src/app/api/admin/wxauto-updates src/app/api/updates/wxauto scripts/generate-wxauto-update-keys.mjs src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts tests/integrations/wxauto/update-service.test.ts tests/api/wxauto-update-routes.test.ts package.json package-lock.json
git commit -m "feat: distribute signed wxauto desktop updates"
```

## Task 11: Add the Update Publisher UI

**Files:**
- Create: `src/components/admin/wxauto-update-panel.tsx`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/components/admin-shell.tsx`
- Create: `tests/components/wxauto-update-panel.test.tsx`

- [ ] **Step 1: Write the failing UI test**

Create `tests/components/wxauto-update-panel.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WxautoUpdatePanel } from "@/components/admin/wxauto-update-panel";

it("publishes an installer with a dedicated publish token", async () => {
  const fetchMock = vi.fn(async () => Response.json({ release: { version: "0.2.0" } }));
  vi.stubGlobal("fetch", fetchMock);
  const user = userEvent.setup();
  render(<WxautoUpdatePanel releases={[]} onPublished={vi.fn()} />);
  await user.type(screen.getByLabelText("版本号"), "0.2.0");
  await user.type(screen.getByLabelText("发布说明"), "Internal test");
  await user.type(screen.getByLabelText("发布令牌"), "publish-secret");
  await user.upload(screen.getByLabelText("安装包"), new File(["installer"], "setup.exe"));
  await user.click(screen.getByRole("button", { name: "发布桌面更新" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wxauto-updates", expect.objectContaining({
    method: "POST",
    headers: { "x-update-publish-token": "publish-secret" }
  })));
});
```

- [ ] **Step 2: Run to verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/wxauto-update-panel.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused publisher**

Create a form component that:

- accepts semantic version, stable/beta channel, release notes, publish token, and `.exe`
- sends `FormData` to `/api/admin/wxauto-updates`
- never stores the publish token
- clears the token and file after success
- renders release version, channel, hash prefix, and published time

The submit handler must be:

```ts
async function publish(event: React.FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const token = String(formData.get("publishToken") ?? "");
  formData.delete("publishToken");
  const response = await fetch("/api/admin/wxauto-updates", {
    method: "POST",
    headers: { "x-update-publish-token": token },
    body: formData
  });
  if (!response.ok) throw new Error((await response.json()).message ?? "发布失败");
  form.reset();
  await onPublished();
}
```

Render the panel in the system configuration view and pass releases from admin bootstrap.

- [ ] **Step 4: Run component tests**

Run:

```powershell
npm.cmd run test:run -- tests/components/wxauto-update-panel.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-page.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/components/admin/wxauto-update-panel.tsx src/components/admin-panel.tsx src/components/admin-shell.tsx tests/components/wxauto-update-panel.test.tsx
git commit -m "feat: add wxauto update publisher UI"
```

## Task 12: Final Board Verification and Deployment Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/wxauto-rest-bridge-trial.md`
- Create: `docs/wxauto-desktop-board-deployment.md`
- Modify: `scripts/build-windows-package.ps1`

- [ ] **Step 1: Update deployment documentation**

Document these required production variables:

```text
WXAUTO_MCP_TOKEN
WXAUTO_UPDATE_PUBLISH_TOKEN
WXAUTO_UPDATE_SIGNING_PRIVATE_KEY
WXAUTO_UPDATE_SIGNING_PUBLIC_KEY
```

Document:

- MCP URL: `https://<board-host>/api/mcp`
- old HTTP bridge is compatibility-only
- update files require persistent `data/wxauto-updates`
- update public key must also be embedded in the desktop build
- `npm.cmd run db:migrate` is required before deployment

- [ ] **Step 2: Ensure the Windows board package includes the migration and update directory**

Update packaging so `db/migrations/003_wxauto_mcp.sql` is included and create an empty persistent `data/wxauto-updates` directory in deployment instructions, not inside immutable build output.

- [ ] **Step 3: Run the focused integration suite**

Run:

```powershell
npm.cmd run test:run -- tests/integrations/wxauto tests/api/mcp-route.test.ts tests/api/message-intake-route.test.ts tests/api/wechat-outbound-route.test.ts tests/api/wxauto-update-routes.test.ts tests/components/wxauto-agent-panel.test.tsx tests/components/wxauto-update-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Run all board verification**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
```

Expected: all tests pass and Next.js production build completes.

- [ ] **Step 5: Manual MCP smoke test**

Start the board with production-like environment variables, then run a temporary official SDK client that:

1. connects to `/api/mcp`
2. calls `register_wxauto_agent`
3. submits one non-operational test event
4. claims zero or more outbound messages

Expected: no authentication, protocol, or duplicate-processing errors.

- [ ] **Step 6: Commit**

```powershell
git add README.md docs/wxauto-rest-bridge-trial.md docs/wxauto-desktop-board-deployment.md scripts/build-windows-package.ps1
git commit -m "docs: document wxauto desktop board deployment"
```

## Plan Self-Review

- Every MCP tool has a contract, repository operation, route test, and desktop-facing stable result.
- Event idempotency is durable and keyed by agent plus message ID.
- Outbound claim and completion use leases and idempotent attempts.
- Legacy HTTP routes share the new semantics and remain rollback-compatible.
- Agent health and release publishing are visible in the admin interface.
- Update manifests are signed independently from Windows Authenticode.
- The MCP SDK is pinned to stable `1.29.0`; the alpha 2.x split packages are not used.
- OAuth is not implemented in this release, but bearer authentication is isolated in `auth.ts`.
