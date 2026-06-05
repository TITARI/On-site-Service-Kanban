# PC 后台配置中心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the mobile-admin path and build a separate login-protected PC `/admin` configuration center.

**Architecture:** Mobile auth remains member-only and the mobile shell no longer knows about an admin tab. The PC admin route owns its own local browser session state, fetches existing bootstrap/config data, and renders a config-only center using the existing save/import APIs. Record-management sections are not rendered in the new admin UI.

**Tech Stack:** Next.js App Router, React client components, TypeScript, Vitest, Testing Library, existing file-backed `/api/bootstrap`, `/api/admin/config`, and `/api/admin/master-data`.

---

### Task 1: Remove Mobile Admin Entry

**Files:**
- Modify: `tests/app/login-auth.test.tsx`
- Modify: `tests/app/page-navigation.test.tsx`
- Modify: `src/components/login-panel.tsx`
- Modify: `src/components/mobile-shell.tsx`
- Modify: `src/lib/client/auth.ts`
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Write failing tests for mobile admin removal**

Update `tests/app/login-auth.test.tsx` so the mobile login test asserts there is no `管理员登录` button and remove the old admin-login success test:

```tsx
expect(screen.queryByRole("button", { name: "管理员登录" })).toBeNull();
expect(screen.queryByLabelText("管理口令")).toBeNull();
```

Update `tests/app/page-navigation.test.tsx` so an old stored admin user no longer enters management and instead shows the member login screen:

```tsx
it("ignores old mobile admin sessions", async () => {
  loginAs({ id: "admin", name: "管理员", phone: "", role: "admin" } as CurrentUser);
  vi.stubGlobal("fetch", vi.fn());

  render(<HomePage />);

  expect(await screen.findByText("登录后使用工单中心")).not.toBeNull();
  expect(screen.queryByText("管理配置")).toBeNull();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm run test:run -- tests/app/login-auth.test.tsx tests/app/page-navigation.test.tsx`

Expected: FAIL because the current mobile login still exposes `管理员登录` and stored admin sessions still open the old management page.

- [ ] **Step 3: Implement member-only mobile auth**

Change `src/components/login-panel.tsx` to render only the member form and remove the admin mode switch/form. Keep `createMemberUser`, `storeUser`, and `userGroupsOf`.

Change `src/lib/client/auth.ts` so `CurrentUser.role` is member-only and `readStoredUser()` rejects anything except `role === "member"`. Keep `DEFAULT_ADMIN_PASSWORD` and `isAdminPassword()` for the new PC admin login.

Change `src/components/mobile-shell.tsx` so `MobileTab` is `"submit" | "tickets" | "mine"`, remove the `SlidersHorizontal` import, remove the admin tab, and remove the admin group-label branch.

Change `src/app/page.tsx` to remove `AdminPanel` import, admin bootstrap-only props, admin tab guards, admin role filtering, and admin rendering. Member login should always enter `"tickets"`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm run test:run -- tests/app/login-auth.test.tsx tests/app/page-navigation.test.tsx`

Expected: PASS.

### Task 2: Convert AdminPanel Into Config-Only Center

**Files:**
- Modify: `tests/components/admin-panel.test.tsx`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/styles/globals.css`

- [ ] **Step 1: Write failing tests for config-only PC center**

Update `tests/components/admin-panel.test.tsx` to import `AdminConfigCenter` from `src/components/admin-panel.tsx`.

Add a test that confirms record modules are absent:

```tsx
render(<AdminConfigCenter config={config} onRefresh={vi.fn()} />);

expect(screen.queryByText("微信/企微消息")).toBeNull();
expect(screen.queryByText("微信身份绑定")).toBeNull();
expect(screen.queryByText("追问会话")).toBeNull();
expect(screen.queryByText("出站通知")).toBeNull();
```

Update existing save tests to open the needed PC section first, for example:

```tsx
await user.click(screen.getByRole("button", { name: "用户分组" }));
await user.click(screen.getByRole("button", { name: "问题类型" }));
await user.click(screen.getByRole("button", { name: "AI 接口" }));
await user.click(screen.getByRole("button", { name: "微信/企微 MCP" }));
```

- [ ] **Step 2: Run component tests and verify they fail**

Run: `npm run test:run -- tests/components/admin-panel.test.tsx`

Expected: FAIL because the current component still exports `AdminPanel`, renders all sections in one mobile-oriented flow, and still displays record-management sections.

- [ ] **Step 3: Implement `AdminConfigCenter`**

In `src/components/admin-panel.tsx`, rename the exported component to `AdminConfigCenter`, keep the existing config-edit handlers, remove record-management props from the public API, and render these sections behind PC sidebar buttons:

```ts
type AdminSection = "overview" | "groups" | "issues" | "ai" | "messages" | "masterData";
```

Add an overview section that derives counts from `config` and the optional `tickets` prop:

```tsx
const enabledGroups = groups.filter((group) => group.enabled).length;
const enabledIssues = activeIssueTypes.filter((item) => item.enabled).length;
const enabledAiModels = config.aiModels.filter((model) => model.enabled).length;
const enabledMessageIntegrations = messageIntegrations.filter((item) => item.enabled).length;
```

Do not render `微信/企微消息`, `微信身份绑定`, `追问会话`, or `出站通知`.

Add PC layout styles to `src/styles/globals.css` using classes such as `.admin-config-center`, `.admin-config-layout`, `.admin-config-sidebar`, `.admin-config-content`, and `.admin-overview-grid`.

- [ ] **Step 4: Run component tests and verify they pass**

Run: `npm run test:run -- tests/components/admin-panel.test.tsx`

Expected: PASS.

### Task 3: Add Login-Protected `/admin` Route

**Files:**
- Create: `src/lib/client/admin-auth.ts`
- Create: `src/app/admin/page.tsx`
- Create: `tests/app/admin-page.test.tsx`

- [ ] **Step 1: Write failing route tests**

Create `tests/app/admin-page.test.tsx` with tests for these behaviors:

```tsx
it("requires backend login before showing the config center", async () => {
  vi.stubGlobal("fetch", vi.fn());
  render(<AdminPage />);
  expect(await screen.findByText("后台配置登录")).not.toBeNull();
  expect(screen.queryByText("配置总览")).toBeNull();
});

it("opens the config center after the admin password is accepted", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tickets: [], config }), { status: 200 })));
  const user = userEvent.setup();
  render(<AdminPage />);
  await user.type(await screen.findByLabelText("后台口令"), "admin123");
  await user.click(screen.getByRole("button", { name: "进入后台" }));
  expect(await screen.findByText("配置总览")).not.toBeNull();
});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run: `npm run test:run -- tests/app/admin-page.test.tsx`

Expected: FAIL because `/admin` does not exist.

- [ ] **Step 3: Implement admin auth helpers and route**

Create `src/lib/client/admin-auth.ts`:

```ts
export const ADMIN_AUTH_STORAGE_KEY = "internal-board-admin-session";

export function readAdminSession() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(ADMIN_AUTH_STORAGE_KEY) === "active";
}

export function storeAdminSession() {
  window.localStorage.setItem(ADMIN_AUTH_STORAGE_KEY, "active");
}

export function clearAdminSession() {
  window.localStorage.removeItem(ADMIN_AUTH_STORAGE_KEY);
}
```

Create `src/app/admin/page.tsx` as a client component. It reads the admin session on mount, renders a `后台配置登录` form when unauthenticated, validates the password with `isAdminPassword`, stores the admin session on success, fetches `/api/bootstrap`, and renders `<AdminConfigCenter config={data.config} tickets={data.tickets} onRefresh={refresh} />`.

- [ ] **Step 4: Run route tests and verify they pass**

Run: `npm run test:run -- tests/app/admin-page.test.tsx`

Expected: PASS.

### Task 4: Full Verification And Browser Check

**Files:**
- Verify: all modified app, component, style, and test files.

- [ ] **Step 1: Run targeted tests**

Run: `npm run test:run -- tests/app/login-auth.test.tsx tests/app/page-navigation.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-page.test.tsx`

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run: `npm run test:run`

Expected: PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 4: Start or reuse the Next dev server and inspect `/admin`**

Open `http://localhost:3000/admin` in the in-app browser. Verify the backend login is visible, login with `admin123`, and confirm the PC config center appears without record-management sections.

- [ ] **Step 5: Stop any helper process only if this turn started it**

If a new dev server was started for this task, stop that process before finishing. Leave pre-existing user processes alone.
