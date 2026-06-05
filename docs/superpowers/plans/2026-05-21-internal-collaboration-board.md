# 内部协同看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个移动端优先的内部协同工单看板，支持展位主数据导入、AI归类/判重、催单合并、派单、回复跟帖、超时升级和管理员配置。

**Architecture:** 使用 Next.js + TypeScript 建设前后端一体应用。核心业务逻辑放在 `src/lib/domain` 和 `src/lib/services`，API route 只负责入参校验和调用服务；第一版用文件存储保证可快速运行，AI 与向量检索通过适配器配置，默认提供可测试的本地模拟实现。

**Tech Stack:** Next.js, React, TypeScript, Vitest, React Testing Library, Zod, xlsx, lucide-react, file-backed JSON store.

---

## File Structure

Create these files from the repository root:

- `package.json`: 项目脚本与依赖。
- `next.config.ts`: Next.js 配置。
- `tsconfig.json`: TypeScript 配置。
- `vitest.config.ts`: 测试配置。
- `src/app/layout.tsx`: App 根布局。
- `src/app/page.tsx`: 移动端主入口。
- `src/app/api/bootstrap/route.ts`: 首屏数据接口。
- `src/app/api/tickets/route.ts`: 工单列表与新建接口。
- `src/app/api/tickets/[ticketId]/route.ts`: 工单详情与状态接口。
- `src/app/api/tickets/[ticketId]/replies/route.ts`: 跟帖回复接口。
- `src/app/api/admin/master-data/route.ts`: 展位主数据导入接口。
- `src/app/api/admin/config/route.ts`: 问题类型、AI模型、派单规则配置接口。
- `src/components/mobile-shell.tsx`: 移动端骨架和底部导航。
- `src/components/ticket-submit-form.tsx`: 工单提交。
- `src/components/ticket-list.tsx`: 按问题类型分组的列表。
- `src/components/ticket-detail.tsx`: 详情、时间线、跟帖区。
- `src/components/admin-panel.tsx`: 管理配置与表格导入。
- `src/components/status-pill.tsx`: 状态标签。
- `src/lib/domain/types.ts`: 核心类型。
- `src/lib/domain/workflow.ts`: 状态流与标题生成。
- `src/lib/domain/priority.ts`: 轻重缓急排序。
- `src/lib/domain/deduplication.ts`: 语义判重结果分流。
- `src/lib/domain/master-data.ts`: 表格主数据校验与映射。
- `src/lib/ai/types.ts`: AI接口类型。
- `src/lib/ai/router.ts`: 快速AI/高智商AI路由。
- `src/lib/ai/mock-provider.ts`: 本地AI模拟实现。
- `src/lib/storage/file-store.ts`: 文件存储读写。
- `src/lib/services/ticket-service.ts`: 工单业务服务。
- `src/lib/services/config-service.ts`: 管理配置服务。
- `src/lib/services/escalation-service.ts`: 超时推荐与优先级升级。
- `src/lib/seed.ts`: 首次运行默认配置。
- `src/styles/globals.css`: 移动端样式。
- `tests/domain/workflow.test.ts`: 状态、标题、受理时间测试。
- `tests/domain/priority.test.ts`: 排序测试。
- `tests/domain/deduplication.test.ts`: AI判重分流测试。
- `tests/domain/master-data.test.ts`: 表格导入测试。
- `tests/domain/ai-router.test.ts`: 双AI接口路由测试。
- `tests/services/ticket-service.test.ts`: 建单、合并、回复、回执测试。

## Task 1: Scaffold Project

**Files:**

- Create: `package.json`
- Create: `next.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/app/layout.tsx`
- Create: `src/app/page.tsx`
- Create: `src/styles/globals.css`

- [ ] **Step 1: Create dependency manifest**

Create `package.json`:

```json
{
  "name": "internal-collaboration-board",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "lucide-react": "latest",
    "next": "latest",
    "react": "latest",
    "react-dom": "latest",
    "xlsx": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/node": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Create TypeScript and test config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

Create `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true
};

export default nextConfig;
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  },
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  }
});
```

- [ ] **Step 3: Create a minimal app shell**

Create `src/app/layout.tsx`:

```tsx
import "@/styles/globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "内部协同看板",
  description: "移动端现场工单协同中心"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

Create `src/app/page.tsx`:

```tsx
export default function HomePage() {
  return <main className="app-shell">内部协同看板</main>;
}
```

Create `src/styles/globals.css`:

```css
:root {
  color-scheme: light;
  --bg: #f5f7f3;
  --panel: #ffffff;
  --ink: #1e2723;
  --muted: #66726b;
  --line: #dce4dc;
  --green: #236f52;
  --amber: #9a5a12;
  --red: #a33a31;
  --blue: #2f5f9f;
  --shadow: 0 16px 40px rgba(24, 40, 32, 0.12);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: linear-gradient(180deg, #eef4ec 0%, #f7f8f2 38%, #eef2ee 100%);
  color: var(--ink);
  font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif;
}

button,
input,
select,
textarea {
  font: inherit;
}

.app-shell {
  min-height: 100dvh;
  width: min(100%, 520px);
  margin: 0 auto;
  background: rgba(255, 255, 255, 0.72);
}
```

- [ ] **Step 4: Install and run the empty app**

Run: `npm install`

Expected: dependencies install without package resolution errors.

Run: `npm run build`

Expected: Next.js build completes and reports a production build.

- [ ] **Step 5: Commit scaffold**

Run:

```bash
git add package.json next.config.ts tsconfig.json vitest.config.ts src/app src/styles
git commit -m "chore: scaffold collaboration board app"
```

If `git` is unavailable in the environment, record the skipped commit in the working notes and continue.

## Task 2: Domain Model and Workflow

**Files:**

- Create: `tests/domain/workflow.test.ts`
- Create: `src/lib/domain/types.ts`
- Create: `src/lib/domain/workflow.ts`

- [ ] **Step 1: Write failing workflow tests**

Create `tests/domain/workflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { canTransition, createTicketTitle, elapsedSinceAccepted } from "@/lib/domain/workflow";
import type { TicketStatus } from "@/lib/domain/types";

describe("ticket workflow", () => {
  it("allows the configured status flow", () => {
    const allowed: Array<[TicketStatus, TicketStatus]> = [
      ["待受理", "处理中"],
      ["处理中", "挂起"],
      ["挂起", "处理中"],
      ["处理中", "已解决"],
      ["已解决", "已关闭"]
    ];

    for (const [from, to] of allowed) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("rejects invalid status jumps", () => {
    expect(canTransition("待受理", "已关闭")).toBe(false);
    expect(canTransition("挂起", "已关闭")).toBe(false);
  });

  it("generates title from booth number, company short name and issue type", () => {
    expect(createTicketTitle("A12", "星河科技", "网络")).toBe("A12 星河科技 网络");
  });

  it("calculates accepted elapsed minutes", () => {
    const acceptedAt = new Date("2026-05-21T08:00:00.000Z").toISOString();
    const now = new Date("2026-05-21T08:37:00.000Z").toISOString();

    expect(elapsedSinceAccepted(acceptedAt, now)).toBe(37);
    expect(elapsedSinceAccepted(undefined, now)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/domain/workflow.test.ts`

Expected: FAIL because `@/lib/domain/workflow` does not exist.

- [ ] **Step 3: Implement workflow types**

Create `src/lib/domain/types.ts`:

```ts
export type TicketStatus = "待受理" | "处理中" | "挂起" | "已解决" | "已关闭";
export type IssueTypeName = "自动" | string;
export type UserRole = "member" | "admin" | "handler" | "system-ai";

export type BoothRecord = {
  boothNumber: string;
  companyName: string;
  companyShortName: string;
  salesOwner: string;
  builder: string;
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
  endpoint?: string;
  apiKey?: string;
  modelName: string;
  timeoutMs: number;
  enabled: boolean;
};

export type AiDecision = {
  modelId: "fast" | "smart";
  scenario: "classify" | "dedupe" | "escalation";
  confidence: number;
  action: "create" | "urge" | "manual-review" | "classify";
  issueType?: string;
  matchedTicketId?: string;
  suggestion?: string;
  latencyMs: number;
};

export type TicketReply = {
  id: string;
  ticketId: string;
  authorId: string;
  authorName: string;
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
  feedbackUsers: Array<{ userId: string; userName: string; feedbackAt: string }>;
  status: TicketStatus;
  acceptedAt?: string;
  handlerId?: string;
  handlerName?: string;
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
```

- [ ] **Step 4: Implement workflow helpers**

Create `src/lib/domain/workflow.ts`:

```ts
import type { TicketStatus } from "./types";

const transitions: Record<TicketStatus, TicketStatus[]> = {
  待受理: ["处理中"],
  处理中: ["挂起", "已解决"],
  挂起: ["处理中"],
  已解决: ["已关闭"],
  已关闭: []
};

export function canTransition(from: TicketStatus, to: TicketStatus) {
  return transitions[from].includes(to);
}

export function createTicketTitle(boothNumber: string, companyShortName: string, issueType: string) {
  const safeCompany = companyShortName.trim() || "未知公司";
  return `${boothNumber.trim()} ${safeCompany} ${issueType.trim()}`;
}

export function elapsedSinceAccepted(acceptedAt: string | undefined, nowIso = new Date().toISOString()) {
  if (!acceptedAt) return 0;
  const elapsedMs = new Date(nowIso).getTime() - new Date(acceptedAt).getTime();
  return Math.max(0, Math.floor(elapsedMs / 60000));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:run -- tests/domain/workflow.test.ts`

Expected: PASS with 4 tests passing.

- [ ] **Step 6: Commit workflow domain**

Run:

```bash
git add src/lib/domain/types.ts src/lib/domain/workflow.ts tests/domain/workflow.test.ts
git commit -m "feat: add ticket workflow domain"
```

## Task 3: Master Data Import

**Files:**

- Create: `tests/domain/master-data.test.ts`
- Create: `src/lib/domain/master-data.ts`

- [ ] **Step 1: Write failing master data tests**

Create `tests/domain/master-data.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMasterDataRows, upsertBoothRecords } from "@/lib/domain/master-data";

describe("master data import", () => {
  it("validates booth, company, sales owner and builder columns", () => {
    const result = parseMasterDataRows([
      { 展位号: "A01", 公司名称: "上海星河科技有限公司", 业务员: "王宁", 搭建商: "青木搭建" },
      { 展位号: "", 公司名称: "缺展位公司", 业务员: "李敏", 搭建商: "工匠搭建" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "上海星河科技有限公司",
        companyShortName: "上海星河科技有限公司",
        salesOwner: "王宁",
        builder: "青木搭建"
      }
    ]);
    expect(result.errors).toEqual([{ row: 3, message: "展位号不能为空" }]);
  });

  it("upserts booth records by booth number", () => {
    const merged = upsertBoothRecords(
      [{ boothNumber: "A01", companyName: "旧公司", companyShortName: "旧公司", salesOwner: "旧业务", builder: "旧搭建" }],
      [{ boothNumber: "A01", companyName: "新公司", companyShortName: "新公司", salesOwner: "新业务", builder: "新搭建" }]
    );

    expect(merged).toEqual([
      { boothNumber: "A01", companyName: "新公司", companyShortName: "新公司", salesOwner: "新业务", builder: "新搭建" }
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/domain/master-data.test.ts`

Expected: FAIL because `@/lib/domain/master-data` does not exist.

- [ ] **Step 3: Implement master data parser**

Create `src/lib/domain/master-data.ts`:

```ts
import type { BoothRecord } from "./types";

type RawRow = Record<string, unknown>;

export type MasterDataImportResult = {
  records: BoothRecord[];
  errors: Array<{ row: number; message: string }>;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function parseMasterDataRows(rows: RawRow[]): MasterDataImportResult {
  const records: BoothRecord[] = [];
  const errors: Array<{ row: number; message: string }> = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const boothNumber = text(row["展位号"] ?? row["boothNumber"]);
    const companyName = text(row["公司名称"] ?? row["companyName"]);
    const salesOwner = text(row["业务员"] ?? row["salesOwner"]);
    const builder = text(row["搭建商"] ?? row["builder"]);
    const companyShortName = text(row["公司简称"] ?? row["companyShortName"] ?? companyName);

    if (!boothNumber) errors.push({ row: rowNumber, message: "展位号不能为空" });
    if (!companyName) errors.push({ row: rowNumber, message: "公司名称不能为空" });
    if (!salesOwner) errors.push({ row: rowNumber, message: "业务员不能为空" });
    if (!builder) errors.push({ row: rowNumber, message: "搭建商不能为空" });

    if (boothNumber && companyName && salesOwner && builder) {
      records.push({ boothNumber, companyName, companyShortName, salesOwner, builder });
    }
  });

  return { records, errors };
}

export function upsertBoothRecords(existing: BoothRecord[], incoming: BoothRecord[]) {
  const byBooth = new Map(existing.map((record) => [record.boothNumber, record]));
  incoming.forEach((record) => byBooth.set(record.boothNumber, record));
  return Array.from(byBooth.values()).sort((a, b) => a.boothNumber.localeCompare(b.boothNumber, "zh-CN"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/domain/master-data.test.ts`

Expected: PASS with 2 tests passing.

- [ ] **Step 5: Commit master data domain**

Run:

```bash
git add src/lib/domain/master-data.ts tests/domain/master-data.test.ts
git commit -m "feat: add booth master data import rules"
```

## Task 4: AI Router and Deduplication

**Files:**

- Create: `tests/domain/ai-router.test.ts`
- Create: `tests/domain/deduplication.test.ts`
- Create: `src/lib/ai/types.ts`
- Create: `src/lib/ai/mock-provider.ts`
- Create: `src/lib/ai/router.ts`
- Create: `src/lib/domain/deduplication.ts`

- [ ] **Step 1: Write failing AI routing tests**

Create `tests/domain/ai-router.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAiRouter } from "@/lib/ai/router";
import { mockAiProvider } from "@/lib/ai/mock-provider";
import type { AiModelConfig } from "@/lib/domain/types";

const models: AiModelConfig[] = [
  { id: "fast", label: "快速AI", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
  { id: "smart", label: "高智商AI", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
];

describe("ai router", () => {
  it("uses fast ai for classification", async () => {
    const router = createAiRouter({ models, provider: mockAiProvider });
    const decision = await router.classifyIssue("A01", "网络断了，展台不能扫码");

    expect(decision.modelId).toBe("fast");
    expect(decision.action).toBe("classify");
    expect(decision.issueType).toBe("网络");
  });

  it("uses smart ai for escalation advice", async () => {
    const router = createAiRouter({ models, provider: mockAiProvider });
    const decision = await router.escalate("A01", "网络断了", []);

    expect(decision.modelId).toBe("smart");
    expect(decision.suggestion).toContain("优先核查");
  });
});
```

Create `tests/domain/deduplication.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decideDeduplication } from "@/lib/domain/deduplication";

describe("deduplication", () => {
  it("routes high confidence duplicate to urge", () => {
    expect(decideDeduplication(0.91)).toBe("urge");
  });

  it("routes medium confidence duplicate to manual review", () => {
    expect(decideDeduplication(0.72)).toBe("manual-review");
  });

  it("routes low confidence issue to create", () => {
    expect(decideDeduplication(0.31)).toBe("create");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:run -- tests/domain/ai-router.test.ts tests/domain/deduplication.test.ts`

Expected: FAIL because AI router and deduplication modules do not exist.

- [ ] **Step 3: Implement AI interfaces and mock provider**

Create `src/lib/ai/types.ts`:

```ts
import type { AiDecision, AiModelConfig, Ticket } from "@/lib/domain/types";

export type AiProvider = {
  classify(model: AiModelConfig, boothNumber: string, description: string): Promise<AiDecision>;
  dedupe(model: AiModelConfig, boothNumber: string, description: string, candidates: Ticket[]): Promise<AiDecision>;
  escalate(model: AiModelConfig, boothNumber: string, description: string, similarTickets: Ticket[]): Promise<AiDecision>;
};
```

Create `src/lib/ai/mock-provider.ts`:

```ts
import type { AiProvider } from "./types";

function detectIssueType(description: string) {
  if (/网|网络|扫码|wifi|Wi-Fi/i.test(description)) return "网络";
  if (/电|插座|跳闸|照明/.test(description)) return "电力";
  if (/搭建|展架|板墙|施工/.test(description)) return "搭建";
  return "综合服务";
}

function similarity(a: string, b: string) {
  const left = new Set(a.replace(/\s+/g, "").split(""));
  const right = new Set(b.replace(/\s+/g, "").split(""));
  const overlap = Array.from(left).filter((char) => right.has(char)).length;
  return overlap / Math.max(1, Math.min(left.size, right.size));
}

export const mockAiProvider: AiProvider = {
  async classify(model, boothNumber, description) {
    return {
      modelId: model.id,
      scenario: "classify",
      confidence: 0.86,
      action: "classify",
      issueType: detectIssueType(description),
      latencyMs: model.id === "fast" ? 120 : 380
    };
  },
  async dedupe(model, boothNumber, description, candidates) {
    const sameBooth = candidates.filter((ticket) => ticket.boothNumber === boothNumber);
    const best = sameBooth
      .map((ticket) => ({ ticket, score: similarity(description, ticket.description) }))
      .sort((a, b) => b.score - a.score)[0];

    return {
      modelId: model.id,
      scenario: "dedupe",
      confidence: best?.score ?? 0,
      action: "create",
      matchedTicketId: best?.ticket.id,
      latencyMs: model.id === "fast" ? 150 : 420
    };
  },
  async escalate(model, boothNumber, description, similarTickets) {
    return {
      modelId: model.id,
      scenario: "escalation",
      confidence: 0.81,
      action: "manual-review",
      suggestion: `展位${boothNumber}已超时，优先核查责任人响应、历史相似工单和现场资源占用。`,
      matchedTicketId: similarTickets[0]?.id,
      latencyMs: 520
    };
  }
};
```

- [ ] **Step 4: Implement AI router and dedupe decision**

Create `src/lib/ai/router.ts`:

```ts
import type { Ticket } from "@/lib/domain/types";
import type { AiProvider } from "./types";
import type { AiModelConfig } from "@/lib/domain/types";

type RouterOptions = {
  models: AiModelConfig[];
  provider: AiProvider;
};

function getEnabledModel(models: AiModelConfig[], id: "fast" | "smart") {
  const model = models.find((item) => item.id === id && item.enabled);
  if (!model) throw new Error(`${id} AI未启用`);
  return model;
}

export function createAiRouter({ models, provider }: RouterOptions) {
  return {
    classifyIssue(boothNumber: string, description: string) {
      return provider.classify(getEnabledModel(models, "fast"), boothNumber, description);
    },
    dedupeIssue(boothNumber: string, description: string, candidates: Ticket[]) {
      return provider.dedupe(getEnabledModel(models, "smart"), boothNumber, description, candidates);
    },
    escalate(boothNumber: string, description: string, similarTickets: Ticket[]) {
      return provider.escalate(getEnabledModel(models, "smart"), boothNumber, description, similarTickets);
    }
  };
}
```

Create `src/lib/domain/deduplication.ts`:

```ts
export type DeduplicationAction = "create" | "urge" | "manual-review";

export function decideDeduplication(confidence: number): DeduplicationAction {
  if (confidence >= 0.86) return "urge";
  if (confidence >= 0.62) return "manual-review";
  return "create";
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:run -- tests/domain/ai-router.test.ts tests/domain/deduplication.test.ts`

Expected: PASS with 5 tests passing.

- [ ] **Step 6: Commit AI routing**

Run:

```bash
git add src/lib/ai src/lib/domain/deduplication.ts tests/domain/ai-router.test.ts tests/domain/deduplication.test.ts
git commit -m "feat: add ai routing and deduplication"
```

## Task 5: Priority, Assignment, and Escalation

**Files:**

- Create: `tests/domain/priority.test.ts`
- Create: `src/lib/domain/priority.ts`
- Create: `src/lib/services/escalation-service.ts`

- [ ] **Step 1: Write failing priority tests**

Create `tests/domain/priority.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calculatePriorityScore, sortTicketsByPriority } from "@/lib/domain/priority";
import type { Ticket } from "@/lib/domain/types";

function ticket(overrides: Partial<Ticket>): Ticket {
  return {
    id: "T-1",
    title: "A01 星河 网络",
    boothNumber: "A01",
    companyName: "星河",
    companyShortName: "星河",
    description: "网络断了",
    imageUrls: [],
    issueType: "网络",
    submitterId: "u1",
    submitterName: "张三",
    feedbackUsers: [],
    status: "处理中",
    handlerId: "h1",
    handlerName: "李工",
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 0,
    aiDecisions: [],
    replies: [],
    timeline: [],
    createdAt: "2026-05-21T08:00:00.000Z",
    updatedAt: "2026-05-21T08:00:00.000Z",
    ...overrides
  };
}

describe("priority", () => {
  it("uses severity, urge count and accepted elapsed minutes", () => {
    expect(calculatePriorityScore({ issueWeight: 20, riskWeight: 15, urgeCount: 2, acceptedElapsedMinutes: 30 })).toBe(85);
  });

  it("sorts urgent tickets first", () => {
    const sorted = sortTicketsByPriority([
      ticket({ id: "low", priorityScore: 10, createdAt: "2026-05-21T08:00:00.000Z" }),
      ticket({ id: "high", priorityScore: 90, createdAt: "2026-05-21T09:00:00.000Z" })
    ]);

    expect(sorted.map((item) => item.id)).toEqual(["high", "low"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/domain/priority.test.ts`

Expected: FAIL because priority module does not exist.

- [ ] **Step 3: Implement priority scoring**

Create `src/lib/domain/priority.ts`:

```ts
import type { Ticket } from "./types";

export function calculatePriorityScore(input: {
  issueWeight: number;
  riskWeight: number;
  urgeCount: number;
  acceptedElapsedMinutes: number;
}) {
  return input.issueWeight + input.riskWeight + input.urgeCount * 10 + Math.floor(input.acceptedElapsedMinutes / 2);
}

export function detectRiskWeight(description: string) {
  if (/安全|漏电|坍塌|受伤|火|烟/.test(description)) return 40;
  if (/断网|断电|无法|投诉|拥堵/.test(description)) return 20;
  return 0;
}

export function sortTicketsByPriority(tickets: Ticket[]) {
  return [...tickets].sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    const aUrged = new Date(a.lastUrgedAt ?? 0).getTime();
    const bUrged = new Date(b.lastUrgedAt ?? 0).getTime();
    if (bUrged !== aUrged) return bUrged - aUrged;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}
```

- [ ] **Step 4: Implement escalation service**

Create `src/lib/services/escalation-service.ts`:

```ts
import type { Ticket } from "@/lib/domain/types";
import { calculatePriorityScore, detectRiskWeight } from "@/lib/domain/priority";
import { elapsedSinceAccepted } from "@/lib/domain/workflow";

export function refreshTicketPriority(ticket: Ticket, issueWeight: number, nowIso = new Date().toISOString()): Ticket {
  const acceptedElapsedMinutes = elapsedSinceAccepted(ticket.acceptedAt, nowIso);
  const priorityScore = calculatePriorityScore({
    issueWeight,
    riskWeight: detectRiskWeight(ticket.description),
    urgeCount: ticket.urgeCount,
    acceptedElapsedMinutes
  });

  return { ...ticket, priorityScore, updatedAt: nowIso };
}

export function escalateTimedOutTicket(ticket: Ticket, suggestion: string, nowIso = new Date().toISOString()): Ticket {
  const urgeLevel = Math.min(3, ticket.urgeLevel + 1) as Ticket["urgeLevel"];
  return {
    ...ticket,
    urgeLevel,
    priorityScore: ticket.priorityScore + 15,
    aiDecisions: [
      ...ticket.aiDecisions,
      {
        modelId: "smart",
        scenario: "escalation",
        confidence: 0.8,
        action: "manual-review",
        suggestion,
        latencyMs: 0
      }
    ],
    timeline: [
      ...ticket.timeline,
      {
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        type: "ai-suggestion",
        body: suggestion,
        createdAt: nowIso,
        actorName: "系统AI"
      }
    ],
    updatedAt: nowIso
  };
}
```

- [ ] **Step 5: Run priority tests**

Run: `npm run test:run -- tests/domain/priority.test.ts`

Expected: PASS with 2 tests passing.

- [ ] **Step 6: Commit priority and escalation**

Run:

```bash
git add src/lib/domain/priority.ts src/lib/services/escalation-service.ts tests/domain/priority.test.ts
git commit -m "feat: add priority and escalation rules"
```

## Task 6: File Store, Seed Config, and Ticket Service

**Files:**

- Create: `tests/services/ticket-service.test.ts`
- Create: `src/lib/storage/file-store.ts`
- Create: `src/lib/seed.ts`
- Create: `src/lib/services/config-service.ts`
- Create: `src/lib/services/ticket-service.ts`

- [ ] **Step 1: Write failing ticket service tests**

Create `tests/services/ticket-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createTicketService } from "@/lib/services/ticket-service";
import { defaultConfig } from "@/lib/seed";

describe("ticket service", () => {
  it("creates a new ticket with generated title and accepted booth data", async () => {
    const service = createTicketService({
      state: {
        booths: [{ boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }],
        tickets: [],
        config: defaultConfig()
      }
    });

    const result = await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(result.kind).toBe("created");
    expect(result.ticket.title).toBe("A01 星河科技 网络");
    expect(result.ticket.status).toBe("待受理");
  });

  it("turns high confidence same-booth duplicate into an urge", async () => {
    const service = createTicketService({
      state: {
        booths: [{ boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }],
        tickets: [],
        config: defaultConfig()
      }
    });

    await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    const second = await service.submitTicket({
      boothNumber: "A01",
      description: "网络完全断开，扫码收款失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u2",
      submitterName: "李四"
    });

    expect(second.kind).toBe("urged");
    expect(second.ticket.urgeCount).toBe(1);
    expect(second.ticket.feedbackUsers.map((user) => user.userName)).toContain("李四");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/services/ticket-service.test.ts`

Expected: FAIL because ticket service and seed modules do not exist.

- [ ] **Step 3: Implement seed config**

Create `src/lib/seed.ts`:

```ts
import type { AiModelConfig, IssueType } from "@/lib/domain/types";

export type AppConfig = {
  issueTypes: IssueType[];
  aiModels: AiModelConfig[];
  assignmentRules: Array<{ id: string; boothPattern: string; issueType: string; handlerId: string; handlerName: string; groupName: string }>;
};

export function defaultConfig(): AppConfig {
  return {
    issueTypes: [
      { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true },
      { id: "power", name: "电力", urgencyMinutes: 15, priorityWeight: 30, assignmentGroup: "工程组", enabled: true },
      { id: "build", name: "搭建", urgencyMinutes: 30, priorityWeight: 20, assignmentGroup: "搭建组", enabled: true },
      { id: "service", name: "综合服务", urgencyMinutes: 45, priorityWeight: 10, assignmentGroup: "客服组", enabled: true }
    ],
    aiModels: [
      { id: "fast", label: "快速AI", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
      { id: "smart", label: "高智商AI", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
    ],
    assignmentRules: [
      { id: "network-a", boothPattern: "A", issueType: "网络", handlerId: "h-network", handlerName: "网络值班", groupName: "网络组" },
      { id: "power-a", boothPattern: "A", issueType: "电力", handlerId: "h-power", handlerName: "工程值班", groupName: "工程组" }
    ]
  };
}
```

- [ ] **Step 4: Implement file store**

Create `src/lib/storage/file-store.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BoothRecord, Ticket } from "@/lib/domain/types";
import { defaultConfig, type AppConfig } from "@/lib/seed";

export type AppState = {
  booths: BoothRecord[];
  tickets: Ticket[];
  config: AppConfig;
};

const dataDir = path.join(process.cwd(), "data");
const dataFile = path.join(dataDir, "app-state.json");

export function initialState(): AppState {
  return {
    booths: [],
    tickets: [],
    config: defaultConfig()
  };
}

export async function readState(): Promise<AppState> {
  try {
    const raw = await readFile(dataFile, "utf-8");
    return JSON.parse(raw) as AppState;
  } catch {
    const state = initialState();
    await writeState(state);
    return state;
  }
}

export async function writeState(state: AppState) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, JSON.stringify(state, null, 2), "utf-8");
}
```

- [ ] **Step 5: Implement config service**

Create `src/lib/services/config-service.ts`:

```ts
import type { AppConfig } from "@/lib/seed";

export function validateConfig(config: AppConfig) {
  const enabledIssueTypes = config.issueTypes.filter((item) => item.enabled);
  if (enabledIssueTypes.length < 1) throw new Error("至少需要配置1个非自动问题类型");
  if (!config.aiModels.some((model) => model.id === "fast" && model.enabled)) throw new Error("快速AI未启用");
  if (!config.aiModels.some((model) => model.id === "smart" && model.enabled)) throw new Error("高智商AI未启用");
  return config;
}
```

- [ ] **Step 6: Implement ticket service**

Create `src/lib/services/ticket-service.ts`:

```ts
import { mockAiProvider } from "@/lib/ai/mock-provider";
import { createAiRouter } from "@/lib/ai/router";
import { decideDeduplication } from "@/lib/domain/deduplication";
import { detectRiskWeight } from "@/lib/domain/priority";
import type { BoothRecord, Ticket } from "@/lib/domain/types";
import { createTicketTitle } from "@/lib/domain/workflow";
import type { AppState } from "@/lib/storage/file-store";

export type SubmitTicketInput = {
  boothNumber: string;
  description: string;
  imageUrls: string[];
  issueType: string;
  submitterId: string;
  submitterName: string;
};

export type SubmitTicketResult = {
  kind: "created" | "urged" | "manual-review";
  ticket: Ticket;
};

function now() {
  return new Date().toISOString();
}

function findBooth(booths: BoothRecord[], boothNumber: string): BoothRecord {
  return booths.find((booth) => booth.boothNumber === boothNumber) ?? {
    boothNumber,
    companyName: "未知公司",
    companyShortName: "未知公司",
    salesOwner: "",
    builder: ""
  };
}

function assignHandler(state: AppState, boothNumber: string, issueType: string) {
  return state.config.assignmentRules.find((rule) => boothNumber.startsWith(rule.boothPattern) && rule.issueType === issueType);
}

export function createTicketService({ state }: { state: AppState }) {
  const ai = createAiRouter({ models: state.config.aiModels, provider: mockAiProvider });

  return {
    async submitTicket(input: SubmitTicketInput): Promise<SubmitTicketResult> {
      const createdAt = now();
      const booth = findBooth(state.booths, input.boothNumber);
      const classification = input.issueType === "自动"
        ? await ai.classifyIssue(input.boothNumber, input.description)
        : undefined;
      const issueType = classification?.issueType ?? input.issueType;
      const candidates = state.tickets.filter((ticket) => ticket.boothNumber === input.boothNumber && ticket.status !== "已关闭");
      const dedupe = await ai.dedupeIssue(input.boothNumber, input.description, candidates);
      const dedupeAction = decideDeduplication(dedupe.confidence);
      const matched = candidates.find((ticket) => ticket.id === dedupe.matchedTicketId);

      if (dedupeAction === "urge" && matched) {
        matched.urgeCount += 1;
        matched.lastUrgedAt = createdAt;
        matched.urgeLevel = Math.min(3, matched.urgeLevel + 1) as Ticket["urgeLevel"];
        matched.feedbackUsers.push({ userId: input.submitterId, userName: input.submitterName, feedbackAt: createdAt });
        matched.aiDecisions.push(dedupe);
        matched.timeline.push({
          id: crypto.randomUUID(),
          ticketId: matched.id,
          type: "urged",
          body: `${input.submitterName}反馈了相似问题，系统按催单处理。`,
          createdAt,
          actorName: "系统AI"
        });
        matched.updatedAt = createdAt;
        return { kind: "urged", ticket: matched };
      }

      const rule = assignHandler(state, input.boothNumber, issueType);
      const ticket: Ticket = {
        id: crypto.randomUUID(),
        title: createTicketTitle(input.boothNumber, booth.companyShortName, issueType),
        boothNumber: input.boothNumber,
        companyName: booth.companyName,
        companyShortName: booth.companyShortName,
        description: input.description,
        imageUrls: input.imageUrls,
        issueType,
        submitterId: input.submitterId,
        submitterName: input.submitterName,
        feedbackUsers: [{ userId: input.submitterId, userName: input.submitterName, feedbackAt: createdAt }],
        status: rule ? "处理中" : "待受理",
        acceptedAt: rule ? createdAt : undefined,
        handlerId: rule?.handlerId,
        handlerName: rule?.handlerName,
        assignmentGroup: rule?.groupName,
        urgeCount: 0,
        urgeLevel: 0,
        priorityScore: detectRiskWeight(input.description),
        aiDecisions: [classification, dedupe].filter(Boolean) as Ticket["aiDecisions"],
        replies: [],
        timeline: [
          { id: crypto.randomUUID(), ticketId: "pending", type: "submitted", body: input.description, createdAt, actorName: input.submitterName }
        ],
        createdAt,
        updatedAt: createdAt
      };
      ticket.timeline = ticket.timeline.map((item) => ({ ...item, ticketId: ticket.id }));

      state.tickets.push(ticket);
      return { kind: dedupeAction === "manual-review" ? "manual-review" : "created", ticket };
    }
  };
}
```

- [ ] **Step 7: Run service tests**

Run: `npm run test:run -- tests/services/ticket-service.test.ts`

Expected: PASS with 2 tests passing.

- [ ] **Step 8: Commit services**

Run:

```bash
git add src/lib/storage src/lib/seed.ts src/lib/services tests/services/ticket-service.test.ts
git commit -m "feat: add ticket service and file store"
```

## Task 7: API Routes

**Files:**

- Create: `src/app/api/bootstrap/route.ts`
- Create: `src/app/api/tickets/route.ts`
- Create: `src/app/api/tickets/[ticketId]/route.ts`
- Create: `src/app/api/tickets/[ticketId]/replies/route.ts`
- Create: `src/app/api/admin/master-data/route.ts`
- Create: `src/app/api/admin/config/route.ts`

- [ ] **Step 1: Implement bootstrap route**

Create `src/app/api/bootstrap/route.ts`:

```ts
import { NextResponse } from "next/server";
import { sortTicketsByPriority } from "@/lib/domain/priority";
import { readState } from "@/lib/storage/file-store";

export async function GET() {
  const state = await readState();
  return NextResponse.json({
    tickets: sortTicketsByPriority(state.tickets),
    booths: state.booths,
    config: state.config
  });
}
```

- [ ] **Step 2: Implement ticket list and submit route**

Create `src/app/api/tickets/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { sortTicketsByPriority } from "@/lib/domain/priority";
import { createTicketService } from "@/lib/services/ticket-service";
import { readState, writeState } from "@/lib/storage/file-store";

const submitSchema = z.object({
  boothNumber: z.string().min(1),
  description: z.string().min(2),
  imageUrls: z.array(z.string()).default([]),
  issueType: z.string().min(1),
  submitterId: z.string().min(1),
  submitterName: z.string().min(1)
});

export async function GET() {
  const state = await readState();
  return NextResponse.json({ tickets: sortTicketsByPriority(state.tickets) });
}

export async function POST(request: Request) {
  const state = await readState();
  const input = submitSchema.parse(await request.json());
  const service = createTicketService({ state });
  const result = await service.submitTicket(input);
  await writeState(state);
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Implement detail and status route**

Create `src/app/api/tickets/[ticketId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { canTransition } from "@/lib/domain/workflow";
import { readState, writeState } from "@/lib/storage/file-store";

const statusSchema = z.object({
  status: z.enum(["待受理", "处理中", "挂起", "已解决", "已关闭"]),
  actorName: z.string().min(1),
  handlerId: z.string().optional(),
  handlerName: z.string().optional()
});

export async function GET(_: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const state = await readState();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  return NextResponse.json({ ticket });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const input = statusSchema.parse(await request.json());
  const state = await readState();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });
  if (!canTransition(ticket.status, input.status)) return NextResponse.json({ message: "状态流转不允许" }, { status: 400 });

  const now = new Date().toISOString();
  ticket.status = input.status;
  ticket.handlerId = input.handlerId ?? ticket.handlerId;
  ticket.handlerName = input.handlerName ?? ticket.handlerName;
  ticket.acceptedAt = input.status === "处理中" ? ticket.acceptedAt ?? now : ticket.acceptedAt;
  ticket.updatedAt = now;
  ticket.timeline.push({
    id: crypto.randomUUID(),
    ticketId,
    type: "status-changed",
    body: `状态变更为${input.status}`,
    createdAt: now,
    actorName: input.actorName
  });

  await writeState(state);
  return NextResponse.json({ ticket });
}
```

- [ ] **Step 4: Implement replies route**

Create `src/app/api/tickets/[ticketId]/replies/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { readState, writeState } from "@/lib/storage/file-store";

const replySchema = z.object({
  authorId: z.string().min(1),
  authorName: z.string().min(1),
  role: z.enum(["member", "admin", "handler", "system-ai"]),
  body: z.string().min(1),
  imageUrls: z.array(z.string()).default([])
});

export async function POST(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const input = replySchema.parse(await request.json());
  const state = await readState();
  const ticket = state.tickets.find((item) => item.id === ticketId);
  if (!ticket) return NextResponse.json({ message: "工单不存在" }, { status: 404 });

  const now = new Date().toISOString();
  const reply = { id: crypto.randomUUID(), ticketId, createdAt: now, ...input };
  ticket.replies.push(reply);
  ticket.timeline.push({ id: crypto.randomUUID(), ticketId, type: "reply", body: input.body, createdAt: now, actorName: input.authorName });
  ticket.updatedAt = now;
  await writeState(state);
  return NextResponse.json({ reply, ticket });
}
```

- [ ] **Step 5: Implement admin master-data route**

Create `src/app/api/admin/master-data/route.ts`:

```ts
import { NextResponse } from "next/server";
import { parseMasterDataRows, upsertBoothRecords } from "@/lib/domain/master-data";
import { readState, writeState } from "@/lib/storage/file-store";

export async function POST(request: Request) {
  const body = await request.json();
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const dryRun = Boolean(body.dryRun);
  const result = parseMasterDataRows(rows);
  if (result.errors.length > 0) return NextResponse.json(result, { status: 400 });
  if (dryRun) return NextResponse.json(result);

  const state = await readState();
  state.booths = upsertBoothRecords(state.booths, result.records);
  await writeState(state);
  return NextResponse.json({ ...result, booths: state.booths });
}
```

- [ ] **Step 6: Implement admin config route**

Create `src/app/api/admin/config/route.ts`:

```ts
import { NextResponse } from "next/server";
import { validateConfig } from "@/lib/services/config-service";
import { readState, writeState } from "@/lib/storage/file-store";

export async function GET() {
  const state = await readState();
  return NextResponse.json({ config: state.config });
}

export async function PUT(request: Request) {
  const state = await readState();
  state.config = validateConfig(await request.json());
  await writeState(state);
  return NextResponse.json({ config: state.config });
}
```

- [ ] **Step 7: Build API routes**

Run: `npm run build`

Expected: build completes without route type errors.

- [ ] **Step 8: Commit API routes**

Run:

```bash
git add src/app/api
git commit -m "feat: add collaboration board api routes"
```

## Task 8: Mobile UI

**Files:**

- Modify: `src/app/page.tsx`
- Modify: `src/styles/globals.css`
- Create: `src/components/mobile-shell.tsx`
- Create: `src/components/status-pill.tsx`
- Create: `src/components/ticket-submit-form.tsx`
- Create: `src/components/ticket-list.tsx`
- Create: `src/components/ticket-detail.tsx`
- Create: `src/components/admin-panel.tsx`

- [ ] **Step 1: Create mobile shell**

Create `src/components/mobile-shell.tsx`:

```tsx
"use client";

import { ClipboardList, PlusCircle, Settings, UserRound } from "lucide-react";

export type MobileTab = "submit" | "tickets" | "mine" | "admin";

export function MobileShell({ activeTab, onTabChange, children }: { activeTab: MobileTab; onTabChange: (tab: MobileTab) => void; children: React.ReactNode }) {
  const tabs = [
    { id: "submit" as const, label: "提交", icon: PlusCircle },
    { id: "tickets" as const, label: "工单", icon: ClipboardList },
    { id: "mine" as const, label: "我的", icon: UserRound },
    { id: "admin" as const, label: "管理", icon: Settings }
  ];

  return (
    <main className="mobile-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">现场协同</p>
          <h1>内部工单看板</h1>
        </div>
        <span className="live-dot">运行中</span>
      </header>
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
```

- [ ] **Step 2: Create status pill**

Create `src/components/status-pill.tsx`:

```tsx
import type { TicketStatus } from "@/lib/domain/types";

export function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}
```

- [ ] **Step 3: Create submit form**

Create `src/components/ticket-submit-form.tsx`:

```tsx
"use client";

import { ImagePlus, Send } from "lucide-react";
import type { AppConfig } from "@/lib/seed";

type Props = {
  config: AppConfig;
  onSubmitted: () => void;
};

export function TicketSubmitForm({ config, onSubmitted }: Props) {
  async function submit(formData: FormData) {
    const payload = {
      boothNumber: String(formData.get("boothNumber") ?? ""),
      description: String(formData.get("description") ?? ""),
      issueType: String(formData.get("issueType") ?? "自动"),
      imageUrls: [],
      submitterId: "mobile-user",
      submitterName: String(formData.get("submitterName") ?? "现场成员")
    };

    const response = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("提交失败");
    onSubmitted();
  }

  return (
    <form className="stack-form" action={submit}>
      <label>
        <span>反馈人</span>
        <input name="submitterName" defaultValue="现场成员" />
      </label>
      <label>
        <span>展位号</span>
        <input name="boothNumber" placeholder="例如 A01" required />
      </label>
      <label>
        <span>问题类型</span>
        <select name="issueType" defaultValue="自动">
          <option value="自动">自动</option>
          {config.issueTypes.filter((item) => item.enabled).map((item) => (
            <option key={item.id} value={item.name}>{item.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>问题描述</span>
        <textarea name="description" rows={5} placeholder="描述现场情况、影响范围和已尝试处理方式" required />
      </label>
      <button className="secondary-button" type="button">
        <ImagePlus size={18} aria-hidden="true" />
        添加图片
      </button>
      <button className="primary-button" type="submit">
        <Send size={18} aria-hidden="true" />
        提交工单
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Create ticket list**

Create `src/components/ticket-list.tsx`:

```tsx
"use client";

import type { Ticket } from "@/lib/domain/types";
import { StatusPill } from "./status-pill";

export function TicketList({ tickets, selectedId, onSelect }: { tickets: Ticket[]; selectedId?: string; onSelect: (id: string) => void }) {
  const groups = tickets.reduce((acc, ticket) => {
    const list = acc.get(ticket.issueType) ?? [];
    list.push(ticket);
    acc.set(ticket.issueType, list);
    return acc;
  }, new Map<string, Ticket[]>());

  return (
    <div className="ticket-groups">
      {Array.from(groups.entries()).map(([issueType, items]) => (
        <section className="issue-group" key={issueType}>
          <div className="group-heading">
            <h2>{issueType}</h2>
            <span>{items.length}</span>
          </div>
          {items.map((ticket) => (
            <button key={ticket.id} className={`ticket-row ${selectedId === ticket.id ? "selected" : ""}`} onClick={() => onSelect(ticket.id)} type="button">
              <div>
                <strong>{ticket.title}</strong>
                <p>{ticket.description}</p>
              </div>
              <div className="row-meta">
                <StatusPill status={ticket.status} />
                <span>催 {ticket.urgeCount}</span>
              </div>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Create ticket detail**

Create `src/components/ticket-detail.tsx`:

```tsx
"use client";

import { MessageSquareReply } from "lucide-react";
import type { Ticket } from "@/lib/domain/types";
import { StatusPill } from "./status-pill";

export function TicketDetail({ ticket, onRefresh }: { ticket?: Ticket; onRefresh: () => void }) {
  if (!ticket) return <section className="empty-state">选择一个工单查看处理详情</section>;

  async function addReply(formData: FormData) {
    await fetch(`/api/tickets/${ticket.id}/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorId: "mobile-user",
        authorName: String(formData.get("authorName") ?? "现场成员"),
        role: "member",
        body: String(formData.get("body") ?? ""),
        imageUrls: []
      })
    });
    onRefresh();
  }

  return (
    <article className="detail-panel">
      <div className="detail-head">
        <div>
          <h2>{ticket.title}</h2>
          <p>{ticket.companyName}</p>
        </div>
        <StatusPill status={ticket.status} />
      </div>
      <dl className="fact-grid">
        <div><dt>处理人</dt><dd>{ticket.handlerName ?? "待派单"}</dd></div>
        <div><dt>催单</dt><dd>{ticket.urgeCount}次</dd></div>
        <div><dt>反馈人数</dt><dd>{ticket.feedbackUsers.length}人</dd></div>
        <div><dt>优先级</dt><dd>{ticket.priorityScore}</dd></div>
      </dl>
      <section className="timeline">
        {ticket.timeline.map((item) => (
          <div key={item.id} className="timeline-item">
            <span>{item.actorName}</span>
            <p>{item.body}</p>
          </div>
        ))}
      </section>
      <form className="reply-box" action={addReply}>
        <input name="authorName" defaultValue="现场成员" />
        <textarea name="body" placeholder="追加现场信息或处理回复" required />
        <button type="submit">
          <MessageSquareReply size={18} aria-hidden="true" />
          回复
        </button>
      </form>
    </article>
  );
}
```

- [ ] **Step 6: Create admin panel**

Create `src/components/admin-panel.tsx`:

```tsx
"use client";

import * as XLSX from "xlsx";
import type { AppConfig } from "@/lib/seed";

export function AdminPanel({ config, onRefresh }: { config: AppConfig; onRefresh: () => void }) {
  async function importFile(file: File) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(firstSheet);
    const response = await fetch("/api/admin/master-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, dryRun: false })
    });
    if (!response.ok) throw new Error("主数据导入失败");
    onRefresh();
  }

  return (
    <section className="admin-panel">
      <h2>管理配置</h2>
      <label className="file-import">
        <span>上传展位主数据</span>
        <input accept=".xlsx,.xls,.csv" type="file" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importFile(file);
        }} />
      </label>
      <div className="config-list">
        <h3>问题类型</h3>
        {config.issueTypes.map((item) => (
          <div key={item.id} className="config-row">
            <span>{item.name}</span>
            <span>{item.urgencyMinutes}分钟可催</span>
          </div>
        ))}
      </div>
      <div className="config-list">
        <h3>AI接口</h3>
        {config.aiModels.map((item) => (
          <div key={item.id} className="config-row">
            <span>{item.label}</span>
            <span>{item.modelName}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 7: Wire the page**

Modify `src/app/page.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { AdminPanel } from "@/components/admin-panel";
import { MobileShell, type MobileTab } from "@/components/mobile-shell";
import { TicketDetail } from "@/components/ticket-detail";
import { TicketList } from "@/components/ticket-list";
import { TicketSubmitForm } from "@/components/ticket-submit-form";
import type { Ticket } from "@/lib/domain/types";
import type { AppConfig } from "@/lib/seed";

type Bootstrap = {
  tickets: Ticket[];
  config: AppConfig;
};

export default function HomePage() {
  const [tab, setTab] = useState<MobileTab>("tickets");
  const [data, setData] = useState<Bootstrap | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  async function refresh() {
    const response = await fetch("/api/bootstrap", { cache: "no-store" });
    setData(await response.json());
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selectedTicket = useMemo(() => data?.tickets.find((ticket) => ticket.id === selectedId) ?? data?.tickets[0], [data, selectedId]);

  if (!data) return <main className="app-shell loading">加载中</main>;

  return (
    <MobileShell activeTab={tab} onTabChange={setTab}>
      {tab === "submit" && <TicketSubmitForm config={data.config} onSubmitted={() => { setTab("tickets"); void refresh(); }} />}
      {tab === "tickets" && (
        <>
          <TicketList tickets={data.tickets} selectedId={selectedTicket?.id} onSelect={setSelectedId} />
          <TicketDetail ticket={selectedTicket} onRefresh={refresh} />
        </>
      )}
      {tab === "mine" && <TicketList tickets={data.tickets.filter((ticket) => ticket.submitterId === "mobile-user" || ticket.handlerId === "mobile-user")} selectedId={selectedId} onSelect={setSelectedId} />}
      {tab === "admin" && <AdminPanel config={data.config} onRefresh={refresh} />}
    </MobileShell>
  );
}
```

- [ ] **Step 8: Add mobile UI styling**

Append to `src/styles/globals.css`:

```css
.mobile-shell {
  min-height: 100dvh;
  width: min(100%, 520px);
  margin: 0 auto;
  padding: 18px 14px 86px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 2px 18px;
}

.topbar h1 {
  margin: 0;
  font-size: 24px;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 12px;
}

.live-dot {
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 6px 10px;
  background: #f7fbf6;
  color: var(--green);
  font-size: 12px;
}

.content-pane {
  display: grid;
  gap: 14px;
}

.bottom-nav {
  position: fixed;
  left: 50%;
  bottom: 12px;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  width: min(calc(100% - 24px), 496px);
  transform: translateX(-50%);
  border: 1px solid var(--line);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.bottom-nav button {
  display: grid;
  place-items: center;
  gap: 3px;
  border: 0;
  padding: 9px 4px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}

.bottom-nav button.active {
  color: var(--green);
  background: #edf6ef;
}

.stack-form,
.detail-panel,
.admin-panel,
.issue-group,
.empty-state {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: 0 8px 24px rgba(31, 49, 39, 0.08);
  padding: 14px;
}

.stack-form {
  display: grid;
  gap: 12px;
}

.stack-form label,
.reply-box {
  display: grid;
  gap: 6px;
}

.stack-form span {
  color: var(--muted);
  font-size: 13px;
}

input,
select,
textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 11px 12px;
  background: #fbfcfa;
  color: var(--ink);
}

.primary-button,
.secondary-button,
.reply-box button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  padding: 12px;
}

.primary-button,
.reply-box button {
  background: var(--green);
  color: white;
}

.secondary-button {
  border: 1px dashed var(--line);
  background: #f7faf6;
  color: var(--green);
}

.ticket-groups {
  display: grid;
  gap: 12px;
}

.group-heading,
.detail-head,
.config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.group-heading h2,
.detail-head h2,
.admin-panel h2 {
  margin: 0;
  font-size: 17px;
}

.ticket-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 8px;
  margin-top: 9px;
  padding: 12px;
  background: #fbfcfa;
  text-align: left;
}

.ticket-row.selected {
  border-color: var(--green);
}

.ticket-row strong,
.ticket-row p {
  display: block;
  margin: 0;
}

.ticket-row p,
.detail-head p {
  color: var(--muted);
  font-size: 13px;
}

.row-meta {
  display: grid;
  gap: 6px;
  justify-items: end;
  color: var(--muted);
  font-size: 12px;
}

.status-pill {
  border-radius: 999px;
  padding: 5px 8px;
  white-space: nowrap;
  font-size: 12px;
}

.status-待受理 { background: #fff3d8; color: var(--amber); }
.status-处理中 { background: #e9f3ff; color: var(--blue); }
.status-挂起 { background: #f0edf7; color: #5f4a8a; }
.status-已解决 { background: #eaf7ef; color: var(--green); }
.status-已关闭 { background: #f0f2f0; color: var(--muted); }

.fact-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin: 12px 0;
}

.fact-grid div {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px;
  background: #fbfcfa;
}

.fact-grid dt {
  color: var(--muted);
  font-size: 12px;
}

.fact-grid dd {
  margin: 4px 0 0;
  font-weight: 700;
}

.timeline {
  display: grid;
  gap: 8px;
  margin: 12px 0;
}

.timeline-item {
  border-left: 3px solid var(--green);
  padding-left: 10px;
}

.timeline-item span {
  color: var(--muted);
  font-size: 12px;
}

.timeline-item p {
  margin: 3px 0 0;
}

.reply-box {
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.config-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.file-import {
  display: grid;
  gap: 8px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  padding: 12px;
}
```

- [ ] **Step 9: Build and smoke-test UI**

Run: `npm run build`

Expected: build completes, and the page compiles as a client app.

Run: `npm run dev`

Expected: local server starts and the mobile app loads at `http://localhost:3000`.

- [ ] **Step 10: Commit mobile UI**

Run:

```bash
git add src/app/page.tsx src/components src/styles/globals.css
git commit -m "feat: add mobile collaboration board ui"
```

## Task 9: Integration Verification

**Files:**

- Modify: `src/lib/services/ticket-service.ts`
- Modify: `src/app/page.tsx`
- Modify: `README.md`

- [ ] **Step 1: Add README with runbook**

Create `README.md`:

```md
# 内部协同看板

移动端优先的现场工单协同中心。

## 启动

```bash
npm install
npm run dev
```

访问 `http://localhost:3000`。

## 验证

```bash
npm run test:run
npm run build
```

## 主数据导入列

上传 `.xlsx`、`.xls` 或 `.csv`，第一张表至少包含：

- 展位号
- 公司名称
- 业务员
- 搭建商

可选列：

- 公司简称

## AI接口

管理页展示两个默认接口：

- 快速AI：用于问题类型自动归类。
- 高智商AI：用于语义判重、超时分析和建议。

默认使用本地模拟接口，后续可将 provider 切换为 HTTP 接口。
```

- [ ] **Step 2: Run full test suite**

Run: `npm run test:run`

Expected: all domain and service tests pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: production build completes without TypeScript or route errors.

- [ ] **Step 4: Manual acceptance path**

Run: `npm run dev`

Expected: server starts at `http://localhost:3000`.

In the browser:

1. Open 管理页 and import a sheet with columns `展位号`, `公司名称`, `业务员`, `搭建商`, `公司简称`.
2. Submit a ticket with issue type `自动` and a network-related description.
3. Confirm the created title format is `展位号 公司简称 问题类型`.
4. Submit a similar ticket for the same booth.
5. Confirm it is merged as a催单 or routed to manual review depending on score.
6. Open 工单详情 and add a reply.
7. Confirm the reply appears in the timeline-like thread area.

- [ ] **Step 5: Commit verification docs**

Run:

```bash
git add README.md src/lib/services/ticket-service.ts src/app/page.tsx
git commit -m "docs: add collaboration board runbook"
```

## Self-Review Checklist

Spec coverage:

- 移动端提交、列表、详情、回复、追加反馈: Task 8.
- 状态流 `待受理 -> 处理中 -> 挂起 -> 已解决 -> 已关闭`: Task 2 and Task 7.
- 问题类型默认自动，管理员至少维护一个非自动类型: Task 6 and Task 8.
- 双AI接口（快速AI、高智商AI）: Task 4 and Task 8.
- 同展位号语义判重、催单、人工确认分流: Task 4 and Task 6.
- 展位主数据表格上传: Task 3, Task 7, Task 8.
- 标题自动生成: Task 2 and Task 6.
- 受理后耗时、轻重缓急排序: Task 2 and Task 5.
- 多人反馈、处理完成回执基础结构: Task 6 and Task 8.
- 超时推荐、提醒、优先级升级: Task 5.

Type consistency:

- `TicketStatus`, `Ticket`, `AiDecision`, `BoothRecord`, `IssueType`, `AiModelConfig` are defined once in `src/lib/domain/types.ts`.
- API routes use the same service inputs as `ticket-service.ts`.
- UI components consume `Ticket` and `AppConfig` directly from shared modules.

Verification commands:

- `npm run test:run`
- `npm run build`
- `npm run dev`
