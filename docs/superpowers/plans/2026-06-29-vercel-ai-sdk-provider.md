# Vercel AI SDK HTTP Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-written OpenAI-compatible HTTP/JSON adapter with the current Vercel AI SDK and schema-validated outputs without changing application routing or fallback contracts.

**Architecture:** `http-provider.ts` remains the application adapter. It validates and normalizes configured endpoints, creates an OpenAI-compatible SDK model, calls `generateText` with `Output.json`, validates the parsed JSON with the scenario's Zod schema, and maps it into the existing five decision shapes. The router continues to select models and prompts, while `provider.ts` remains the only request-level mock fallback boundary.

**Tech Stack:** TypeScript, Vercel AI SDK 7, `@ai-sdk/openai-compatible` 3, Zod 4, Vitest.

---

## File structure

- Modify `package.json` and `package-lock.json` to pin the two SDK packages.
- Modify `README.md`, `start-external.ps1`, and the Windows deployment documentation/script to state the SDK-required Node.js 22 minimum.
- Rewrite `src/lib/ai/http-provider.ts`; keep endpoint/client construction, schemas, SDK invocation, and decision mapping together because they form one adapter and have no independent consumers.
- Rewrite `tests/domain/http-ai-provider.test.ts` to mock the SDK boundary and verify all application-visible behavior.
- Update `tests/api/master-data-ai-import-route.test.ts` so its fake OpenAI responses include the completion marker required by the SDK protocol.
- Keep `src/lib/ai/router.ts`, `provider.ts`, `mock-provider.ts`, `endpoint-validation.ts`, `types.ts`, and `domain/ai-config.ts` unchanged.
- Include the approved design and this plan in the task's single final commit.

The repository workflow requires one task, one commit, and one PR, so the steps below deliberately make no intermediate commits.

### Task 1: Install the current SDK versions

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install exact versions**

Run:

```bash
npm install --save-exact ai@7.0.4 @ai-sdk/openai-compatible@3.0.1
```

Expected: both packages appear under `dependencies`; npm completes without adding more audit vulnerabilities than the baseline of three.

- [ ] **Step 2: Align the project runtime requirement**

Add `"engines": { "node": ">=22" }` to `package.json`, regenerate the root lockfile metadata, and replace every existing Node 20 installation/deployment instruction with Node 22. This matches the `engines.node` requirement of both pinned AI SDK packages.

- [ ] **Step 3: Verify the resolved versions**

Run:

```bash
node -e "const p=require('./package-lock.json').packages; console.log(p['node_modules/ai'].version, p['node_modules/@ai-sdk/openai-compatible'].version)"
```

Expected:

```text
7.0.4 3.0.1
```

### Task 2: Drive endpoint/client and classification behavior test-first

**Files:**
- Modify: `tests/domain/http-ai-provider.test.ts`
- Modify: `src/lib/ai/http-provider.ts`

- [ ] **Step 1: Replace fetch setup with hoisted SDK mocks**

Define stable mocks before importing the providers:

```ts
const sdkMocks = vi.hoisted(() => {
  const languageModel = { modelId: "sdk-model" };
  const modelFactory = vi.fn(() => languageModel);
  return {
    languageModel,
    modelFactory,
    createOpenAICompatible: vi.fn(() => modelFactory),
    generateText: vi.fn(),
    outputJson: vi.fn(() => ({ type: "json" }))
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: sdkMocks.createOpenAICompatible
}));

vi.mock("ai", () => ({
  generateText: sdkMocks.generateText,
  Output: { json: sdkMocks.outputJson }
}));
```

Reset every mock and `OPENAI_API_KEY` after each test. Import both `httpAiProvider` and `createConfiguredAiProvider` after the mock declarations.

- [ ] **Step 2: Write the endpoint and classification test**

Use a model endpoint containing the stored full path and a query parameter:

```ts
const model = {
  ...httpFastModel,
  endpoint: "https://ai.example/v1/chat/completions?api-version=2026-06-01"
};
process.env.OPENAI_API_KEY = "test-key";
sdkMocks.generateText.mockResolvedValue({
  output: { issueType: "网络", confidence: 0.93 }
});

const decision = await httpAiProvider.classify(
  model,
  "A01",
  "网络断开，扫码失败",
  "只返回分类 JSON"
);

expect(sdkMocks.createOpenAICompatible).toHaveBeenCalledWith({
  name: "configured-ai",
  baseURL: "https://ai.example/v1",
  queryParams: { "api-version": "2026-06-01" },
  apiKey: "test-key",
  supportsStructuredOutputs: false
});
expect(sdkMocks.modelFactory).toHaveBeenCalledWith("gpt-fast");
expect(sdkMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
  model: sdkMocks.languageModel,
  system: "只返回分类 JSON",
  prompt: JSON.stringify({ boothNumber: "A01", description: "网络断开，扫码失败" }),
  temperature: 0,
  maxRetries: 2,
  timeout: 1000
}));
expect(decision).toMatchObject({
  modelId: "fast",
  provider: "http",
  scenario: "classify",
  action: "classify",
  issueType: "网络",
  confidence: 0.93
});
```

- [ ] **Step 3: Run the test and verify RED**

Run:

```bash
npm run test:run -- tests/domain/http-ai-provider.test.ts
```

Expected: FAIL because the current provider calls `fetch` and never calls `createOpenAICompatible` or `generateText`.

- [ ] **Step 4: Implement the SDK adapter foundation and classify schema**

Replace the hand-written response types, parser, `fetch`, and abort controller with:

```ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";
import { z } from "zod";

const classifySchema = z.object({
  issueType: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

function normalizeEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "").replace(/\/$/, "");
  const queryParams = Object.fromEntries(url.searchParams.entries());
  url.search = "";
  return {
    baseURL: url.toString().replace(/\/$/, ""),
    queryParams
  };
}

async function generateStructured<OUTPUT>(
  model: AiModelConfig,
  schema: z.ZodType<OUTPUT>,
  system: string,
  payload: Record<string, unknown>
) {
  if (!model.endpoint) throw new Error("智能接口地址未配置");
  const validation = validateAiEndpoint(model.endpoint);
  if (!validation.ok) throw new Error(`AI endpoint invalid: ${validation.reason}`);
  const endpoint = normalizeEndpoint(model.endpoint);
  const apiKey = readApiKey(model);
  const provider = createOpenAICompatible({
    name: "configured-ai",
    ...endpoint,
    apiKey,
    supportsStructuredOutputs: false
  });
  const startedAt = Date.now();
  const result = await generateText({
    model: provider(model.modelName),
    output: Output.json(),
    system,
    prompt: JSON.stringify(payload),
    temperature: 0,
    maxRetries: 2,
    timeout: model.timeoutMs
  });
  return { output: schema.parse(result.output), latencyMs: Date.now() - startedAt };
}
```

Implement `classify` by passing `classifySchema`, retaining the existing payload, default prompt, decision fields, and measured latency. Use the schema output directly; do not clamp or invent fallback values.

- [ ] **Step 5: Run the provider test and verify GREEN**

Run the same focused command. Expected: the endpoint/classification test passes.

### Task 3: Drive the remaining four structured scenarios test-first

**Files:**
- Modify: `tests/domain/http-ai-provider.test.ts`
- Modify: `src/lib/ai/http-provider.ts`

- [ ] **Step 1: Add failing success-path tests**

Add one test per scenario with these SDK outputs and expected application mappings:

```ts
// dedupe
{ confidence: 0.92, matchedTicketId: "ticket-1" }
// expected action: "urge" from decideDeduplication

// escalation
{ confidence: 0.81, suggestion: "优先核查责任组", matchedTicketId: null }
// expected matchedTicketId: first similar ticket id

// customer service
{
  confidence: 0.9,
  pressureLevel: 4,
  action: "expedite",
  matchedTicketId: "ticket-1",
  replyText: "已为您加急跟进。",
  reason: "客户持续催办"
}

// exhibitor import
{
  mappings: [{
    field: "boothNumber",
    columnIndex: 0,
    confidence: 0.96,
    reason: "表头为展位号"
  }]
}
```

Also assert the existing reduced payloads: dedupe/escalation tickets expose only their current selected fields, customer-service history is limited to the last eight messages, and exhibitor context is passed unchanged.

- [ ] **Step 2: Run and verify RED**

Run the provider test. Expected: FAIL because the remaining methods still use the removed hand-written helper or do not consume SDK `output`.

- [ ] **Step 3: Add schemas and minimal mappings**

Add these schemas:

```ts
const matchedTicketIdSchema = z.string().min(1).nullable().default(null);

const dedupeSchema = z.object({
  confidence: z.number().min(0).max(1),
  matchedTicketId: matchedTicketIdSchema
});

const escalationSchema = z.object({
  confidence: z.number().min(0).max(1),
  suggestion: z.string().min(1),
  matchedTicketId: matchedTicketIdSchema
});

const customerServiceSchema = z.object({
  confidence: z.number().min(0).max(1),
  pressureLevel: z.number().int().min(1).max(5),
  action: z.enum([
    "reply", "ask-follow-up", "urge-existing",
    "expedite", "manual-review", "ignore"
  ]),
  matchedTicketId: matchedTicketIdSchema,
  replyText: z.string().min(1),
  reason: z.string().min(1)
});

const exhibitorFieldSchema = z.enum([
  "boothNumber", "companyName", "floor", "hall", "area",
  "areaSpecification", "exhibitorType", "salesOwner", "builder"
]);

const exhibitorMappingSchema = z.object({
  mappings: z.array(z.object({
    field: exhibitorFieldSchema,
    columnIndex: z.number().int().min(0),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1)
  }))
});
```

Call `generateStructured` from each method. Convert nullable IDs with `output.matchedTicketId ?? undefined`, keep `decideDeduplication(output.confidence)`, keep escalation's first-ticket fallback, and return the validated customer/import fields without clamping or filtering.

- [ ] **Step 4: Run and verify GREEN**

Run the provider test. Expected: all five scenario success tests pass.

### Task 4: Drive credential, timeout, prompt, and error behavior test-first

**Files:**
- Modify: `tests/domain/http-ai-provider.test.ts`
- Modify: `src/lib/ai/http-provider.ts`

- [ ] **Step 1: Add failing boundary tests**

Add tests that assert:

1. `model.apiKey` is passed instead of the environment value when both exist.
2. A model with `timeoutMs: 0` calls `generateText` with `timeout: 8000`.
3. Missing direct and environment keys makes `httpAiProvider.classify` reject with `AI 模型 fast 未配置密钥`, before calling the SDK.
4. An `http://` or private endpoint makes `httpAiProvider.classify` reject with the existing validation reason, before calling the SDK.
5. Omitting the customer-service `systemPrompt` uses `selectedAiPromptTemplate({}, "customer-service").systemPrompt`, proving the longer centralized prompt is used instead of the provider's old duplicate.
6. When `generateText` rejects with `new Error("AI_APICallError: 503 response body")`, `createConfiguredAiProvider().classify` returns the mock decision and logs the unchanged warning object containing that message.
7. When `generateText` rejects with `new Error("AI_NoObjectGeneratedError: invalid schema output")`, the same fallback path is used rather than returning an empty or default HTTP decision.

- [ ] **Step 2: Run and verify RED**

Run the provider test. Expected: at least the missing-key and centralized default-prompt assertions fail.

- [ ] **Step 3: Complete credential and default-prompt behavior**

Require the resolved key before provider creation:

```ts
const apiKey = readApiKey(model);
if (!apiKey) throw new Error(`AI 模型 ${model.id} 未配置密钥`);
```

Add the timeout default only after the zero-timeout test has failed:

```ts
const DEFAULT_TIMEOUT_MS = 8000;

function timeoutFor(model: AiModelConfig) {
  return Number.isFinite(model.timeoutMs) && model.timeoutMs > 0
    ? model.timeoutMs
    : DEFAULT_TIMEOUT_MS;
}
```

Change the SDK call from `timeout: model.timeoutMs` to `timeout: timeoutFor(model)`.

Import `selectedAiPromptTemplate` and add:

```ts
function systemPromptFor(
  scenario: AiPromptScenario,
  configured?: string
) {
  return configured ?? selectedAiPromptTemplate({}, scenario).systemPrompt;
}
```

Use this helper for every scenario. Do not catch SDK errors in `http-provider.ts`; the unchanged `provider.ts` remains responsible for logging and mock fallback.

- [ ] **Step 4: Run and verify GREEN**

Run the provider test. Expected: all provider boundary and fallback tests pass.

### Task 5: Verify unchanged routers and services

**Files:**
- Test only: `tests/domain/ai-router.test.ts`
- Test only: `tests/services/ticket-service.test.ts`
- Test only: `tests/services/ticket-service-ai-fallback.test.ts`
- Modify: `tests/api/master-data-ai-import-route.test.ts`

- [ ] **Step 1: Complete existing OpenAI-compatible response fixtures**

Every fake chat-completion choice used by the master-data route must include the SDK-required completion marker:

```ts
choices: [{
  message: { content: JSON.stringify({ mappings }) },
  finish_reason: "stop"
}]
```

The previous hand-written adapter ignored this protocol field; the SDK uses it to decide that a generation step produced final output.

- [ ] **Step 2: Run focused AI and service tests**

Run:

```bash
npm run test:run -- tests/domain/http-ai-provider.test.ts tests/domain/ai-router.test.ts tests/services/ticket-service.test.ts tests/services/ticket-service-ai-fallback.test.ts tests/api/master-data-ai-import-route.test.ts
```

Expected: all selected files pass with no router, service, mock-provider, or public type changes.

- [ ] **Step 3: Inspect the scoped diff**

Run:

```bash
git diff -- src/lib/ai package.json package-lock.json tests/domain/http-ai-provider.test.ts
git diff --check
```

Expected: only `http-provider.ts` changes under `src/lib/ai`; there are no whitespace errors.

### Task 6: Complete full verification and create the single commit

**Files:**
- All task files

- [ ] **Step 1: Verify installed versions and TypeScript syntax through the build**

Run:

```bash
node -e "const p=require('./package-lock.json').packages; console.log({ai:p['node_modules/ai'].version,compatible:p['node_modules/@ai-sdk/openai-compatible'].version})"
npm run build
```

Expected: versions are `7.0.4` and `3.0.1`; the Next.js production build succeeds.

- [ ] **Step 2: Run the full suite**

Run:

```bash
npm run test:run
```

Expected: at least the 748-test baseline plus the new provider cases, with zero failures.

- [ ] **Step 3: Check dependency security**

Run:

```bash
npm audit
```

Expected: no more than the merged baseline of three vulnerabilities (`2 moderate`, `1 high`).

- [ ] **Step 4: Review requirements and worktree state**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Before committing, confirm the diff implements all five schemas, endpoint normalization, key validation, timeout fallback, two retries, SDK error propagation, and no circuit breaker/router/fallback/mock changes.

- [ ] **Step 5: Create the only task commit**

Stage the dependency files, provider, provider tests, design, and plan. Commit using exactly:

```text
refactor(ai): 用 Vercel AI SDK 替换手写 HTTP provider

http-provider.ts 手写代码围栏剥离、JSON 截取、超时，无重试无熔断。
替换为 Vercel AI SDK 的 generateObject + Zod schema。

- 安装 ai + @ai-sdk/openai-compatible
- http-provider 用 generateObject 替代手写 fetch + JSON 解析
- 保留 router/fallback/mock/SSRF 校验（业务逻辑不变）
- AI SDK 提供：内置重试退避、typed errors、structured output
- mock-provider 保留用于单元测试

消除 bug：无重试、JSON 解析吞错、错误信息无响应体、response_format 硬编码

参考: https://sdk.vercel.ai/docs/guides/structured-output
```

The message is retained exactly as requested even though the pinned current SDK implements broad-compatibility structured output through `generateText + Output.json + Zod` rather than the legacy `generateObject` symbol.

- [ ] **Step 6: Push and open the PR**

Push `codex/p1-02-vercel-ai-sdk` and open a ready PR against the latest `main`. The PR body must record the current SDK API deviation, test/build counts, audit count, and that circuit breaking is explicitly out of scope.
