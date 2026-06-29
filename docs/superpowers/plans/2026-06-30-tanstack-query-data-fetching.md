# TanStack Query v5 Data Fetching Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hand-written browser server-state management in the six actual request-owning components with TanStack Query v5 while preserving API contracts and UI behavior.

**Architecture:** Keep the root layout as a Server Component and add a narrow client Query provider. Centralize QueryClient policy, query keys, and typed HTTP errors; migrate reads to cancellable queries and writes to non-retrying mutations with exact invalidation. Local navigation, form drafts, images, dialogs, galleries, and transient success messages stay in React state.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, `@tanstack/react-query@5.101.2`, Vitest 4, Testing Library.

---

## Workflow constraints

- Base commit: merged `main` at `6446ca4` or newer.
- Worktree: `.worktrees/p1-03-tanstack-query` on `codex/p1-03-tanstack-query`.
- The user requires one task = one commit = one PR. Do not commit after individual tasks; create the single specified commit only after every verification gate passes.
- Do not modify `src/components/ticket-list.tsx` or `src/components/exhibitor-dashboard.tsx`; neither owns a server request.
- Preserve every endpoint, HTTP method, request payload, permission check, navigation callback, and user-facing message unless a test proves the existing behavior differs.

## File map

**Create:**

- `src/components/query-provider.tsx`: the only client boundary needed by the root layout.
- `src/lib/client/api-request.ts`: typed HTTP status and shared error-message parsing.
- `src/lib/client/query-client.ts`: production retry/cache/focus policy.
- `src/lib/client/query-keys.ts`: stable shared keys and key prefixes.
- `tests/helpers/query-client.tsx`: isolated no-retry client and render helper.
- `tests/lib/client/api-request.test.ts`: HTTP helper contract.
- `tests/lib/client/query-client.test.ts`: production QueryClient policy.

**Modify:**

- `package.json`, `package-lock.json`
- `src/app/layout.tsx`, `src/app/page.tsx`
- `src/components/admin-shell.tsx`
- `src/components/admin-users-panel.tsx`
- `src/components/admin-panel.tsx`
- `src/components/ticket-detail.tsx`
- `src/components/ticket-submit-form.tsx`
- `tests/components/admin-users-panel.test.tsx`
- `tests/components/admin-user-import.test.tsx`
- `tests/components/admin-panel.test.tsx`
- `tests/app/admin-routes.test.tsx`
- `tests/app/admin-page.test.tsx`
- `tests/app/page-navigation.test.tsx`
- `tests/app/login-auth.test.tsx`
- `tests/components/ticket-detail.test.tsx`
- `tests/components/ticket-submit-form.test.tsx`

## Task 1: Install the exact v5 dependency

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm the registry version and peer compatibility**

Run:

```powershell
npm.cmd view @tanstack/react-query version peerDependencies --json
```

Expected: version `5.101.2` and React 19 accepted by the package peer range.

- [ ] **Step 2: Install the exact version**

Run:

```powershell
npm.cmd install --save-exact @tanstack/react-query@5.101.2
```

Expected: `package.json` contains `"@tanstack/react-query": "5.101.2"` and the lockfile is updated without unrelated dependency upgrades.

- [ ] **Step 3: Verify the resolved version and audit count**

Run:

```powershell
node -e "console.log(require('@tanstack/react-query/package.json').version)"
npm.cmd audit
```

Expected: `5.101.2`; audit remains at or below 3 vulnerabilities.

## Task 2: Build and test the shared Query infrastructure

**Files:**

- Create: `src/lib/client/api-request.ts`
- Create: `src/lib/client/query-client.ts`
- Create: `src/lib/client/query-keys.ts`
- Create: `src/components/query-provider.tsx`
- Create: `tests/helpers/query-client.tsx`
- Create: `tests/lib/client/api-request.test.ts`
- Create: `tests/lib/client/query-client.test.ts`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Write failing API helper tests**

Cover these exact contracts in `tests/lib/client/api-request.test.ts`:

```ts
it("prefers JSON message, then JSON error, then text, then fallback", async () => {
  // Stub one response for each branch and assert ApiRequestError.message.
});

it("preserves status and passes the AbortSignal to fetch", async () => {
  const controller = new AbortController();
  await expect(apiJson("/api/example", { signal: controller.signal }, "失败"))
    .rejects.toMatchObject({ name: "ApiRequestError", status: 503 });
  expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
});
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/lib/client/api-request.test.ts
```

Expected: FAIL because `@/lib/client/api-request` does not exist.

- [ ] **Step 3: Implement the typed API helper**

Create `src/lib/client/api-request.ts` with this public contract:

```ts
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function responseErrorMessage(response: Response, fallback: string) {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof payload.message === "string" && payload.message) return payload.message;
    if (typeof payload.error === "string" && payload.error) return payload.error;
  } catch {
    return text;
  }
  return text || fallback;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string) {
  const response = await fetch(input, init);
  if (!response.ok) throw new ApiRequestError(response.status, await responseErrorMessage(response, fallback));
  return response;
}

export async function apiJson<T>(input: RequestInfo | URL, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await apiFetch(input, init, fallback);
  return await response.json() as T;
}

export function isUnauthorized(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status === 401;
}
```

- [ ] **Step 4: Write failing QueryClient policy tests**

In `tests/lib/client/query-client.test.ts`, assert:

```ts
const client = createQueryClient();
expect(client.getDefaultOptions().queries).toMatchObject({
  staleTime: 0,
  refetchOnWindowFocus: false
});
expect(client.getDefaultOptions().mutations).toMatchObject({ retry: 0 });

const retry = client.getDefaultOptions().queries?.retry as (failureCount: number, error: unknown) => boolean;
expect(retry(0, new TypeError("network"))).toBe(true);
expect(retry(1, new TypeError("network"))).toBe(false);
expect(retry(0, new ApiRequestError(503, "down"))).toBe(true);
expect(retry(0, new ApiRequestError(401, "unauthorized"))).toBe(false);
expect(retry(0, new ApiRequestError(400, "bad request"))).toBe(false);
```

- [ ] **Step 5: Run the policy tests and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/lib/client/query-client.test.ts
```

Expected: FAIL because `createQueryClient` does not exist.

- [ ] **Step 6: Implement QueryClient, keys, provider, and layout wiring**

`src/lib/client/query-client.ts` must use one retry only for network/5xx:

```ts
import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "./api-request";

export function shouldRetryQuery(failureCount: number, error: unknown) {
  if (failureCount >= 1) return false;
  return !(error instanceof ApiRequestError) || error.status >= 500;
}

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 0, retry: shouldRetryQuery, refetchOnWindowFocus: false },
      mutations: { retry: 0 }
    }
  });
}
```

`src/lib/client/query-keys.ts` must expose stable prefixes and parameterized leaves:

```ts
export const queryKeys = {
  admin: {
    all: ["admin"] as const,
    session: ["admin", "session"] as const,
    bootstrap: ["admin", "bootstrap"] as const,
    logs: (limit: number) => ["admin", "wechat-order-logs", { limit }] as const,
    wxauto: ["admin", "wxauto-mcp"] as const,
    users: {
      all: ["admin", "users"] as const,
      list: (filters: Readonly<Record<string, string>>) => ["admin", "users", "list", filters] as const,
      identities: (platform: "wechat" | "wecom") => ["admin", "chat-identities", platform] as const
    }
  },
  mobile: {
    all: ["mobile"] as const,
    session: ["mobile", "session"] as const,
    loginConfig: ["mobile", "login-config"] as const,
    bootstrap: ["mobile", "bootstrap"] as const,
    ticket: (ticketId: string) => ["mobile", "ticket", ticketId] as const
  }
};
```

`src/components/query-provider.tsx` must remain the only new client boundary:

```tsx
"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createQueryClient } from "@/lib/client/query-client";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
```

Wrap `<QueryProvider>{children}</QueryProvider>` inside `src/app/layout.tsx` without adding `"use client"` and without moving/removing `metadata`.

- [ ] **Step 7: Add the test render helper**

Create `tests/helpers/query-client.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false }
    }
  });
}

export function renderWithQueryClient(ui: ReactElement, options?: RenderOptions) {
  const queryClient = createTestQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...render(ui, { wrapper: Wrapper, ...options }) };
}
```

- [ ] **Step 8: Run infrastructure tests and build**

Run:

```powershell
npm.cmd run test:run -- tests/lib/client/api-request.test.ts tests/lib/client/query-client.test.ts
npm.cmd run build
```

Expected: infrastructure tests PASS and layout remains a valid Server Component build.

## Task 3: Migrate `admin-users-panel.tsx`

**Files:**

- Modify: `src/components/admin-users-panel.tsx`
- Modify: `tests/components/admin-users-panel.test.tsx`
- Modify: `tests/components/admin-user-import.test.tsx`

- [ ] **Step 1: Wrap existing tests with isolated QueryClient**

Replace direct component `render(...)` calls in both test files with `renderWithQueryClient(...)`. Keep each test isolated and continue calling Testing Library `cleanup()`.

- [ ] **Step 2: Add RED tests for cancellation, deduplication, and invalidation**

Add tests that assert:

```ts
it("aborts the obsolete user request when applied filters change", async () => {
  const signals: AbortSignal[] = [];
  // Capture init.signal for each users request, apply two filters quickly,
  // then assert signals[0].aborted is true and only the newest payload is rendered.
});

it("deduplicates identical user list requests", async () => {
  // Trigger a rerender with the same applied filters and assert one in-flight users fetch.
});

it("invalidates users and the affected identity after a successful bind", async () => {
  // Complete PUT and assert users plus only that platform identity are fetched again.
});
```

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-users-panel.test.tsx tests/components/admin-user-import.test.tsx
```

Expected: new cancellation/invalidation assertions FAIL against request-ID/manual refresh behavior.

- [ ] **Step 3: Replace list and identity reads with queries**

Use `useQuery` with these mappings:

| Resource | Query key | Enabled | Query function |
|---|---|---|---|
| Users | `queryKeys.admin.users.list(appliedFilters)` | always | `apiJson<UserPayload>(usersUrl(appliedFilters), { cache: "no-store", signal }, "用户列表加载失败")` |
| WeChat identities | `queryKeys.admin.users.identities("wechat")` | editing an existing user | GET current endpoint with `signal` |
| WeCom identities | `queryKeys.admin.users.identities("wecom")` | editing an existing user | GET current endpoint with `signal` |

Delete `latestListRequestId`, list `loading/error/users/total` state, `loadUsers`, identity-loading state, and `loadChatIdentities`. Derive list values from query results; use `isPending` for initial empty loading and `isFetching` for “正在更新”.

- [ ] **Step 4: Replace writes with mutations**

Use mutations for save, enable/disable/delete, password, bind/unbind, and import completion. On success:

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: queryKeys.admin.users.all }),
  queryClient.invalidateQueries({ queryKey: queryKeys.admin.bootstrap })
]);
```

Identity mutations must additionally invalidate only `queryKeys.admin.users.identities(platform)`. Preserve editor updates, confirmation prompts, close/reset timing, and all current messages. Derive button pending state from mutation variables rather than a second network-loading state.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-users-panel.test.tsx tests/components/admin-user-import.test.tsx
```

Expected: all existing and new admin-user tests PASS.

## Task 4: Migrate administrator shell queries and authentication mutations

**Files:**

- Modify: `src/components/admin-shell.tsx`
- Modify: `tests/app/admin-routes.test.tsx`
- Modify: `tests/app/admin-page.test.tsx`

- [ ] **Step 1: Wrap admin page tests and add RED lifecycle tests**

Use `renderWithQueryClient` for renders that include `AdminBackendShell`. Add assertions that authenticated bootstrap and logs requests both start before either resolves, that duplicate subscribers do not duplicate a request, and that logout removes `queryKeys.admin.all` data even when the logout fetch rejects.

Run:

```powershell
npm.cmd run test:run -- tests/app/admin-routes.test.tsx tests/app/admin-page.test.tsx
```

Expected: parallel/cache lifecycle tests FAIL before migration.

- [ ] **Step 2: Implement session, bootstrap, and log queries**

Replace `authReady`, `authenticated`, `bootstrapRequired`, `currentAdmin`, `data`, `logs`, `error`, and the `refresh` effect chain with:

- admin session query, always enabled and `retry: false` for deterministic authentication resolution;
- admin bootstrap query enabled only when session payload is authenticated;
- log query enabled only when authenticated;
- independent query declarations so bootstrap and log fetch in parallel.

Preserve the current special case: a failed log request is fatal only on the logs view; other views receive an empty log list.

- [ ] **Step 3: Implement login/bootstrap/logout mutations**

Login and first-admin bootstrap must set `queryKeys.admin.session` to `{ authenticated: true, user }`, clear form errors, and let enabled queries load data. Logout must attempt POST, then in `onSettled` cancel and remove all `queryKeys.admin.all` cache and restore the unauthenticated screen. Remove the silent wxauto warm-up request.

- [ ] **Step 4: Run focused admin shell tests**

Run:

```powershell
npm.cmd run test:run -- tests/app/admin-routes.test.tsx tests/app/admin-page.test.tsx
```

Expected: all admin route/page tests PASS.

## Task 5: Migrate `admin-panel.tsx` reads and writes

**Files:**

- Modify: `src/components/admin-panel.tsx`
- Modify: `tests/components/admin-panel.test.tsx`

- [ ] **Step 1: Wrap tests and add RED query/mutation tests**

Use `renderWithQueryClient`. Add tests for: wxauto GET enabled only for `view="system"`; config mutation disables only the relevant submit action; failed mutation preserves draft state and reports the existing message; successful mutation invalidates admin bootstrap; model-list POST remains user-triggered and does not run on mount.

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-panel.test.tsx
```

Expected: new invalidation and condition assertions FAIL.

- [ ] **Step 2: Convert the wxauto read to a conditional query**

Use key `queryKeys.admin.wxauto`, `enabled: view === "system"`, and the existing GET endpoint with `cache: "no-store"` plus `signal`. Synchronize returned server data into the editable wxauto draft only when a payload arrives; do not overwrite active user edits during unrelated rerenders.

- [ ] **Step 3: Convert every network write in this component**

Use mutations for these exact operations:

| Operation | Endpoint/method | Successful invalidation |
|---|---|---|
| Save config | `/api/admin/config`, PUT | admin bootstrap |
| Import master data | `/api/admin/master-data`, POST | admin bootstrap |
| Save wxauto | `/api/admin/wxauto-mcp`, PUT | admin bootstrap + wxauto |
| Rotate wxauto token | `/api/admin/wxauto-mcp`, POST | admin bootstrap + wxauto |
| Save keywords | `/api/admin/keywords`, PUT | admin bootstrap |
| Fetch model list | `/api/admin/ai-models`, POST | none; retain result in per-model local draft state |

Keep `statusQueue`, import preview, displayed booth reconciliation, form drafts, and success messages local. Replace network-specific `isImporting`/`savingConfigId` transitions with mutation `isPending` and mutation variables while preserving existing props sent to child components.

- [ ] **Step 4: Run focused admin panel tests**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-panel.test.tsx
```

Expected: all tests PASS.

## Task 6: Migrate mobile session, bootstrap, and ticket detail reads

**Files:**

- Modify: `src/app/page.tsx`
- Modify: `tests/app/page-navigation.test.tsx`
- Modify: `tests/app/login-auth.test.tsx`
- Modify: `tests/components/ticket-detail.test.tsx` where it renders `HomePage`

- [ ] **Step 1: Wrap all HomePage tests and add RED query-state tests**

Use `renderWithQueryClient` for every direct `<HomePage />` render. Add tests that verify: login config runs only without a user; mobile bootstrap runs only after session resolution; selecting a summary starts one detail query; deselecting aborts an in-flight detail fetch; 401 clears all mobile cache; a refetch keeps current tickets visible while the request is pending.

Run:

```powershell
npm.cmd run test:run -- tests/app/page-navigation.test.tsx tests/app/login-auth.test.tsx tests/components/ticket-detail.test.tsx
```

Expected: the new cancellation/cache tests FAIL.

- [ ] **Step 2: Replace mobile reads with dependent queries**

Use these mappings:

| Resource | Query key | Enabled |
|---|---|---|
| Session | `queryKeys.mobile.session` | always |
| Login config | `queryKeys.mobile.loginConfig` | session resolved with no user |
| Mobile bootstrap | `queryKeys.mobile.bootstrap` | authenticated user exists |
| Ticket detail | `queryKeys.mobile.ticket(selectedId)` | selected ID exists and detail route is active |

The session query calls `resolveMobileSession`; successful mobile bootstrap also seeds login-config cache with its config. The detail query may use the selected full ticket as `initialData`, but a summary without `timeline` must fetch. Pass every query `signal` to its fetch.

- [ ] **Step 3: Preserve navigation and handle unauthorized errors**

Keep `tab` and `selectedId` state. Replace `clearSessionState` with one function that removes legacy storage, cancels/removes `queryKeys.mobile.all`, writes a resolved unauthenticated session value, and returns to the tickets tab. Detect `ApiRequestError(401)` without retrying it. Keep URL ticket ID/code selection unchanged.

- [ ] **Step 4: Convert logout to a mutation**

POST the existing endpoint with no retry. In `onSettled`, run the same cache/session cleanup even if the network request fails. Preserve current visible login behavior.

- [ ] **Step 5: Run focused mobile tests**

Run:

```powershell
npm.cmd run test:run -- tests/app/page-navigation.test.tsx tests/app/login-auth.test.tsx tests/components/ticket-detail.test.tsx
```

Expected: all mobile navigation/auth/detail-read tests PASS.

## Task 7: Migrate ticket mutations

**Files:**

- Modify: `src/components/ticket-detail.tsx`
- Modify: `src/components/ticket-submit-form.tsx`
- Modify: `tests/components/ticket-detail.test.tsx`
- Modify: `tests/components/ticket-submit-form.test.tsx`

- [ ] **Step 1: Wrap direct component renders and add RED mutation tests**

Use `renderWithQueryClient` for direct `TicketDetail` and `TicketSubmitForm` renders. Add assertions that successful ticket PATCH/reply/create invalidates `queryKeys.mobile.bootstrap` and the affected detail key; failed submit/reply does not invalidate, reset the form, or remove selected images; 401 invokes `onUnauthorized`; double-click while pending sends one mutation.

Run:

```powershell
npm.cmd run test:run -- tests/components/ticket-detail.test.tsx tests/components/ticket-submit-form.test.tsx
```

Expected: invalidation and pending dedup assertions FAIL before migration.

- [ ] **Step 2: Convert ticket PATCH and reply POST**

Create separate `useMutation` instances. Use `isPending` for action/reply controls. On success, await:

```ts
await Promise.all([
  queryClient.invalidateQueries({ queryKey: queryKeys.mobile.bootstrap }),
  queryClient.invalidateQueries({ queryKey: queryKeys.mobile.ticket(currentTicket.id) })
]);
```

Then reset only the successful form/images and preserve the existing success message. Remove network-only `isActing` and `isReplying` state. Remove the `onRefresh` prop once every internal caller and test is migrated; retain `onUnauthorized`.

- [ ] **Step 3: Convert ticket creation**

Use one mutation with the current POST payload. On success, invalidate mobile bootstrap, reset form/images, set `工单已提交`, then invoke `onSubmitted`. On error preserve the exact current failure message and inputs. Use mutation `isPending` for the submit button; retain `onUnauthorized`.

- [ ] **Step 4: Run focused ticket tests**

Run:

```powershell
npm.cmd run test:run -- tests/components/ticket-detail.test.tsx tests/components/ticket-submit-form.test.tsx
```

Expected: all ticket mutation tests PASS.

## Task 8: Cross-feature verification, review, and the single commit

**Files:**

- Modify: `docs/superpowers/specs/2026-06-30-tanstack-query-data-fetching-design.md` only if implementation discoveries require a factual correction.
- Modify: this plan only to check completed boxes or correct factual drift.

- [ ] **Step 1: Confirm scope and remove obsolete hand-written state**

Run:

```powershell
rg -n "latestListRequestId|async function loadUsers|async function refreshLoginConfig|async function refreshTicketDetail|setIsSubmitting|setIsReplying|setIsActing" src/components/admin-users-panel.tsx src/components/admin-shell.tsx src/app/page.tsx src/components/ticket-detail.tsx src/components/ticket-submit-form.tsx
git diff --name-only main...HEAD
```

Expected: no obsolete request-state matches; `ticket-list.tsx` and `exhibitor-dashboard.tsx` are absent from the diff.

- [ ] **Step 2: Run all focused tests together**

Run:

```powershell
npm.cmd run test:run -- tests/lib/client/api-request.test.ts tests/lib/client/query-client.test.ts tests/components/admin-users-panel.test.tsx tests/components/admin-user-import.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-routes.test.tsx tests/app/admin-page.test.tsx tests/app/page-navigation.test.tsx tests/app/login-auth.test.tsx tests/components/ticket-detail.test.tsx tests/components/ticket-submit-form.test.tsx
```

Expected: all focused files PASS.

- [ ] **Step 3: Run fresh release gates**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit
git diff --check
```

Expected: at least 92 files / 757 tests pass, build succeeds, audit is no higher than 3 vulnerabilities, and diff check is clean.

- [ ] **Step 4: Perform scope and quality review**

Review every diff for: accidental API changes, missing query signal forwarding, broad invalidation where an exact key exists, 4xx retries, mutation auto-retries, stale cache surviving logout, lost accessibility attributes, and changed Chinese messages. Correct findings and repeat Steps 2–3.

- [ ] **Step 5: Create the one required commit**

Stage only P1-03 files and commit using the task-provided message exactly:

```text
refactor(frontend): 用 TanStack Query v5 替换手写数据获取

8+ 组件重复维护 loading/error/data 三态 + 手写竞态防护（递增
request ID）+ 手动刷新。替换为 TanStack Query。

- 安装 @tanstack/react-query
- 添加 QueryClientProvider 到 layout.tsx
- 重构 admin-users-panel（消除递增 request ID）
- 重构 admin-panel / exhibitor-dashboard / ticket-list / ticket-detail
  / ticket-submit-form / page.tsx / admin-shell
- TanStack Query 提供：缓存、竞态消除、请求去重、mutation 失效刷新

保持现有 API 调用不变，仅替换状态管理层。
```

The exact user-provided message names the two audited presentational components even though the approved implementation intentionally leaves them unchanged. Explain that scope correction in the PR body; do not alter the requested commit message.

- [ ] **Step 6: Push and create one ready PR**

Create a ready PR from `codex/p1-03-tanstack-query` to `main`. The PR body must include the approved six-component scope correction, exact dependency version, cancellation via consumed AbortSignal, cache clearing on logout, focused/full test counts, build result, audit count, and the explicit non-goals.
