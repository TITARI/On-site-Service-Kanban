# Exhibitor Ticket Linkage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link tickets to a specific project exhibitor, require selection when one booth has multiple exhibitors, support WeChat follow-up selection, and expose authenticated exhibitor lookup to mobile members.

**Architecture:** Add `exhibitionBoothId` to tickets while retaining booth/company snapshots. A shared resolution service queries the active project and returns zero, one, or many exhibitor candidates. Mobile/API submission, automatic message intake, and WeChat sessions all use the same resolution result so no path silently chooses the first company.

**Tech Stack:** Next.js App Router, React, TypeScript, MariaDB/mysql2, Zod, Vitest, Testing Library, existing RBAC sessions and wxauto watchtower.

---

## Prerequisites

Complete:

- `docs/superpowers/plans/2026-06-11-user-rbac-management.md`
- `docs/superpowers/plans/2026-06-13-exhibitor-data-dashboard-foundation.md`

Verify:

```powershell
Test-Path src/lib/repositories/exhibitor-repository.ts
Test-Path src/components/exhibitor-dashboard.tsx
npm.cmd run test:run -- tests/repositories/exhibitor-file-repository.test.ts tests/components/exhibitor-dashboard.test.tsx
```

Expected: both paths are `True` and tests pass.

---

### Task 1: Add Ticket And Pending-Session Exhibitor References

**Files:**
- Create: `db/migrations/005_ticket_exhibitor_linkage.sql`
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/domain/app-state.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/storage/file-store.ts`
- Modify: `scripts/db-import-state.mjs`
- Test: `tests/db/migration-schema.test.ts`
- Test: `tests/db/mariadb-state-store.test.ts`
- Test: `tests/services/file-store.test.ts`

- [ ] **Step 1: Write failing schema and round-trip tests**

```ts
it("adds exhibitor linkage to tickets and pending sessions", () => {
  expect(schema).toContain("exhibition_booth_id varchar(64) NULL");
  expect(schema).toContain("exhibitor_candidates json NULL");
});

it("round trips ticket exhibitor id and company snapshot", async () => {});
it("round trips pending exhibitor candidates", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/mariadb-state-store.test.ts tests/services/file-store.test.ts
```

- [ ] **Step 3: Add schema columns and indexes**

```sql
ALTER TABLE tickets
  ADD COLUMN exhibition_booth_id varchar(64) NULL AFTER booth_number,
  ADD KEY idx_tickets_exhibitor (exhibition_booth_id);

ALTER TABLE pending_work_order_sessions
  ADD COLUMN exhibitor_id varchar(64) NULL AFTER booth_number,
  ADD COLUMN exhibitor_candidates json NULL AFTER exhibitor_id;
```

Extend:

```ts
export type PendingWorkOrderField =
  | "identityGroup"
  | "name"
  | "phone"
  | "boothNumber"
  | "exhibitor"
  | "issueType";

export type Ticket = {
  // existing fields
  exhibitionBoothId?: string;
};

export type PendingWorkOrderSession = {
  // existing fields
  exhibitorId?: string;
  exhibitorCandidates?: Array<{ id: string; companyName: string; boothNumber: string }>;
};
```

- [ ] **Step 4: Update MariaDB/file serialization**

Read and write `exhibition_booth_id`. Keep `booth_number`, `company_name`, and `company_short_name` as immutable ticket snapshots after creation.

Legacy tickets keep `exhibitionBoothId` undefined.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/mariadb-state-store.test.ts tests/services/file-store.test.ts
git add -- db/migrations/005_ticket_exhibitor_linkage.sql src/lib/domain/types.ts src/lib/domain/app-state.ts src/lib/db/mariadb-state-store.ts src/lib/storage/file-store.ts scripts/db-import-state.mjs tests/db/migration-schema.test.ts tests/db/mariadb-state-store.test.ts tests/services/file-store.test.ts
git commit -m "feat: add ticket exhibitor references"
```

---

### Task 2: Resolve Exhibitors And Require Mobile Selection

**Files:**
- Create: `src/lib/services/exhibitor-resolution-service.ts`
- Modify: `src/lib/services/ticket-service.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/app/api/tickets/route.ts`
- Modify: `src/components/ticket-submit-form.tsx`
- Test: `tests/services/exhibitor-resolution-service.test.ts`
- Test: `tests/services/ticket-service.test.ts`
- Test: `tests/api/tickets-route.test.ts`
- Test: `tests/components/ticket-submit-form.test.tsx`

- [ ] **Step 1: Write failing resolution and submission tests**

```ts
it("returns one active-project exhibitor for a unique booth", async () => {});
it("returns all companies when one booth has multiple exhibitors", async () => {});
it("never resolves an archived-project exhibitor", async () => {});
it("creates a ticket with exhibitor id and snapshots when unique", async () => {});
it("returns needs-exhibitor-selection without creating a ticket when ambiguous", async () => {});
it("accepts a valid selected exhibitor id on retry", async () => {});
it("rejects an exhibitor id from another booth or project", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-resolution-service.test.ts tests/services/ticket-service.test.ts tests/api/tickets-route.test.ts tests/components/ticket-submit-form.test.tsx
```

- [ ] **Step 3: Implement one shared resolver**

```ts
export type ExhibitorResolution =
  | { kind: "none"; boothNumber: string }
  | { kind: "unique"; exhibitor: ExhibitorListItem }
  | { kind: "multiple"; boothNumber: string; candidates: ExhibitorListItem[] };

export type ExhibitorChoice = {
  id: string;
  exhibitionId: string;
  boothNumber: string;
  companyName: string;
  location?: string;
};

export async function resolveActiveExhibitor(
  repository: ExhibitorRepository,
  boothNumber: string,
  selectedExhibitorId?: string
): Promise<ExhibitorResolution> {
  const candidates = await repository.findActiveByBooth(boothNumber);
  if (selectedExhibitorId) {
    const selected = candidates.find((item) => item.id === selectedExhibitorId);
    if (!selected) throw new Error("所选展商不属于当前展位或当前项目");
    return { kind: "unique", exhibitor: selected };
  }
  if (candidates.length === 0) return { kind: "none", boothNumber };
  if (candidates.length === 1) return { kind: "unique", exhibitor: candidates[0] };
  return { kind: "multiple", boothNumber, candidates };
}
```

Change ticket result:

```ts
export type SubmitTicketResult =
  | { kind: "created" | "urged" | "manual-review"; ticket: Ticket }
  | { kind: "needs-exhibitor-selection"; boothNumber: string; candidates: ExhibitorChoice[] };
```

Deduplication candidates must match `exhibitionBoothId` when present, not only booth number.

- [ ] **Step 4: Return `409` and render the selection step**

Ticket request body adds only:

```ts
exhibitorId: z.string().min(1).optional()
```

When ambiguous:

```ts
return NextResponse.json(result, { status: 409 });
```

`TicketSubmitForm` preserves the business payload in memory, displays radio options with company and booth, then retries with `exhibitorId`. It must not re-upload images or clear the form before success.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-resolution-service.test.ts tests/services/ticket-service.test.ts tests/api/tickets-route.test.ts tests/components/ticket-submit-form.test.tsx
git add -- src/lib/services/exhibitor-resolution-service.ts src/lib/services/ticket-service.ts src/lib/repositories/app-repository.ts src/lib/db/mariadb-state-store.ts src/app/api/tickets/route.ts src/components/ticket-submit-form.tsx tests/services/exhibitor-resolution-service.test.ts tests/services/ticket-service.test.ts tests/api/tickets-route.test.ts tests/components/ticket-submit-form.test.tsx
git commit -m "feat: require exhibitor selection for tickets"
```

---

### Task 3: Stop Automatic Message Creation For Ambiguous Booths

**Files:**
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/services/message-intake-service.ts`
- Modify: `src/lib/services/wechat-watchtower-service.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Test: `tests/services/message-intake-service.test.ts`
- Test: `tests/services/wechat-watchtower-service.test.ts`
- Test: `tests/integrations/wxauto/service.test.ts`

- [ ] **Step 1: Write failing ambiguity tests**

```ts
it("marks a multi-company booth as needs-review instead of auto-create", async () => {});
it("prompts a numbered company list in wxauto conversations", async () => {});
it("accepts a numeric company choice and resumes the original request", async () => {});
it("accepts an exact company-name choice", async () => {});
it("re-prompts on an invalid choice without creating a ticket", async () => {});
it("persists the chosen exhibitor across identity and issue-type follow-ups", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/services/message-intake-service.test.ts tests/services/wechat-watchtower-service.test.ts tests/integrations/wxauto/service.test.ts
```

- [ ] **Step 3: Add candidate metadata to message analysis**

Extend `MessageTicketAnalysis`:

```ts
exhibitorId?: string;
exhibitorCandidates?: Array<{ id: string; boothNumber: string; companyName: string }>;
```

After extracting a booth:

- zero candidates: preserve current fallback/manual behavior;
- one candidate: attach `exhibitorId`;
- multiple candidates: set `suggestedAction: "needs-review"` and do not call `createTicketService`.

- [ ] **Step 4: Add the WeChat exhibitor prompt state**

Prompt:

```ts
function exhibitorPromptText(candidates: ExhibitorChoice[]) {
  return [
    "该展位对应多个展商，请回复序号或完整展商名称：",
    ...candidates.map((item, index) => `${index + 1}. ${item.companyName}`)
  ].join("\n");
}
```

Set:

```ts
session.missingFields = ["exhibitor"];
session.exhibitorCandidates = candidates;
```

Parse a reply as either `1..N` or exact normalized company name. On success, set `session.exhibitorId`, remove `"exhibitor"`, and resume the original request. On failure, retain the session and prompt again.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/message-intake-service.test.ts tests/services/wechat-watchtower-service.test.ts tests/integrations/wxauto/service.test.ts
git add -- src/lib/domain/types.ts src/lib/services/message-intake-service.ts src/lib/services/wechat-watchtower-service.ts src/lib/db/mariadb-state-store.ts tests/services/message-intake-service.test.ts tests/services/wechat-watchtower-service.test.ts tests/integrations/wxauto/service.test.ts
git commit -m "feat: prompt for ambiguous booth exhibitors"
```

---

### Task 4: Add Authenticated Mobile Exhibitor Lookup

**Files:**
- Create: `src/app/api/exhibitors/route.ts`
- Create: `src/components/mobile-exhibitor-list.tsx`
- Modify: `src/components/mobile-shell.tsx`
- Modify: `src/app/page.tsx`
- Modify: `src/styles/globals.css`
- Test: `tests/api/exhibitors-route.test.ts`
- Test: `tests/components/mobile-exhibitor-list.test.tsx`
- Test: `tests/app/page-navigation.test.tsx`

- [ ] **Step 1: Write failing mobile lookup tests**

```ts
it("requires a mobile session", async () => {});
it("allows authenticated members to search active-project exhibitors", async () => {});
it("filters scope=mine by builder assignment and actor person id", async () => {});
it("forces builder-group members to their own assignments even when scope=all is requested", async () => {});
it("allows ordinary authenticated members to query all active-project exhibitors", async () => {});
it("does not trust a person id supplied in the query string", async () => {});
it("shows booth, company, location, type, sales and builders", async () => {});
it("defaults builder-group users to My assignments", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/api/exhibitors-route.test.ts tests/components/mobile-exhibitor-list.test.tsx tests/app/page-navigation.test.tsx
```

- [ ] **Step 3: Implement the protected read route**

```ts
const auth = await requireRequestActor(request, "mobile");
if (!auth.ok) return auth.response;

const builderOnly = auth.actor.groupId === "builder" || auth.actor.groupName.includes("搭建");
const scope = builderOnly || searchParams.get("scope") === "mine" ? "mine" : "all";
const result = await repository.listActiveExhibitors({
  search: searchParams.get("search") ?? undefined,
  builderPersonId: scope === "mine" ? auth.actor.personId : undefined,
  page,
  pageSize
});
```

Return only exhibitor display fields and builder names/phones needed by the UI. Resolve builder-group membership server-side from the authenticated actor; never trust a client role or person ID.

- [ ] **Step 4: Add the fourth mobile tab**

Extend:

```ts
export type MobileTab = "submit" | "tickets" | "exhibitors" | "mine";
```

Use a Lucide building/table icon. Keep four labeled tabs. `MobileExhibitorList` provides:

- search;
- assigned-only results for builder-group members, with a clear “仅显示我负责的展商” label;
- All/My assignments toggle for ordinary members who also have builder assignments;
- readable cards;
- empty state;
- retry state;
- no edit controls.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/api/exhibitors-route.test.ts tests/components/mobile-exhibitor-list.test.tsx tests/app/page-navigation.test.tsx
git add -- src/app/api/exhibitors/route.ts src/components/mobile-exhibitor-list.tsx src/components/mobile-shell.tsx src/app/page.tsx src/styles/globals.css tests/api/exhibitors-route.test.ts tests/components/mobile-exhibitor-list.test.tsx tests/app/page-navigation.test.tsx
git commit -m "feat: add mobile exhibitor lookup"
```

---

### Task 5: Complete Compatibility, Documentation, And End-To-End Verification

**Files:**
- Modify: `src/lib/domain/ticket-summary.ts`
- Modify: `src/components/ticket-detail.tsx`
- Modify: `src/components/ticket-list.tsx`
- Modify: `tests/components/ticket-detail.test.tsx`
- Modify: `tests/components/ticket-list.test.tsx`
- Modify: `README.md`
- Modify: `docs/wxauto-rest-bridge-trial.md`

- [ ] **Step 1: Add final compatibility tests**

Cover:

- legacy ticket without exhibitor ID still renders;
- new ticket detail shows the company snapshot;
- later exhibitor edits do not rewrite ticket snapshots;
- duplicate detection is scoped to exhibitor when IDs exist;
- admin/manual-review records show candidate companies;
- the wxauto guide documents numbered company selection.

- [ ] **Step 2: Run targeted verification**

```powershell
npm.cmd run test:run -- tests/services/ticket-service.test.ts tests/services/message-intake-service.test.ts tests/services/wechat-watchtower-service.test.ts tests/api/tickets-route.test.ts tests/api/exhibitors-route.test.ts tests/components/ticket-submit-form.test.tsx tests/components/mobile-exhibitor-list.test.tsx tests/components/ticket-detail.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 3: Update documentation**

Document:

- tickets save exhibitor ID plus booth/company snapshots;
- mobile selection for shared booths;
- WeChat numbered selection;
- builder-member exhibitor lookup;
- legacy tickets remain valid.

- [ ] **Step 4: Run full verification**

```powershell
npm.cmd run test:run
npm.cmd run build
git diff --check
```

Expected: all tests pass, build exits `0`, and diff check is clean.

- [ ] **Step 5: Commit**

```powershell
git add -- src/lib/domain/ticket-summary.ts src/components/ticket-detail.tsx src/components/ticket-list.tsx tests/components/ticket-detail.test.tsx tests/components/ticket-list.test.tsx README.md docs/wxauto-rest-bridge-trial.md
git commit -m "docs: complete exhibitor ticket linkage"
```

---

## Linkage Acceptance Check

1. A unique booth creates a ticket linked to its exhibitor automatically.
2. A shared booth never silently selects the first company.
3. Mobile submitters can choose a company and retry without losing form data.
4. WeChat users receive a numbered company list and can continue after choosing.
5. Ambiguous automatic messages do not create a ticket before selection.
6. Tickets retain booth/company snapshots after later exhibitor edits.
7. Authenticated members can search active-project exhibitors.
8. Builder members can filter to their assigned exhibitors.
9. Legacy tickets and historical workflows still render and operate.
