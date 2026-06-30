# Radix Dialog Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the eight approved hand-written modal surfaces with Radix Dialog/AlertDialog while preserving business behavior and existing visual CSS.

**Architecture:** Keep every existing boolean/object state and business callback in its current owner. Replace only modal shells with controlled Radix Root/Portal/Overlay/Content composition, route every dismiss path through `onOpenChange(false)`, and rely on Radix for focus containment, auto-focus, Escape, focus restoration, and ARIA wiring. Use isolated Dialog scopes for the concurrently mounted dashboard roots and real triggers for focus restoration. Use AlertDialog only for destructive batch disable.

**Tech Stack:** Next.js 16, React 19, TypeScript 6, `@radix-ui/react-dialog@1.1.17`, `@radix-ui/react-alert-dialog@1.1.17`, Vitest 4, Testing Library/User Event.

---

## Workflow constraints

- Base: merged `main` at `c094e38275ff7486b4e75dad60407d01ddd8a2f6` or newer.
- Worktree: `.worktrees/p1-04-radix-dialog` on `codex/p1-04-radix-dialog`.
- One task = one commit = one PR. Do not create intermediate commits even though the generic planning skill normally recommends them.
- Approved scope contains exactly eight surfaces: seven in `exhibitor-dashboard.tsx` and one in `admin-user-import.tsx`.
- Do not modify `exhibitor-import-wizard.tsx`, `exhibition-project-selector.tsx`, `admin-users-panel.tsx` identity confirmation, or `ticket-detail.tsx` image viewer.
- Preserve current strings, business state, API calls, form data, save handlers, CSS classes, stacking, responsive behavior, and nested drawer/member-assignment flow.
- Baseline gates: 94 files / 767 tests, successful build, 3 audit findings (2 moderate, 1 high).

## File map

**Create:**

- `docs/superpowers/specs/2026-06-30-radix-dialog-migration-design.md`
- `docs/superpowers/plans/2026-06-30-radix-dialog-migration.md`

**Modify:**

- `package.json`: exact Radix dependencies.
- `package-lock.json`: Radix dependency graph only.
- `src/components/exhibitor-dashboard.tsx`: seven controlled Radix surfaces and removal of manual drawer focus/Escape code.
- `src/components/admin-user-import.tsx`: one Radix Dialog shell.
- `src/components/admin-users-panel.tsx`: parent Root/Trigger wiring required for import-dialog focus restoration.
- `tests/components/exhibitor-dashboard.test.tsx`: direct keyboard/focus behavior for all seven surfaces.
- `tests/components/admin-panel.test.tsx`: integration role/lifecycle regression for the detail drawer.
- `tests/components/admin-user-import.test.tsx`: import dialog keyboard/focus lifecycle through the real parent trigger.

`src/styles/globals.css` should remain unchanged because the existing layer, scrim, panel, and drawer classes are retained on Radix-rendered elements. If focused testing demonstrates a selector regression, make only the selector-preserving change and record the exact reason in the PR.

## Task 1: Install exact Radix dependencies

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Confirm registry versions and React 19 peers**

Run:

```powershell
npm.cmd view @radix-ui/react-dialog version peerDependencies --json
npm.cmd view @radix-ui/react-alert-dialog version peerDependencies --json
```

Expected for both packages: version `1.1.17`; peer ranges include React and React DOM 19.

- [ ] **Step 2: Install both packages exactly**

Run:

```powershell
npm.cmd install --save-exact @radix-ui/react-dialog@1.1.17 @radix-ui/react-alert-dialog@1.1.17
```

Expected `package.json` entries:

```json
"@radix-ui/react-alert-dialog": "1.1.17",
"@radix-ui/react-dialog": "1.1.17"
```

- [ ] **Step 3: Verify resolution and audit count**

Run:

```powershell
npm.cmd ls @radix-ui/react-dialog @radix-ui/react-alert-dialog --depth=0 --json
node -e "const p=require('./package-lock.json'); console.log(p.packages['node_modules/@radix-ui/react-dialog'].version); console.log(p.packages['node_modules/@radix-ui/react-alert-dialog'].version)"
npm.cmd audit --json
```

Expected: both lines are `1.1.17`; audit total is no higher than 3.

## Task 2: Migrate the detail drawer with a TDD focus lifecycle

**Files:**

- Modify: `tests/components/exhibitor-dashboard.test.tsx`
- Modify: `tests/components/admin-panel.test.tsx`
- Modify: `src/components/exhibitor-dashboard.tsx`

- [ ] **Step 1: Write a failing direct drawer lifecycle test**

In `tests/components/exhibitor-dashboard.test.tsx`, add a test using the existing `booths[0]` fixture:

```tsx
it("traps focus in the detail drawer, closes with Escape, and restores the opener", async () => {
  const user = userEvent.setup();
  render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

  const table = screen.getByRole("table", { name: "展商数据表格" });
  const opener = within(table).getByRole("button", { name: `查看${booths[0].companyName}` });
  await user.click(opener);

  const drawer = screen.getByRole("dialog", { name: "展商详情" });
  expect(drawer.contains(document.activeElement)).toBe(true);

  const firstButton = within(drawer).getByRole("button", { name: "关闭详情" });
  const buttons = within(drawer).getAllByRole("button");
  buttons.at(-1)?.focus();
  await user.tab();
  expect(document.activeElement).toBe(firstButton);

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "展商详情" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
```

Use the repository's actual UTF-8 fixture strings; do not copy mojibake from shell output.

- [ ] **Step 2: Update the integration expectation to the desired role**

In `tests/components/admin-panel.test.tsx`, change the existing lifecycle test to query the drawer as:

```ts
const drawer = screen.getByRole("dialog", { name: "展商详情" });
```

and close with:

```ts
await user.keyboard("{Escape}");
expect(screen.queryByRole("dialog", { name: "展商详情" })).toBeNull();
await waitFor(() => expect(document.activeElement).toBe(viewButton));
```

Update all other changed test-file references from `complementary` to `dialog`; the production role is intentionally changing from a non-modal landmark to a modal dialog.

- [ ] **Step 3: Run the drawer tests and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx
```

Expected: FAIL because the current drawer has role `complementary` and does not use Radix focus containment.

- [ ] **Step 4: Import Dialog and remove manual focus state**

At the top of `src/components/exhibitor-dashboard.tsx`, use:

```ts
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useEffect, useState, type ReactNode } from "react";
```

Delete:

```ts
const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
```

Change both table and card view buttons from handlers that assign `detailReturnFocusRef.current` to the direct state transition:

```tsx
onClick={() => setActiveBooth(booth)}
```

- [ ] **Step 5: Remove manual drawer dismissal code**

Keep drawer state cleanup but make it synchronous:

```ts
function closeDetailDrawer() {
  setActiveBooth(null);
  setEditingBooth(null);
}
```

Delete the entire `useEffect` that registers `document.addEventListener("keydown", handleKeyDown)` for `activeBooth`.

- [ ] **Step 6: Replace the drawer shell with controlled Radix Dialog**

Wrap the existing drawer body with this exact shell; retain all content currently inside the `<aside>` unchanged:

```tsx
<Dialog.Root
  open={Boolean(activeBooth)}
  onOpenChange={(open) => {
    if (!open) closeDetailDrawer();
  }}
>
  {activeBooth && (
    <Dialog.Portal>
      <div className="exhibitor-detail-layer">
        <Dialog.Overlay className="exhibitor-detail-scrim" />
        <Dialog.Content className="exhibitor-detail-drawer" aria-label="展商详情">
          <Dialog.Title className="sr-only">展商详情</Dialog.Title>
          <div className="exhibitor-detail-head">
            <div>
              <span>{displayText(activeBooth.boothType)}</span>
              <h4>{activeBooth.companyName}</h4>
              <Dialog.Description asChild>
                <p>展位 {activeBooth.boothNumber}</p>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="ghost-button" type="button" aria-label="关闭详情">关闭</button>
            </Dialog.Close>
          </div>
```

Replace the former drawer closing tags with:

```tsx
        </Dialog.Content>
      </div>
    </Dialog.Portal>
  )}
</Dialog.Root>
```

Wrap the existing footer “取消” button with `Dialog.Close asChild` and remove its `onClick={closeDetailDrawer}`. Keep edit, assignment, and enable/disable handlers unchanged.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx
```

Expected: the independent drawer lifecycle tests PASS. Existing tests that open the still-hand-written edit/member-assignment layers remain RED until Task 3 migrates those nested surfaces; no Radix missing-title/description warnings appear.

## Task 3: Migrate the six dashboard dialogs, including destructive AlertDialog

**Files:**

- Modify: `tests/components/exhibitor-dashboard.test.tsx`
- Modify: `src/components/exhibitor-dashboard.tsx`

- [ ] **Step 1: Add failing Escape and restoration tests for normal dialogs**

Add one test for each of the five normal dialogs. Each test must retain its opener reference, assert focus enters the dialog, press Escape, assert the dialog is gone, and assert focus returns to the opener.

Use these exact opener/dialog mappings:

| Surface | Opener query | Dialog query |
|---|---|---|
| Type settings | button `类型设置` | dialog `展商类型设置` |
| Member assignment | button matching `分配.*搭建成员` | dialog `分配现场搭建成员` |
| Import diff | button `处理导入差异` | dialog `导入差异数值确认` |
| Edit exhibitor | drawer button `编辑展商数据` | dialog `编辑展商数据` |
| Batch type | button `批量修改类型` | dialog `批量修改类型` |

The common assertion body is:

```ts
await user.click(opener);
const dialog = screen.getByRole("dialog", { name: dialogName });
expect(dialog.contains(document.activeElement)).toBe(true);
await user.keyboard("{Escape}");
expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull();
await waitFor(() => expect(document.activeElement).toBe(opener));
```

For edit exhibitor, first open the detail drawer and use its edit button as `opener`. After Escape, assert the edit dialog is closed, the drawer remains open, and focus is back on that edit button.

- [ ] **Step 2: Add a failing nested member-assignment test**

Add:

```tsx
it("closes nested member assignment before the detail drawer and restores focus inside the drawer", async () => {
  const user = userEvent.setup();
  render(<ExhibitorDashboard booths={[booths[0]]} isImporting={false} onImportFile={vi.fn()} />);

  await user.click(screen.getByRole("button", { name: `查看${booths[0].companyName}` }));
  const drawer = screen.getByRole("dialog", { name: "展商详情" });
  const opener = within(drawer).getByRole("button", { name: "添加现场搭建成员" });
  await user.click(opener);

  expect(screen.getByRole("dialog", { name: "分配现场搭建成员" })).not.toBeNull();
  await user.keyboard("{Escape}");

  expect(screen.queryByRole("dialog", { name: "分配现场搭建成员" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "展商详情" })).not.toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
```

- [ ] **Step 3: Add a failing AlertDialog safety test**

Extend the existing batch-disable setup with:

```ts
const opener = screen.getByRole("button", { name: "批量停用" });
await user.click(opener);
const alert = screen.getByRole("alertdialog", { name: "批量停用展商" });
const cancel = within(alert).getByRole("button", { name: "取消" });
expect(document.activeElement).toBe(cancel);

await user.keyboard("{Escape}");
expect(screen.queryByRole("alertdialog", { name: "批量停用展商" })).toBeNull();
await waitFor(() => expect(document.activeElement).toBe(opener));
expect(within(table).queryByText("已停用")).toBeNull();
```

Update the existing confirmation test to query `alertdialog`, then click `确认停用展商` and retain its current two-row disabled assertion.

- [ ] **Step 4: Run dashboard tests and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx
```

Expected failures: the five hand-written dialogs ignore Escape; the existing drawer Escape handler closes the wrong layer in nested cases; batch disable has role `dialog` rather than `alertdialog` and does not auto-focus Cancel.

- [ ] **Step 5: Convert type settings to Dialog**

Replace its conditional outer shell with:

```tsx
<Dialog.Root open={typeDialogOpen} onOpenChange={setTypeDialogOpen}>
  {typeDialogOpen && (
    <Dialog.Portal>
      <div className="exhibitor-assignment-layer">
        <Dialog.Overlay className="exhibitor-detail-scrim" />
        <Dialog.Content className="exhibitor-assignment-dialog exhibitor-type-dialog" aria-label="展商类型设置">
```

Wrap the existing `<h4>展商类型设置</h4>` in `Dialog.Title asChild`, and its explanatory `<p>` in `Dialog.Description asChild`. Wrap both existing close and footer cancel buttons in `Dialog.Close asChild`, removing their state-setting `onClick`. Close with the matching `Dialog.Content`, layer, Portal, conditional, and Root tags.

- [ ] **Step 6: Convert member assignment to Dialog**

Use:

```tsx
<Dialog.Root
  open={Boolean(assignmentDialog)}
  onOpenChange={(open) => {
    if (!open) setAssignmentDialog(null);
  }}
>
  {assignmentDialog && (
    <Dialog.Portal>
      <div className="exhibitor-assignment-layer">
        <Dialog.Overlay className="exhibitor-detail-scrim" />
        <Dialog.Content
          className="exhibitor-assignment-dialog exhibitor-member-assignment-dialog"
          aria-label={assignmentDialog.mode === "bulk" ? "批量分配现场搭建成员" : "分配现场搭建成员"}
        >
```

Wrap the dynamic `<h4>` in `Dialog.Title asChild` and dynamic `<p>` in `Dialog.Description asChild`. Wrap header close and sticky footer cancel buttons with `Dialog.Close asChild`; remove their direct `setAssignmentDialog(null)` handlers. Keep `saveAssignment` on the confirmation button because it updates booths before closing.

- [ ] **Step 7: Convert import-diff confirmation to Dialog**

Use `open={diffDialogOpen}` and:

```tsx
onOpenChange={(open) => {
  if (!open) closeDiffDialog();
}}
```

Retain `exhibitor-assignment-layer`, `exhibitor-detail-scrim`, `exhibitor-assignment-dialog exhibitor-diff-dialog`, and accessible name `导入差异数值确认`. Wrap the title/description in their Radix primitives. Wrap header close and footer cancel in `Dialog.Close asChild` without direct handlers. Keep `applyDiffRows` on the confirmation action.

- [ ] **Step 8: Convert edit-exhibitor to Dialog**

Use `open={Boolean(editingBooth)}` with `onOpenChange={(open) => { if (!open) setEditingBooth(null); }}` and conditionally render the Portal only when `editingBooth` exists. Preserve the editor fields and all classes. Wrap title, description, close, and cancel in Dialog primitives; keep `saveEditedBooth` on the save action.

- [ ] **Step 9: Convert batch-type to Dialog**

Use `open={batchTypeDialogOpen}` with `onOpenChange={setBatchTypeDialogOpen}`. Preserve the select and classes. Wrap title, description, header close, and footer cancel in Dialog primitives; keep `saveBatchType` on the confirmation action.

- [ ] **Step 10: Convert batch-disable to AlertDialog**

Use this shell:

```tsx
<AlertDialog.Root open={batchDisableDialogOpen} onOpenChange={setBatchDisableDialogOpen}>
  {batchDisableDialogOpen && (
    <AlertDialog.Portal>
      <div className="exhibitor-assignment-layer">
        <AlertDialog.Overlay className="exhibitor-detail-scrim" />
        <AlertDialog.Content className="exhibitor-assignment-dialog" aria-label="批量停用展商">
          <div className="exhibitor-panel-head">
            <div>
              <AlertDialog.Title asChild>
                <h4>批量停用展商</h4>
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <p>已选择 {selectedKeys.size} 个展商，停用后将从默认可用列表中移出。</p>
              </AlertDialog.Description>
            </div>
            <button className="ghost-button" type="button" aria-label="关闭批量停用展商" onClick={() => setBatchDisableDialogOpen(false)}>关闭</button>
          </div>
          <div className="exhibitor-detail-actions">
            <AlertDialog.Cancel asChild>
              <button className="secondary-button" type="button">取消</button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button className="danger-button" type="button" onClick={batchDisableSelectedBooths}>确认停用展商</button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </div>
    </AlertDialog.Portal>
  )}
</AlertDialog.Root>
```

The header close remains a direct state close so the single footer Cancel remains Radix's unambiguous initial-focus target.

- [ ] **Step 11: Run dashboard tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx
```

Expected: both files PASS; the nested Escape test leaves the drawer open; batch disable is an `alertdialog`; no title/description warnings appear.

## Task 4: Migrate user batch import dialog with TDD

**Implementation correction:** Radix focus restoration targets the `Dialog.Trigger` registered in the same Root; an open-only Root inside the conditionally mounted import component cannot restore to its external opener. Therefore the parent `AdminUsersPanel` owns the controlled Root/Trigger and `AdminUserImport` renders the Portal/Overlay/Content beneath that context.

**Files:**

- Modify: `tests/components/admin-user-import.test.tsx`
- Modify: `src/components/admin-user-import.tsx`
- Modify: `src/components/admin-users-panel.tsx`

- [ ] **Step 1: Add a failing import-dialog lifecycle test through the parent**

Use the existing mocked user-list request pattern, then add:

```tsx
it("traps focus in user import, closes with Escape, and restores the import trigger", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/admin/users?page=1&pageSize=20") {
      return new Response(JSON.stringify({ users: [], total: 0 }), { status: 200 });
    }
    throw new Error(`Unexpected request ${String(input)}`);
  }));
  const user = userEvent.setup();
  renderWithQueryClient(<AdminUsersPanel groups={groups} />);

  const opener = await screen.findByRole("button", { name: "批量导入" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "批量导入用户" });
  const closeButton = within(dialog).getByRole("button", { name: "关闭导入向导" });
  expect(document.activeElement).toBe(closeButton);

  const interactive = within(dialog).getAllByRole("button");
  interactive.at(-1)?.focus();
  await user.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "批量导入用户" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
});
```

- [ ] **Step 2: Run the import test and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-user-import.test.tsx
```

Expected: FAIL because the hand-written dialog does not auto-focus, trap Tab, or close on Escape.

- [ ] **Step 3: Replace the import shell with Radix Dialog**

Add the Dialog import to both components. In `AdminUsersPanel`, wrap its section in a controlled Root and the existing import button in a Trigger:

```tsx
<Dialog.Root open={importOpen} onOpenChange={setImportOpen}>
  <section>{/* existing panel, Trigger, and conditional AdminUserImport */}</section>
</Dialog.Root>
```

In `AdminUserImport`, replace the current root `<div className="admin-import-layer">`, scrim button, and `<section>` opening with:

```tsx
<Dialog.Portal>
  <div className="admin-import-layer">
    <Dialog.Overlay className="admin-import-scrim" />
    <Dialog.Content className="admin-import-panel" aria-label="批量导入用户" aria-describedby={undefined}>
```

Replace:

```tsx
<h2 id="admin-import-title">批量导入用户</h2>
```

with:

```tsx
<Dialog.Title asChild>
  <h2>批量导入用户</h2>
</Dialog.Title>
```

Replace the header close button with:

```tsx
<Dialog.Close asChild>
  <button className="admin-icon-button" type="button" aria-label="关闭导入向导" title="关闭">
    <X size={18} aria-hidden="true" />
  </button>
</Dialog.Close>
```

Remove the button's direct `onClick={onClose}`. Replace the final `</section></div>` with `</Dialog.Content></div></Dialog.Portal>`. Keep all import workflow content and busy-state handlers unchanged.

- [ ] **Step 4: Run import tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-user-import.test.tsx
```

Expected: all import tests PASS; Escape invokes the real parent close path and restores focus.

## Task 5: Cross-feature verification, review, and delivery

**Files:**

- Review every modified file listed above.
- Modify the design/plan docs only for factual corrections discovered during implementation.

- [ ] **Step 1: Run all focused dialog tests together**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx tests/components/admin-user-import.test.tsx
```

Expected: all focused files PASS.

- [ ] **Step 2: Confirm manual drawer code and scope are gone**

Run:

```powershell
rg -n "detailReturnFocusRef|document\.addEventListener\(\"keydown\"|role=\"complementary\"|role=\"dialog\" aria-modal=\"true\"" src/components/exhibitor-dashboard.tsx src/components/admin-user-import.tsx
git status --short
git diff --name-only
```

Expected: no old manual focus/Escape/modal-role matches in the two production files. The diff contains only the approved source/tests, dependency files, and design/plan docs.

- [ ] **Step 3: Review Radix correctness**

For each of the eight surfaces, verify in the diff:

- Portal is conditionally present only while its state is open, so an empty fixed layer cannot block the page.
- Overlay and Content retain existing CSS classes.
- Content has a Title and either a Description or `aria-describedby={undefined}`.
- Escape/overlay/Close converge on one state-close path.
- Nested assignment closes before its parent drawer.
- AlertDialog has one footer Cancel initial-focus target and one Action.
- No manual focus ref, timer, keydown listener, or production test branch remains.

- [ ] **Step 4: Run fresh release gates**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
git diff --check
```

Expected: at least 94 files / 767 tests pass, build succeeds, audit is no higher than 3, and diff check emits no errors.

- [ ] **Step 5: Stage only P1-04 files and inspect the staged patch**

Run:

```powershell
git add package.json package-lock.json src/components/exhibitor-dashboard.tsx src/components/admin-user-import.tsx src/components/admin-users-panel.tsx tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx tests/components/admin-user-import.test.tsx docs/superpowers/specs/2026-06-30-radix-dialog-migration-design.md docs/superpowers/plans/2026-06-30-radix-dialog-migration.md
git diff --cached --check
git diff --cached --stat
git status --short
```

Expected: only approved files are staged and the patch check is clean.

- [ ] **Step 6: Create the single required commit**

Use the user-provided message exactly:

```text
refactor(frontend): 用 Radix Dialog 替换手写对话框

exhibitor-dashboard 的 6 个对话框手写焦点恢复，仅 1 个有 Escape
处理，5 个缺 focus trap / auto-focus / 焦点恢复。

- 安装 @radix-ui/react-dialog + @radix-ui/react-alert-dialog
- 6 个对话框改用 Radix Dialog.Root/Portal/Overlay/Content
- 移除手写 detailReturnFocusRef 和 Escape 监听
- Radix 提供：focus trap、auto-focus、Escape、焦点恢复、ARIA
- 保留现有 CSS 类名（Radix 是 headless）

消除 5 个 a11y bug。
```

The message retains the task's historical “6 dialogs” wording exactly. The PR body must explain the audited 7+1 approved scope.

- [ ] **Step 7: Push and create one ready PR**

Push `codex/p1-04-radix-dialog` and create a ready PR targeting `main`. The PR body must include:

- exact Radix versions `1.1.17`;
- audited scope correction: seven dashboard surfaces plus one user-import surface;
- Dialog versus AlertDialog mapping;
- removal of manual drawer focus/Escape code;
- focused/full test counts, build result, and audit count;
- explicit non-goals for image viewer and other unapproved dialogs.
