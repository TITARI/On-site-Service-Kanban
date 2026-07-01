# TanStack Table Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace handwritten row modeling in the exhibitor dashboard and admin user list with TanStack Table v8 while preserving their existing UI and adding correct server-side user pagination.

**Architecture:** The exhibitor table uses client-side filtering, pagination, and row selection with stable booth IDs. The admin user list uses manual server pagination driven by Table state and TanStack Query; it does not perform misleading client-side sorting or filtering on a partial page.

**Tech Stack:** React 19, Next.js 16, TypeScript, `@tanstack/react-table` 8.21.3, TanStack Query v5, Vitest, Testing Library

---

## File map

- Modify `package.json` and `package-lock.json`: add the exact TanStack Table v8 dependency.
- Modify `src/components/admin-users-panel.tsx`: add manual server pagination and render the responsive ARIA table from a TanStack row model.
- Modify `src/components/exhibitor-dashboard.tsx`: replace handwritten filtering, pagination, and selection with a client-side TanStack row model.
- Modify `tests/components/admin-users-panel.test.tsx`: cover server page navigation and filter page reset.
- Modify `tests/components/exhibitor-dashboard.test.tsx`: cover selection reset when the incoming dataset changes.
- Keep existing CSS files unchanged; all current classes and responsive structures remain in place.

The repository rule “one task = one commit” overrides the generic skill preference for frequent commits. All tasks below remain uncommitted until the final verified commit.

### Task 1: Add failing admin pagination contracts

**Files:**
- Modify: `tests/components/admin-users-panel.test.tsx`

- [x] **Step 1: Add a server-page navigation test**

Add a test whose fetch handler returns a distinct user for each `page` parameter:

```tsx
it("loads the next server page through the user table", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const page = Number(url.searchParams.get("page") ?? "1");
    return new Response(JSON.stringify({
      users: [user({
        personId: `person-${page}`,
        name: page === 1 ? "第一页用户" : "第二页用户"
      })],
      total: 21,
      page,
      pageSize: 20
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const driver = userEvent.setup();

  renderWithQueryClient(<AdminUsersPanel groups={groups} />);
  expect(await screen.findByText("第一页用户")).not.toBeNull();
  await driver.click(screen.getByRole("button", { name: "下一页" }));

  expect(await screen.findByText("第二页用户")).not.toBeNull();
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("page=2"))).toBe(true);
});
```

- [x] **Step 2: Add a filter reset test**

Navigate to page 2, enter a search term, submit the existing filter form, and assert that the last users request contains both `page=1` and the encoded search value.

- [x] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-users-panel.test.tsx
```

Expected: the new tests fail because no `下一页` control or pagination state exists.

### Task 2: Implement the manual admin user table

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/components/admin-users-panel.tsx`

- [x] **Step 1: Install the exact v8 dependency**

Run:

```powershell
npm.cmd install @tanstack/react-table@8.21.3 --save-exact
```

Expected: package and lockfile add `@tanstack/react-table` plus its table-core dependency.

- [x] **Step 2: Make the request pagination-aware**

Change `usersUrl` to accept `PaginationState` and serialize `pageIndex + 1` and `pageSize`. Store pagination as:

```ts
const [pagination, setPagination] = useState<PaginationState>({
  pageIndex: 0,
  pageSize: 20
});
```

Include pagination in the users query key and URL. Use `placeholderData: (previous) => previous` so a page transition does not flash an empty table.

- [x] **Step 3: Define columns and create the table**

Create memoized `ColumnDef<UserListItem>[]` for the existing five columns. Preserve the current cell markup, icons, labels, actions, and error messages. Instantiate:

```ts
const table = useReactTable({
  data: users,
  columns,
  getCoreRowModel: getCoreRowModel(),
  getRowId: (row) => row.personId,
  manualPagination: true,
  rowCount: total,
  state: { pagination },
  onPaginationChange: setPagination
});
```

Render headers and cells using `table.getHeaderGroups()`, `table.getRowModel().rows`, and `flexRender`, while keeping the `div/article` ARIA table and all CSS classes.

- [x] **Step 4: Add minimal pagination controls**

After the list, add a navigation region with existing button classes:

```tsx
<nav className="admin-user-toolbar-actions" aria-label="用户分页">
  <button className="secondary-button" type="button" aria-label="上一页"
    onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>上一页</button>
  <span>第 {pagination.pageIndex + 1} / {Math.max(table.getPageCount(), 1)} 页</span>
  <button className="secondary-button" type="button" aria-label="下一页"
    onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>下一页</button>
</nav>
```

Submitting or clearing filters must call `setPagination((value) => ({ ...value, pageIndex: 0 }))`. Clamp the page index when a mutation reduces `total` below the current page boundary.

- [x] **Step 5: Run the admin tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-users-panel.test.tsx
```

Expected: all admin user component tests pass without React warnings.

### Task 3: Add a failing exhibitor selection lifecycle contract

**Files:**
- Modify: `tests/components/exhibitor-dashboard.test.tsx`

- [x] **Step 1: Add the dataset replacement test**

```tsx
it("clears table selection when the incoming exhibitor dataset changes", async () => {
  const driver = userEvent.setup();
  const { rerender } = render(
    <ExhibitorDashboard booths={makePaginationBooths(2)} isImporting={false} onImportFile={vi.fn()} />
  );
  await driver.click(screen.getByLabelText("选择Company 1"));
  expect(screen.getByText("已选择 1 个展商")).not.toBeNull();

  rerender(
    <ExhibitorDashboard booths={makePaginationBooths(2).map((booth, index) => ({
      ...booth,
      boothNumber: `R${index + 1}`,
      companyName: `Replacement ${index + 1}`
    }))} isImporting={false} onImportFile={vi.fn()} />
  );

  await waitFor(() => expect(screen.queryByText("已选择 1 个展商")).toBeNull());
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx
```

Expected: the new test fails because the handwritten `selectedKeys` survives prop replacement.

### Task 4: Implement the client-side exhibitor table

**Files:**
- Modify: `src/components/exhibitor-dashboard.tsx`

- [x] **Step 1: Replace handwritten table state**

Import TanStack Table primitives and replace `currentPage`, `pageSize`, and `selectedKeys` with:

```ts
const [pagination, setPagination] = useState<PaginationState>({
  pageIndex: 0,
  pageSize: EXHIBITOR_PAGE_SIZE
});
const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
```

Reset both page index and row selection when `incomingBooths` changes.

- [x] **Step 2: Define filtering and columns**

Use a custom global filter based on existing `boothSearchText`. Define exact/custom column filters for location, type, assignment state, and member name. Keep column definitions as a stable module-level constant and preserve the existing nine visible headers and cell JSX.

- [x] **Step 3: Create the row model**

Instantiate `useReactTable` with:

```ts
const table = useReactTable({
  data: booths,
  columns,
  getRowId: (row) => boothRecordKey(row),
  getCoreRowModel: getCoreRowModel(),
  getFilteredRowModel: getFilteredRowModel(),
  getPaginationRowModel: getPaginationRowModel(),
  enableRowSelection: true,
  state: { globalFilter: searchQuery, columnFilters, pagination, rowSelection },
  onPaginationChange: setPagination,
  onRowSelectionChange: setRowSelection,
  globalFilterFn: (row, _columnId, value) => boothSearchText(row.original).includes(String(value).trim().toLowerCase())
});
```

Filter control handlers explicitly reset the page index. Keep the existing domain values (`all`, `assigned`, `unassigned`) at the UI boundary.

- [x] **Step 4: Render table and cards from the same rows**

Render the existing desktop table and mobile cards from the same `table.getRowModel().rows`, using each row's `original` domain record for the established JSX. Drive current-page selection from `getIsAllPageRowsSelected`, `getIsSomePageRowsSelected`, and `toggleAllPageRowsSelected`.

Use `table.getSelectedRowModel().flatRows.map((row) => row.original)` for batch operations. When an edited booth changes its row ID, migrate that key in `rowSelection`. Preserve empty states, footer text, numbered pagination, all CSS classes, and all ARIA labels.

- [x] **Step 5: Run the exhibitor tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx
```

Expected: all exhibitor tests pass, including existing filtering, pagination, dialogs, batch operations, and the new dataset replacement contract.

### Task 5: Verify, document, and create the single commit

**Files:**
- Verify all files listed above plus the approved design and this plan.

- [x] **Step 1: Run TypeScript and focused component verification**

```powershell
npm.cmd run test:run -- tests/components/exhibitor-dashboard.test.tsx tests/components/admin-users-panel.test.tsx
```

Expected: the focused suite exits 0. A standalone `tsc --noEmit` is not an acceptance gate on the current `main` because its deprecated `baseUrl` fails under the shared TypeScript 6 runtime; `npm.cmd run build` below performs and passes the project TypeScript check.

- [x] **Step 2: Run full verification**

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit
```

Expected: at least the 775-test baseline passes, build exits 0, and audit vulnerabilities do not exceed the baseline of 3.

- [x] **Step 3: Run diff and status checks**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: only task files and the approved design/plan are changed; no generated `.next` or dependency directory is tracked.

- [ ] **Step 4: Commit once with the requested message**

```powershell
git add package.json package-lock.json src/components/exhibitor-dashboard.tsx src/components/admin-users-panel.tsx tests/components/exhibitor-dashboard.test.tsx tests/components/admin-users-panel.test.tsx docs/superpowers/specs/2026-07-01-tanstack-table-migration-design.md docs/superpowers/plans/2026-07-01-tanstack-table-migration.md
git commit -m "refactor(frontend): 用 TanStack Table 替换手写表格"
```

- [ ] **Step 5: Push and open one PR**

Push `codex/p3-01-tanstack-table` and create a ready PR targeting `main`, including test, build, and audit evidence in the body.
