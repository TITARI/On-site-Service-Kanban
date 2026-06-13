# Exhibitor Data Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build project-scoped exhibitor storage, AI-assisted multi-sheet workbook imports, field-level conflict review, builder-member assignment, and the approved admin exhibitor dashboard.

**Architecture:** Add a focused exhibitor repository beside the existing app repository, backed by MariaDB or the JSON state file. Imports are staged: stream the workbook to temporary storage, inspect sheets, map fields with rules plus smart AI, normalize candidates, preview diffs, then apply accepted decisions transactionally. The admin UI consumes dedicated project, exhibitor, assignment, type, and import APIs rather than expanding the existing monolithic bootstrap payload.

**Tech Stack:** Next.js App Router, React, TypeScript, MariaDB/mysql2, SheetJS `xlsx`, `busboy`, Zod, Vitest, Testing Library, existing OpenAI-compatible HTTP provider.

---

## Prerequisite

Execute and verify `docs/superpowers/plans/2026-06-11-user-rbac-management.md` first. This plan depends on:

- `src/lib/domain/access-control.ts`
- `src/lib/services/session-service.ts`
- `src/lib/services/auth-service.ts`
- `requireRequestActor(request, "admin", "admin.access")`
- server-side mobile/admin cookies
- `Person.groupId`, `UserGroup.canAdmin`, and protected admin APIs

Verify the prerequisite before creating a feature worktree:

```powershell
Test-Path src/lib/domain/access-control.ts
Test-Path src/lib/services/session-service.ts
npm.cmd run test:run -- tests/services/session-service.test.ts tests/api/admin-auth-routes.test.ts tests/api/mobile-auth-routes.test.ts
```

Expected: both paths are `True` and all selected tests pass.

## File Structure

### New domain and service files

- `src/lib/domain/exhibitors.ts`: exhibitor/project/import types and deterministic normalization.
- `src/lib/services/workbook-upload-service.ts`: bounded multipart upload and temporary-file cleanup.
- `src/lib/services/workbook-inspection-service.ts`: SheetJS workbook/sheet/header inspection.
- `src/lib/services/exhibitor-field-mapping-service.ts`: alias rules, saved templates, and AI mapping merge.
- `src/lib/services/exhibitor-normalization-service.ts`: candidate creation, location/area/type normalization, builder parsing.
- `src/lib/services/exhibitor-import-diff-service.ts`: new/update/missing/invalid comparison and field decisions.
- `src/lib/services/exhibitor-import-service.ts`: import workflow orchestration and transactional apply.
- `src/lib/services/exhibitor-state-service.ts`: JSON-file implementation of project/exhibitor/import operations.
- `src/lib/repositories/exhibitor-repository.ts`: storage-neutral interface and repository factory.
- `src/lib/db/mariadb-exhibitor-store.ts`: MariaDB implementation.

### New UI files

- `src/components/exhibition-data-panel.tsx`: page-level data loading and state.
- `src/components/exhibition-project-selector.tsx`: create/select/activate projects.
- `src/components/exhibitor-dashboard.tsx`: metrics, filters, table, bulk actions.
- `src/components/exhibitor-detail-drawer.tsx`: edit seven business fields and assignments.
- `src/components/exhibitor-assignment-dialog.tsx`: batch member assignment.
- `src/components/exhibitor-import-wizard.tsx`: upload, mapping, preview, decisions, apply.

### New API groups

- `src/app/api/admin/exhibitions/**`
- `src/app/api/admin/exhibitors/**`
- `src/app/api/admin/exhibitor-types/**`
- `src/app/api/admin/exhibitor-imports/**`

Keep `src/components/admin-panel.tsx` responsible for navigation/configuration. It should delegate the exhibition-data view to `ExhibitionDataPanel`.

---

### Task 1: Add The Project And Exhibitor Domain Model

**Files:**
- Create: `src/lib/domain/exhibitors.ts`
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/domain/app-state.ts`
- Modify: `src/lib/storage/file-store.ts`
- Test: `tests/domain/exhibitors.test.ts`
- Test: `tests/services/file-store.test.ts`

- [ ] **Step 1: Write failing normalization and identity tests**

```ts
import { describe, expect, it } from "vitest";
import {
  exhibitorIdentityKey,
  normalizeBoothNumber,
  normalizeCompanyName,
  parseArea,
  buildLocation
} from "@/lib/domain/exhibitors";

describe("exhibitor domain", () => {
  it("uses project, booth and company as the stable identity", () => {
    expect(exhibitorIdentityKey("expo-1", " 1at27 ", " 郑州 鑫利农农业科技有限公司 "))
      .toBe("expo-1|1AT27|郑州鑫利农农业科技有限公司");
  });

  it("keeps same-booth different-company exhibitors distinct", () => {
    expect(exhibitorIdentityKey("expo-1", "1AT27", "甲公司"))
      .not.toBe(exhibitorIdentityKey("expo-1", "1AT27", "乙公司"));
  });

  it("combines floor and hall without inventing missing values", () => {
    expect(buildLocation("一楼", "1E")).toBe("一楼 / 1E");
    expect(buildLocation("", "2D")).toBe("2D");
  });

  it("parses numeric area and dimensions independently", () => {
    expect(parseArea("36㎡，9×4m")).toEqual({ squareMeters: 36, specification: "9×4m" });
    expect(parseArea("9")).toEqual({ squareMeters: 9, specification: undefined });
  });

  it("normalizes non-breaking and full-width spaces", () => {
    expect(normalizeBoothNumber(" １ＡＴ ２７ ")).toBe("1AT27");
    expect(normalizeCompanyName("河南\u00a0某某　有限公司")).toBe("河南某某有限公司");
  });
});
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/domain/exhibitors.test.ts tests/services/file-store.test.ts
```

Expected: FAIL because the exhibitor domain and new state collections do not exist.

- [ ] **Step 3: Define the focused types**

Add these types to `src/lib/domain/exhibitors.ts`:

```ts
export type ExhibitionProject = {
  id: string;
  name: string;
  status: "draft" | "active" | "archived";
  startsAt?: string;
  endsAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ExhibitorType = {
  id: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
};

export type ExhibitorRecord = {
  id: string;
  exhibitionId: string;
  boothNumber: string;
  normalizedBoothNumber: string;
  companyName: string;
  normalizedCompanyName: string;
  location?: string;
  areaSquareMeters?: number;
  areaSpecification?: string;
  exhibitorType?: string; // Stores ExhibitorType.id.
  salesOwner?: string;
  enabled: boolean;
  manuallyEditedFields: ExhibitorBusinessField[];
  createdAt: string;
  updatedAt: string;
};

export type ExhibitorBuilderAssignment = {
  exhibitorId: string;
  personId: string;
  assignedBy: string;
  assignedAt: string;
};

export type ExhibitorListItem = ExhibitorRecord & {
  builders: Array<{ personId: string; name: string; phone: string }>;
};

export type ImportMappingSource = "rule" | "template" | "ai" | "manual";
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

export type ImportFieldMapping = {
  field: ImportSystemField;
  columnIndex: number;
  sourceHeader: string;
  source: ImportMappingSource;
  confidence: number;
  reason: string;
};

export type ExhibitorImportJobStatus =
  | "uploaded"
  | "mapping"
  | "preview"
  | "ready"
  | "applying"
  | "completed"
  | "cancelled"
  | "failed";

export type ExhibitorBusinessField =
  | "boothNumber"
  | "companyName"
  | "location"
  | "areaSquareMeters"
  | "areaSpecification"
  | "exhibitorType"
  | "salesOwner";

export type ExhibitorBusinessPatch = Partial<
  Pick<ExhibitorRecord, ExhibitorBusinessField | "enabled">
>;

export type ExhibitorTypeMutation = {
  id?: string;
  name: string;
  enabled: boolean;
  sortOrder: number;
};

export type ExhibitorImportCandidate = {
  key: string;
  exhibitionId: string;
  boothNumber: string;
  companyName: string;
  location?: string;
  areaSquareMeters?: number;
  areaSpecification?: string;
  exhibitorType?: string;
  salesOwner?: string;
  matchedBuilderPersonIds: string[];
  unmatchedBuilderLabels: string[];
  sources: Array<{ sheetName: string; rowNumber: number }>;
  fieldConfidence: Partial<Record<ExhibitorBusinessField, number>>;
  errors: string[];
};

export type FieldDiff = {
  field: ExhibitorBusinessField;
  existingValue: string | number | boolean | undefined;
  incomingValue: string | number | boolean | undefined;
  manuallyEdited: boolean;
};

export type ImportFieldDecision = {
  field: ExhibitorBusinessField;
  choice: "incoming" | "existing";
};

export type ExhibitorImportDiff =
  | { kind: "new"; diffKey: string; candidate: ExhibitorImportCandidate }
  | { kind: "update"; diffKey: string; exhibitorId: string; candidate: ExhibitorImportCandidate; fields: FieldDiff[] }
  | { kind: "unchanged"; diffKey: string; exhibitorId: string; candidate: ExhibitorImportCandidate }
  | { kind: "missing"; diffKey: string; exhibitor: ExhibitorRecord; sourceScope: string[] }
  | { kind: "invalid"; diffKey: string; candidate: ExhibitorImportCandidate };

export type ExhibitorImportJob = {
  id: string;
  exhibitionId: string;
  originalFileName: string;
  tempPath: string;
  workbookSignature: string;
  status: ExhibitorImportJobStatus;
  sourceScopes: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  failureMessage?: string;
  counts: {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
    missing: number;
    invalid: number;
  };
};

export type ExhibitorImportRow = {
  id: string;
  jobId: string;
  sheetName: string;
  rowNumber: number;
  candidate?: ExhibitorImportCandidate;
  diff?: ExhibitorImportDiff;
};

export type ExhibitorImportMappingTemplate = {
  id: string;
  name: string;
  workbookSignature?: string;
  sheetSignature: string;
  mappings: ImportFieldMapping[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type SheetMappingSelection = {
  sheetName: string;
  selected: boolean;
  headerRowIndex: number;
  sheetSignature: string;
  mappings: ImportFieldMapping[];
};

export type CreateImportJobInput = {
  exhibitionId: string;
  originalFileName: string;
  tempPath: string;
  workbookSignature: string;
  createdBy: string;
};

export type ImportDecisionInput = {
  diffKey: string;
  action: "create" | "update" | "keep" | "disable" | "skip";
  fields?: ImportFieldDecision[];
  acceptedBuilderPersonIds?: string[];
};

export type ImportApplyResult = {
  jobId: string;
  status: "completed";
  created: number;
  updated: number;
  disabled: number;
  skipped: number;
};

export type ExhibitorImportJobView = ExhibitorImportJob & {
  sheets: SheetMappingSelection[];
  diffs: ExhibitorImportDiff[];
  decisions: ImportDecisionInput[];
};
```

Implement deterministic helpers:

```ts
function halfWidth(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

export function normalizeBoothNumber(value: unknown) {
  return halfWidth(String(value ?? ""))
    .replace(/[\s\u00a0\u3000]+/g, "")
    .toUpperCase();
}

export function normalizeCompanyName(value: unknown) {
  return halfWidth(String(value ?? ""))
    .replace(/[\s\u00a0\u3000]+/g, "")
    .trim();
}

export function exhibitorIdentityKey(exhibitionId: string, booth: unknown, company: unknown) {
  return `${exhibitionId}|${normalizeBoothNumber(booth)}|${normalizeCompanyName(company)}`;
}
```

Extend `AppState` with:

```ts
exhibitions?: ExhibitionProject[];
exhibitors?: ExhibitorRecord[];
exhibitorAssignments?: ExhibitorBuilderAssignment[];
exhibitorTypes?: ExhibitorType[];
exhibitorImportJobs?: ExhibitorImportJob[];
exhibitorImportRows?: ExhibitorImportRow[];
exhibitorImportTemplates?: ExhibitorImportMappingTemplate[];
```

Keep legacy `booths` during migration so old JSON files and ticket tests still load. New code must read `exhibitors`; compatibility conversion is completed in Task 2.

- [ ] **Step 4: Normalize missing file-state collections**

Update file-store defaults/state normalization so every new collection becomes an empty array and seed the five initial types:

```ts
[
  { id: "normal-green", name: "普通绿搭", enabled: true, sortOrder: 10 },
  { id: "upgraded-green", name: "升级绿搭", enabled: true, sortOrder: 20 },
  { id: "standard", name: "普标", enabled: true, sortOrder: 30 },
  { id: "premium-standard", name: "精标", enabled: true, sortOrder: 40 },
  { id: "other", name: "其他/待确认", enabled: true, sortOrder: 50 }
]
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/domain/exhibitors.test.ts tests/services/file-store.test.ts
git add -- src/lib/domain/exhibitors.ts src/lib/domain/types.ts src/lib/domain/app-state.ts src/lib/storage/file-store.ts tests/domain/exhibitors.test.ts tests/services/file-store.test.ts
git commit -m "feat: add exhibitor project domain"
```

Expected: selected tests pass.

---

### Task 2: Add The Exhibitor And Import Database Schema

**Files:**
- Create: `db/migrations/004_exhibitor_data_dashboard.sql`
- Modify: `tests/db/migration-schema.test.ts`
- Modify: `scripts/db-import-state.mjs`
- Test: `tests/db/import-state.test.ts`

- [ ] **Step 1: Write failing schema assertions**

Add:

```ts
const exhibitorSchema = readFileSync(
  path.join(process.cwd(), "db", "migrations", "004_exhibitor_data_dashboard.sql"),
  "utf-8"
);

it("adds project exhibitor identity, assignments and import staging", () => {
  expect(exhibitorSchema).toContain("normalized_booth_number");
  expect(exhibitorSchema).toContain("normalized_company_name");
  expect(exhibitorSchema).toContain("uniq_exhibitor_per_project");
  expect(exhibitorSchema).toContain("CREATE TABLE IF NOT EXISTS exhibition_booth_builders");
  expect(exhibitorSchema).toContain("CREATE TABLE IF NOT EXISTS exhibitor_types");
  expect(exhibitorSchema).toContain("CREATE TABLE IF NOT EXISTS import_mapping_templates");
  expect(exhibitorSchema).toContain("candidate_payload");
});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/import-state.test.ts
```

Expected: FAIL because migration `004` does not exist.

- [ ] **Step 3: Create the migration**

The migration must:

```sql
ALTER TABLE exhibition_booths DROP INDEX uniq_booth_per_exhibition;

ALTER TABLE exhibition_booths
  ADD COLUMN normalized_booth_number varchar(64) NULL AFTER booth_number,
  ADD COLUMN normalized_company_name varchar(255) NULL AFTER company_name,
  ADD COLUMN location varchar(160) NULL AFTER company_short_name,
  ADD COLUMN area_square_meters decimal(10,2) NULL AFTER location,
  ADD COLUMN area_specification varchar(160) NULL AFTER area_square_meters,
  ADD COLUMN exhibitor_type varchar(120) NULL AFTER area_specification,
  ADD COLUMN updated_by varchar(64) NULL AFTER enabled,
  ADD COLUMN manually_edited_fields json NULL AFTER updated_by;

UPDATE exhibition_booths
SET normalized_booth_number = UPPER(REPLACE(TRIM(booth_number), ' ', '')),
    normalized_company_name = REPLACE(TRIM(company_name), ' ', '');

ALTER TABLE exhibition_booths
  MODIFY normalized_booth_number varchar(64) NOT NULL,
  MODIFY normalized_company_name varchar(255) NOT NULL,
  ADD UNIQUE KEY uniq_exhibitor_per_project (
    exhibition_id, normalized_booth_number, normalized_company_name
  ),
  ADD KEY idx_exhibitor_project_booth (exhibition_id, normalized_booth_number),
  ADD KEY idx_exhibitor_project_type (exhibition_id, exhibitor_type);

CREATE TABLE IF NOT EXISTS exhibition_booth_builders (
  exhibition_booth_id varchar(64) NOT NULL,
  person_id varchar(64) NOT NULL,
  assigned_by varchar(64) NOT NULL,
  assigned_at datetime(3) NOT NULL,
  PRIMARY KEY (exhibition_booth_id, person_id),
  KEY idx_exhibitor_builder_person (person_id, exhibition_booth_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS exhibitor_types (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_exhibitor_type_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_mapping_templates (
  id varchar(64) NOT NULL PRIMARY KEY,
  name varchar(160) NOT NULL,
  sheet_signature varchar(255) NOT NULL,
  mapping_json json NOT NULL,
  created_by varchar(64) NOT NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_import_mapping_signature (sheet_signature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

Extend `import_jobs` with project, upload, mapping and result metadata:

```sql
ALTER TABLE import_jobs
  ADD COLUMN exhibition_id varchar(64) NULL AFTER id,
  ADD COLUMN source_hash varchar(64) NULL AFTER source_name,
  ADD COLUMN temp_path varchar(500) NULL AFTER source_hash,
  ADD COLUMN operator_id varchar(64) NULL AFTER status,
  ADD COLUMN operator_name varchar(120) NULL AFTER operator_id,
  ADD COLUMN mapping_json json NULL AFTER operator_name,
  ADD COLUMN added_rows int NOT NULL DEFAULT 0 AFTER failed_rows,
  ADD COLUMN updated_rows int NOT NULL DEFAULT 0 AFTER added_rows,
  ADD COLUMN retained_rows int NOT NULL DEFAULT 0 AFTER updated_rows,
  ADD COLUMN missing_rows int NOT NULL DEFAULT 0 AFTER retained_rows,
  ADD COLUMN applied_at datetime(3) NULL AFTER completed_at,
  ADD KEY idx_import_jobs_exhibition (exhibition_id, created_at);

ALTER TABLE import_job_rows
  ADD COLUMN source_sheet varchar(160) NULL AFTER job_id,
  ADD COLUMN candidate_key varchar(500) NULL AFTER `row_number`,
  ADD COLUMN candidate_payload json NULL AFTER raw_payload,
  ADD COLUMN diff_payload json NULL AFTER candidate_payload,
  ADD COLUMN decision_payload json NULL AFTER diff_payload,
  ADD KEY idx_import_rows_candidate (job_id, candidate_key(191));
```

Seed the five exhibitor types with `INSERT IGNORE`.

Do not write new workbook columns into `builder` or `raw_payload`. Keep those legacy columns nullable for compatibility; cleanup can happen after production migration verification.

- [ ] **Step 4: Add legacy JSON import conversion**

Convert each legacy booth into the active/current project:

```ts
const exhibitionId = "current";
const exhibitor = {
  id: stableId("exhibitor", exhibitorIdentityKey(exhibitionId, booth.boothNumber, booth.companyName)),
  exhibitionId,
  boothNumber: normalizeBoothNumber(booth.boothNumber),
  normalizedBoothNumber: normalizeBoothNumber(booth.boothNumber),
  companyName: booth.companyName.trim(),
  normalizedCompanyName: normalizeCompanyName(booth.companyName),
  salesOwner: booth.salesOwner || undefined,
  enabled: true,
  createdAt: now,
  updatedAt: now
};
```

Legacy `builder` text is not converted into a user automatically. It remains available only in the legacy input during migration reporting.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/import-state.test.ts
git add -- db/migrations/004_exhibitor_data_dashboard.sql tests/db/migration-schema.test.ts scripts/db-import-state.mjs tests/db/import-state.test.ts
git commit -m "feat: add exhibitor dashboard schema"
```

---

### Task 3: Implement Project, Exhibitor, Type, And Assignment Repositories

**Files:**
- Create: `src/lib/repositories/exhibitor-repository.ts`
- Create: `src/lib/services/exhibitor-state-service.ts`
- Create: `src/lib/db/mariadb-exhibitor-store.ts`
- Test: `tests/repositories/exhibitor-file-repository.test.ts`
- Test: `tests/db/mariadb-exhibitor-store.test.ts`

- [ ] **Step 1: Write failing repository contract tests**

Cover:

```ts
it("activates one project and archives the previously active project", async () => {});
it("lists same-booth different-company exhibitors independently", async () => {});
it("updates only the seven business fields", async () => {});
it("replaces builder assignments without changing exhibitor fields", async () => {});
it("filters exhibitors by project, search, type and assignment state", async () => {});
it("keeps a builder assigned to multiple exhibitors", async () => {});
```

Use this contract:

```ts
export type ExhibitorQuery = {
  exhibitionId: string;
  search?: string;
  location?: string;
  exhibitorType?: string;
  assignment?: "assigned" | "unassigned";
  builderPersonId?: string;
  page: number;
  pageSize: number;
};

export type ExhibitorRepository = {
  listProjects(): Promise<ExhibitionProject[]>;
  createProject(input: Pick<ExhibitionProject, "name" | "startsAt" | "endsAt">, actorId: string): Promise<ExhibitionProject>;
  updateProject(id: string, patch: Partial<Pick<ExhibitionProject, "name" | "status" | "startsAt" | "endsAt">>, actorId: string): Promise<ExhibitionProject>;
  listExhibitors(query: ExhibitorQuery): Promise<{ items: ExhibitorListItem[]; total: number }>;
  getExhibitor(id: string): Promise<ExhibitorListItem | undefined>;
  updateExhibitor(id: string, patch: ExhibitorBusinessPatch, actorId: string): Promise<ExhibitorListItem>;
  replaceAssignments(exhibitorIds: string[], personIds: string[], actorId: string): Promise<void>;
  listTypes(): Promise<ExhibitorType[]>;
  saveType(input: ExhibitorTypeMutation, actorId: string): Promise<ExhibitorType>;
  listBuilderPeople(): Promise<Array<{ id: string; name: string; phone: string }>>;
};
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
npm.cmd run test:run -- tests/repositories/exhibitor-file-repository.test.ts tests/db/mariadb-exhibitor-store.test.ts
```

Expected: FAIL because repository implementations do not exist.

- [ ] **Step 3: Implement the JSON state service**

Use one `updateState` call per mutation. Activating a project must demote any other active project to `archived`. Assignment replacement must validate every `personId` belongs to an enabled builder group:

```ts
function isBuilderPerson(state: AppState, personId: string) {
  const person = state.people?.find((item) => item.id === personId && item.enabled);
  if (!person) return false;
  const group = userGroupsOf(state.config).find((item) => item.id === person.groupId);
  return Boolean(group && (group.id === "builder" || group.name.includes("搭建")));
}
```

Search against booth, company, sales owner, and assigned builder name. Sort by booth using `localeCompare("zh-CN", { numeric: true })`.

`updateExhibitor` adds every changed business field name to `manuallyEditedFields`/`manually_edited_fields`. Import-created or import-updated values do not add that marker. The diff service uses these markers to set `FieldDiff.manuallyEdited`, while still presenting every differing field for administrator choice.

- [ ] **Step 4: Implement MariaDB queries and transactions**

Keep SQL in `mariadb-exhibitor-store.ts`. The list query joins assignments and people but groups the result in TypeScript to avoid duplicated exhibitor rows. Mutations use `withDatabaseTransaction`.

Use parameterized SQL only. Example identity lookup:

```sql
SELECT *
FROM exhibition_booths
WHERE exhibition_id = ?
  AND normalized_booth_number = ?
  AND normalized_company_name = ?
LIMIT 1
```

Assignment replacement:

```ts
await execute(connection, `DELETE FROM exhibition_booth_builders WHERE exhibition_booth_id IN (${placeholders})`, exhibitorIds);
for (const exhibitorId of exhibitorIds) {
  for (const personId of personIds) {
    await execute(connection, `
      INSERT INTO exhibition_booth_builders (exhibition_booth_id, person_id, assigned_by, assigned_at)
      VALUES (?, ?, ?, ?)
    `, [exhibitorId, personId, actorId, now]);
  }
}
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/repositories/exhibitor-file-repository.test.ts tests/db/mariadb-exhibitor-store.test.ts
git add -- src/lib/repositories/exhibitor-repository.ts src/lib/services/exhibitor-state-service.ts src/lib/db/mariadb-exhibitor-store.ts tests/repositories/exhibitor-file-repository.test.ts tests/db/mariadb-exhibitor-store.test.ts
git commit -m "feat: add exhibitor repositories"
```

---

### Task 4: Stream Workbook Uploads And Inspect All Sheets

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/services/workbook-upload-service.ts`
- Create: `src/lib/services/workbook-inspection-service.ts`
- Create: `tests/fixtures/exhibitor-workbooks.ts`
- Test: `tests/services/workbook-upload-service.test.ts`
- Test: `tests/services/workbook-inspection-service.test.ts`

- [ ] **Step 1: Install the multipart parser**

```powershell
npm.cmd install busboy
npm.cmd install --save-dev @types/busboy
```

- [ ] **Step 2: Write failing upload and inspection tests**

Generate workbooks in memory in `tests/fixtures/exhibitor-workbooks.ts`; do not commit a binary fixture.

Tests must prove:

```ts
it("rejects uploads above 100 MiB before retaining a temp file", async () => {});
it("hashes and stores an accepted workbook under data/imports", async () => {});
it("finds every non-empty sheet and the likely header row", async () => {});
it("recognizes the title row above the real header row", async () => {});
it("returns only header and sample metadata, not image/media payloads", async () => {});
```

- [ ] **Step 3: Run tests and verify failure**

```powershell
npm.cmd run test:run -- tests/services/workbook-upload-service.test.ts tests/services/workbook-inspection-service.test.ts
```

- [ ] **Step 4: Implement bounded upload and inspection**

`saveMultipartWorkbook` must:

- require `multipart/form-data`;
- require `projectId`;
- accept one workbook;
- allow `.xlsx`, `.xls`, `.csv`;
- stop at `100 * 1024 * 1024` bytes;
- hash bytes with SHA-256 while streaming;
- generate the server filename instead of trusting the client path;
- clean partial files on error.

One import job owns one workbook for retry, cleanup, and audit clarity. The wizard may submit additional workbooks as additional jobs under the same project; Task 7 verifies that sequential jobs merge into the same exhibitor dashboard by normalized identity.

Core shape:

```ts
export type SavedWorkbook = {
  projectId: string;
  originalName: string;
  tempPath: string;
  sha256: string;
  byteLength: number;
};
```

`inspectWorkbook` reads with:

```ts
const workbook = XLSX.readFile(tempPath, {
  dense: true,
  cellDates: true,
  cellFormula: false,
  cellHTML: false,
  cellStyles: false
});
```

For each sheet, score the first 20 rows by non-empty cell count and known alias hits. Return:

```ts
type InspectedSheet = {
  name: string;
  rowCount: number;
  columnCount: number;
  headerRowIndex: number;
  headers: Array<{ columnIndex: number; label: string; samples: string[] }>;
};
```

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/workbook-upload-service.test.ts tests/services/workbook-inspection-service.test.ts
git add -- package.json package-lock.json src/lib/services/workbook-upload-service.ts src/lib/services/workbook-inspection-service.ts tests/fixtures/exhibitor-workbooks.ts tests/services/workbook-upload-service.test.ts tests/services/workbook-inspection-service.test.ts
git commit -m "feat: inspect uploaded exhibitor workbooks"
```

---

### Task 5: Add Rule-First And Smart-AI Field Mapping

**Files:**
- Create: `src/lib/services/exhibitor-field-mapping-service.ts`
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/domain/ai-config.ts`
- Modify: `src/lib/ai/types.ts`
- Modify: `src/lib/ai/router.ts`
- Modify: `src/lib/ai/provider.ts`
- Modify: `src/lib/ai/http-provider.ts`
- Modify: `src/lib/ai/mock-provider.ts`
- Modify: `src/components/admin-panel.tsx`
- Test: `tests/services/exhibitor-field-mapping-service.test.ts`
- Test: `tests/domain/ai-config.test.ts`
- Test: `tests/domain/http-ai-provider.test.ts`

- [ ] **Step 1: Write failing mapping tests**

```ts
it("maps known Chinese headers without calling AI", async () => {
  const result = await mapFields(sheet(), { ai: vi.fn() });
  expect(result.mappings).toContainEqual(expect.objectContaining({
    field: "boothNumber",
    sourceHeader: "展位号",
    source: "rule",
    confidence: 1
  }));
});

it("uses smart AI only for unmapped headers", async () => {});
it("marks AI confidence below 0.85 as requiring confirmation", async () => {});
it("falls back to manual mapping when smart AI throws", async () => {});
it("prefers a saved template over AI for the same sheet signature", async () => {});
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-field-mapping-service.test.ts tests/domain/ai-config.test.ts tests/domain/http-ai-provider.test.ts
```

- [ ] **Step 3: Add the AI scenario and provider contract**

Extend:

```ts
export type AiPromptScenario =
  | "classify"
  | "dedupe"
  | "escalation"
  | "customer-service"
  | "exhibitor-import";
```

Add:

```ts
export type ExhibitorFieldMappingContext = {
  sheetName: string;
  headers: Array<{ columnIndex: number; label: string; samples: string[] }>;
  unmappedFields: ImportSystemField[];
};

export type ExhibitorFieldMappingDecision = {
  mappings: Array<{
    field: ImportSystemField;
    columnIndex: number;
    confidence: number;
    reason: string;
  }>;
};
```

Add `mapExhibitorFields` to `AiProvider` and `createAiRouter`. The HTTP prompt must demand JSON and explicitly forbid inventing columns. The mock provider returns `{ mappings: [] }`, which gives the required rule/manual degradation instead of pretending a mapping exists.

Add a built-in configurable prompt for `exhibitor-import` to the AI settings UI.

- [ ] **Step 4: Implement the mapping merge**

Alias rules include:

```ts
const FIELD_ALIASES: Record<ImportSystemField, RegExp[]> = {
  boothNumber: [/^展位号$/, /^展台号$/, /^摊位号$/, /^booth/i],
  companyName: [/^(公司|企业|展商)名称$/, /^展商$/],
  floor: [/^楼层$/],
  hall: [/^(所属)?展馆$/, /^馆号$/],
  area: [/^面积$/, /^展位面积$/],
  areaSpecification: [/^规格$/, /^尺寸$/],
  exhibitorType: [/方案类型/, /展位类别/, /^类型$/],
  salesOwner: [/销售人员/, /^业务员$/, /^销售$/],
  builder: [/^搭建商$/, /搭建负责人/]
};
```

Merge order is `manual > template > rule > AI`. Reject mappings where two system fields claim one column unless the pair is the explicit `area`/`areaSpecification` manual choice.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-field-mapping-service.test.ts tests/domain/ai-config.test.ts tests/domain/http-ai-provider.test.ts tests/components/admin-panel.test.tsx
git add -- src/lib/services/exhibitor-field-mapping-service.ts src/lib/domain/types.ts src/lib/domain/ai-config.ts src/lib/ai/types.ts src/lib/ai/router.ts src/lib/ai/provider.ts src/lib/ai/http-provider.ts src/lib/ai/mock-provider.ts src/components/admin-panel.tsx tests/services/exhibitor-field-mapping-service.test.ts tests/domain/ai-config.test.ts tests/domain/http-ai-provider.test.ts tests/components/admin-panel.test.tsx
git commit -m "feat: add ai assisted exhibitor mapping"
```

---

### Task 6: Normalize Candidates, Match Builders, And Compute Field Diffs

**Files:**
- Create: `src/lib/services/exhibitor-normalization-service.ts`
- Create: `src/lib/services/exhibitor-import-diff-service.ts`
- Test: `tests/services/exhibitor-normalization-service.test.ts`
- Test: `tests/services/exhibitor-import-diff-service.test.ts`

- [ ] **Step 1: Write failing sample-workbook normalization tests**

Use rows equivalent to the real workbook:

```ts
it("normalizes green-build rows into the seven business fields", async () => {
  expect(candidate).toMatchObject({
    boothNumber: "1ET06",
    companyName: "汕头市昌隆机械科技有限公司",
    location: "一楼 / 1E",
    areaSquareMeters: 36,
    exhibitorType: "普通绿搭",
    salesOwner: "孙晓晓"
  });
});

it("normalizes fascia rows without requiring a builder", async () => {});
it("keeps two companies in 1AT27 as separate candidates", async () => {});
it("matches 李铁：13607664172 by phone before name", async () => {});
it("does not create a user when builder matching fails", async () => {});
it("merges exact duplicate candidate keys and records both sources", async () => {});
```

Diff tests:

```ts
it("reports new, changed, unchanged, invalid and source-missing candidates", () => {});
it("does not treat exhibitors from an unselected sheet as missing", () => {});
it("creates one decision per changed field", () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-normalization-service.test.ts tests/services/exhibitor-import-diff-service.test.ts
```

- [ ] **Step 3: Implement deterministic candidate creation**

Required fields are booth and company. Build the `ExhibitorImportCandidate` contract defined in Task 1, including source provenance, field confidence, builder matches, and validation errors.

Parse multiple builders by Chinese/English commas, semicolons, slashes, and line breaks. Extract Chinese mobile numbers independently from names. Match phone first, then unique normalized name among enabled builder-group people.

Type normalization is exact/alias first. Ambiguous values may use the smart AI in batches of at most 50; confidence below `0.85` is exposed for manual confirmation.

- [ ] **Step 4: Implement field-level diff decisions**

Return the `ExhibitorImportDiff` union defined in Task 1. Generate a stable `diffKey` for every result so saved decisions remain attached across preview refreshes.

Missing detection is limited to selected sheet/template scopes recorded on the prior import. It must not compare a fascia-only source against green-build exhibitors.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-normalization-service.test.ts tests/services/exhibitor-import-diff-service.test.ts
git add -- src/lib/services/exhibitor-normalization-service.ts src/lib/services/exhibitor-import-diff-service.ts tests/services/exhibitor-normalization-service.test.ts tests/services/exhibitor-import-diff-service.test.ts
git commit -m "feat: normalize and diff exhibitor imports"
```

---

### Task 7: Persist And Apply Staged Imports Transactionally

**Files:**
- Create: `src/lib/services/exhibitor-import-service.ts`
- Modify: `src/lib/repositories/exhibitor-repository.ts`
- Modify: `src/lib/services/exhibitor-state-service.ts`
- Modify: `src/lib/db/mariadb-exhibitor-store.ts`
- Test: `tests/services/exhibitor-import-service.test.ts`
- Test: `tests/db/mariadb-exhibitor-import.test.ts`

- [ ] **Step 1: Write failing orchestration and rollback tests**

```ts
it("moves uploaded -> mapping -> preview -> ready -> completed", async () => {});
it("requires manual mapping for booth and company before preview", async () => {});
it("applies accepted field choices and preserves builder assignments", async () => {});
it("adds matched builders only when the administrator accepts them", async () => {});
it("does not disable missing exhibitors without an explicit decision", async () => {});
it("merges sequential workbook jobs into one project by exhibitor identity", async () => {});
it("rolls back all exhibitor mutations when one apply statement fails", async () => {});
it("is idempotent when the completed apply endpoint is retried", async () => {});
it("deletes the temp workbook and staged rows after completion or cancellation", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-import-service.test.ts tests/db/mariadb-exhibitor-import.test.ts
```

- [ ] **Step 3: Add import repository operations**

Add:

```ts
createImportJob(input: CreateImportJobInput): Promise<ExhibitorImportJob>;
getImportJob(id: string): Promise<ExhibitorImportJob | undefined>;
saveImportMapping(id: string, sheets: SheetMappingSelection[], actorId: string): Promise<void>;
replaceImportRows(id: string, rows: ExhibitorImportRow[]): Promise<void>;
saveImportDecisions(id: string, decisions: ImportDecisionInput[], actorId: string): Promise<void>;
applyImport(id: string, actorId: string): Promise<ImportApplyResult>;
cancelImport(id: string, actorId: string): Promise<void>;
```

The MariaDB `applyImport` implementation executes in one `withDatabaseTransaction`. For each decision:

- insert new exhibitor;
- update only accepted incoming fields;
- preserve existing assignment rows;
- add explicitly accepted matched builders;
- disable a missing exhibitor only when decision is `disable`;
- update counts and mark completed.

The file implementation performs the same mutation inside one `updateState`.

- [ ] **Step 4: Implement orchestration and cleanup**

`ExhibitorImportService` owns status validation. Example:

```ts
function requireStatus(job: ExhibitorImportJob, allowed: ExhibitorImportJobStatus[]) {
  if (!allowed.includes(job.status)) {
    throw new Error(`导入任务状态 ${job.status} 不允许执行此操作`);
  }
}
```

After a successful apply or cancellation:

```ts
await removeWorkbookTempFile(job.tempPath);
await repository.clearImportRows(job.id);
```

On failure, mark the job `failed` with a safe message, but leave the temp file until the administrator retries or cancels.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/services/exhibitor-import-service.test.ts tests/db/mariadb-exhibitor-import.test.ts
git add -- src/lib/services/exhibitor-import-service.ts src/lib/repositories/exhibitor-repository.ts src/lib/services/exhibitor-state-service.ts src/lib/db/mariadb-exhibitor-store.ts tests/services/exhibitor-import-service.test.ts tests/db/mariadb-exhibitor-import.test.ts
git commit -m "feat: stage and apply exhibitor imports"
```

---

### Task 8: Expose Protected Project, Exhibitor, Assignment, Type, And Import APIs

**Files:**
- Create: `src/app/api/admin/exhibitions/route.ts`
- Create: `src/app/api/admin/exhibitions/[exhibitionId]/route.ts`
- Create: `src/app/api/admin/exhibitors/route.ts`
- Create: `src/app/api/admin/exhibitors/[exhibitorId]/route.ts`
- Create: `src/app/api/admin/exhibitors/assignments/route.ts`
- Create: `src/app/api/admin/exhibitor-types/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/[jobId]/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/[jobId]/mapping/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/[jobId]/decisions/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/[jobId]/apply/route.ts`
- Create: `src/app/api/admin/exhibitor-imports/[jobId]/cancel/route.ts`
- Test: `tests/api/admin-exhibitions-routes.test.ts`
- Test: `tests/api/admin-exhibitors-routes.test.ts`
- Test: `tests/api/admin-exhibitor-import-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Every route test must include:

```ts
it("rejects a missing admin session", async () => {
  auth.requireRequestActor.mockResolvedValue({
    ok: false,
    response: Response.json({ message: "Unauthorized" }, { status: 401 })
  });
  expect((await POST(request())).status).toBe(401);
});
```

Also cover:

- project create/activate;
- exhibitor pagination/filter/update;
- assignment replacement;
- type create/update;
- multipart upload;
- mapping save and preview generation;
- decision save;
- idempotent apply;
- cancel cleanup;
- job ownership/project validation.

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/api/admin-exhibitions-routes.test.ts tests/api/admin-exhibitors-routes.test.ts tests/api/admin-exhibitor-import-routes.test.ts
```

- [ ] **Step 3: Implement shared route schemas**

Use Zod schemas in a focused module:

```ts
const exhibitorPatchSchema = z.object({
  boothNumber: z.string().min(1).optional(),
  companyName: z.string().min(1).optional(),
  location: z.string().max(160).optional().nullable(),
  areaSquareMeters: z.number().nonnegative().optional().nullable(),
  areaSpecification: z.string().max(160).optional().nullable(),
  exhibitorType: z.string().max(120).optional().nullable(),
  salesOwner: z.string().max(120).optional().nullable(),
  enabled: z.boolean().optional()
}).strict();
```

No route accepts normalized identity fields, audit actor fields, free-text builder, or raw workbook rows.

- [ ] **Step 4: Implement handlers with server actors**

Every handler begins:

```ts
const auth = await requireRequestActor(request, "admin", "admin.access");
if (!auth.ok) return auth.response;
```

Use `auth.actor.accountId`/`personId` as operator identity. Upload returns `201` with job and inspected sheets. Mapping returns the generated preview; apply returns final counts.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/api/admin-exhibitions-routes.test.ts tests/api/admin-exhibitors-routes.test.ts tests/api/admin-exhibitor-import-routes.test.ts
git add -- src/app/api/admin/exhibitions src/app/api/admin/exhibitors src/app/api/admin/exhibitor-types src/app/api/admin/exhibitor-imports tests/api/admin-exhibitions-routes.test.ts tests/api/admin-exhibitors-routes.test.ts tests/api/admin-exhibitor-import-routes.test.ts
git commit -m "feat: add exhibitor management APIs"
```

---

### Task 9: Build The Multi-Step Import Wizard

**Files:**
- Create: `src/components/exhibitor-import-wizard.tsx`
- Create: `src/components/exhibitor-import-mapping-step.tsx`
- Create: `src/components/exhibitor-import-preview-step.tsx`
- Modify: `src/styles/globals.css`
- Test: `tests/components/exhibitor-import-wizard.test.tsx`

- [ ] **Step 1: Write failing wizard interaction tests**

```ts
it("requires a selected project before upload", async () => {});
it("shows every inspected sheet and allows selecting relevant sheets", async () => {});
it("shows rule, template, AI and manual mapping provenance", async () => {});
it("requires booth and company mappings", async () => {});
it("shows new, changed, missing, invalid and unmatched-builder groups", async () => {});
it("supports per-field and bulk incoming/existing choices", async () => {});
it("does not allow apply while required decisions are unresolved", async () => {});
it("announces upload and apply errors with role=alert", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/components/exhibitor-import-wizard.test.tsx
```

- [ ] **Step 3: Implement the explicit step state**

```ts
type ImportStep = "upload" | "mapping" | "preview" | "complete";

type WizardState = {
  step: ImportStep;
  job?: ExhibitorImportJobView;
  selectedSheets: string[];
  mappings: Record<string, ImportFieldMapping[]>;
  decisions: Record<string, ImportDecisionInput>;
};
```

The UI must display a step indicator and allow Back before apply. File upload uses `FormData`; do not parse the workbook in the browser.

- [ ] **Step 4: Implement accessible mapping and conflict controls**

- visible labels for every select;
- `aria-describedby` for AI confidence/reason;
- text labels in addition to status colors;
- sticky apply footer on desktop;
- no horizontal overflow on a 375px viewport;
- minimum 44px action targets;
- disable buttons during requests;
- `aria-live="polite"` for progress/status.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/components/exhibitor-import-wizard.test.tsx
git add -- src/components/exhibitor-import-wizard.tsx src/components/exhibitor-import-mapping-step.tsx src/components/exhibitor-import-preview-step.tsx src/styles/globals.css tests/components/exhibitor-import-wizard.test.tsx
git commit -m "feat: add exhibitor import wizard"
```

---

### Task 10: Build The Approved Admin Exhibitor Dashboard

**Files:**
- Create: `src/components/exhibition-data-panel.tsx`
- Create: `src/components/exhibition-project-selector.tsx`
- Create: `src/components/exhibitor-dashboard.tsx`
- Create: `src/components/exhibitor-detail-drawer.tsx`
- Create: `src/components/exhibitor-assignment-dialog.tsx`
- Create: `src/components/exhibitor-type-dialog.tsx`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/components/admin-shell.tsx`
- Modify: `src/styles/globals.css`
- Test: `tests/components/exhibition-data-panel.test.tsx`
- Test: `tests/components/exhibitor-dashboard.test.tsx`
- Test: `tests/components/admin-panel.test.tsx`
- Test: `tests/app/admin-routes.test.tsx`

- [ ] **Step 1: Write failing dashboard tests**

Cover the approved prototype:

```ts
it("switches projects and reloads project-scoped exhibitors", async () => {});
it("shows exhibitor, assigned, unassigned and import-difference metrics", async () => {});
it("searches booth, company, sales and builder", async () => {});
it("filters location, type and assignment state", async () => {});
it("shows same-booth companies on separate rows with a text notice", async () => {});
it("opens a detail drawer and edits only the seven business fields", async () => {});
it("allows an administrator to disable and re-enable an exhibitor", async () => {});
it("batch assigns multiple builder members", async () => {});
it("creates, renames, orders and disables exhibitor types", async () => {});
it("creates and activates a project", async () => {});
it("opens the import wizard from 上传项目表格", async () => {});
```

- [ ] **Step 2: Run and verify failure**

```powershell
npm.cmd run test:run -- tests/components/exhibition-data-panel.test.tsx tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-routes.test.tsx
```

- [ ] **Step 3: Delegate the exhibition-data view**

Replace the old upload placeholder:

```tsx
{view === "exhibition-data" ? (
  <ExhibitionDataPanel />
) : (
  <ExistingAdminConfigurationContent />
)}
```

Do not retain the client-side `XLSX.read` import or old `/api/admin/master-data` call in `admin-panel.tsx`.

- [ ] **Step 4: Implement the table, drawer and batch assignment**

The table columns are exactly:

- selection;
- booth;
- company;
- location;
- area;
- type;
- sales;
- builder members;
- action.

Desktop uses a semantic `<table>` with `aria-sort`; under 900px render cards with the same data. The drawer closes with Escape, restores focus to the trigger, and confirms unsaved dismissal. Builder member chips show name text in addition to avatars/tooltips.

`ExhibitorTypeDialog` is opened from the type filter/settings control. It lists enabled and disabled types and supports create, rename, sort-order change, and enable/disable through `/api/admin/exhibitor-types`. Existing exhibitor records keep their type ID when a type is renamed.

Use the existing green design tokens and Lucide icons. Preserve the prototype hierarchy; avoid decorative gradients in data cells.

- [ ] **Step 5: Run tests and commit**

```powershell
npm.cmd run test:run -- tests/components/exhibition-data-panel.test.tsx tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-routes.test.tsx
git add -- src/components/exhibition-data-panel.tsx src/components/exhibition-project-selector.tsx src/components/exhibitor-dashboard.tsx src/components/exhibitor-detail-drawer.tsx src/components/exhibitor-assignment-dialog.tsx src/components/exhibitor-type-dialog.tsx src/components/admin-panel.tsx src/components/admin-shell.tsx src/styles/globals.css tests/components/exhibition-data-panel.test.tsx tests/components/exhibitor-dashboard.test.tsx tests/components/admin-panel.test.tsx tests/app/admin-routes.test.tsx
git commit -m "feat: add exhibitor data dashboard"
```

---

### Task 11: Remove Legacy Import Paths And Verify The Foundation

**Files:**
- Delete: `src/app/api/admin/master-data/route.ts`
- Delete: `src/lib/domain/master-data.ts`
- Delete: `tests/domain/master-data.test.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `tests/repositories/app-repository.test.ts`
- Modify: `tests/db/mariadb-state-store.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add compatibility tests before removal**

Prove:

- admin bootstrap no longer needs full exhibitor rows;
- workbench receives only an active-project exhibitor count/summary;
- legacy JSON booths convert once and remain visible through the new repository;
- no new code reads or writes `builder` or `raw_payload`;
- completed imports contain counts and mapping metadata but no raw workbook cells.

- [ ] **Step 2: Run compatibility tests and verify current failure**

```powershell
npm.cmd run test:run -- tests/repositories/app-repository.test.ts tests/db/mariadb-state-store.test.ts tests/services/file-store.test.ts
```

- [ ] **Step 3: Remove the obsolete route/parser and shrink bootstrap**

Delete the old direct-import route and parser. Remove `importBooths` from `AppRepository`. Replace the workbench booth card payload with:

```ts
type ActiveExhibitionSummary = {
  exhibitionId?: string;
  exhibitionName?: string;
  exhibitorCount: number;
  assignedCount: number;
};
```

The dedicated exhibition-data APIs remain the only source for dashboard rows.

- [ ] **Step 4: Update operator documentation**

Document:

- create/select project;
- upload workbook;
- confirm mappings;
- resolve field differences;
- assign builders;
- AI degradation behavior;
- 100 MiB upload limit;
- temporary workbook cleanup;
- MariaDB migration command.

- [ ] **Step 5: Run full verification**

```powershell
npm.cmd run test:run
npm.cmd run build
git diff --check
```

Expected: all tests pass, production build exits `0`, and `git diff --check` has no output.

- [ ] **Step 6: Commit**

```powershell
git add -A -- src/app/api/admin/master-data src/lib/domain/master-data.ts tests/domain/master-data.test.ts src/lib/repositories/app-repository.ts src/lib/db/mariadb-state-store.ts tests/repositories/app-repository.test.ts tests/db/mariadb-state-store.test.ts README.md
git commit -m "refactor: retire legacy booth import"
```

---

## Foundation Acceptance Check

Before starting the linkage plan, verify:

1. Projects can be created, selected, activated, and archived.
2. The real 67.9 MB workbook uploads within the 100 MiB limit.
3. `普通绿色搭建汇总` and `标展楣牌` are both discovered.
4. About 272 sample exhibitors appear as candidates without merging same-booth companies.
5. Mapping provenance and AI confidence are visible.
6. Only accepted seven-field values enter the exhibitor table.
7. Builder text resolves to existing builder-group people; failures remain unassigned.
8. Re-import presents field differences and preserves assignments.
9. Missing rows are never disabled automatically.
10. The approved dashboard layout, drawer, filters, and bulk assignment work.
