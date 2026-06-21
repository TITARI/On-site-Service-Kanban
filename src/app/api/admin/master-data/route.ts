import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { parseMasterDataRows } from "@/lib/domain/master-data";
import type { ImportSystemField } from "@/lib/domain/types";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createConfiguredAiProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { ExhibitorFieldMappingContext } from "@/lib/ai/types";
import {
  extractMasterDataRowsFromWorkbookSheetsWithAi,
  inspectWorkbookSheetsWithAi,
  type ExhibitorWorkbookSheetInspection,
  type WorkbookSheetRows
} from "@/lib/services/exhibitor-workbook-parser-service";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_SHEETS = 10;
const MAX_ROWS_PER_SHEET = 20_000;
const MAX_CELL_LENGTH = 500;

class ImportPayloadError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = "ImportPayloadError";
  }
}

function requestBody(value: unknown) {
  return typeof value === "object" && value !== null
    ? value as { rows?: unknown; sheets?: unknown; dryRun?: unknown; inspect?: unknown; sheetNames?: unknown; selectedSheetNames?: unknown }
    : {};
}

const FIELD_LABELS: Record<ImportSystemField, string> = {
  boothNumber: "展位号",
  companyName: "展商",
  floor: "楼层",
  hall: "展馆",
  area: "面积",
  areaSpecification: "规格",
  exhibitorType: "类型",
  salesOwner: "销售",
  builder: "现场搭建成员"
};

function importPayloadError(message: string, status = 400): never {
  throw new ImportPayloadError(message, status);
}

function textLength(value: unknown) {
  if (value === undefined || value === null) return 0;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value)?.length ?? String(value).length;
    } catch {
      return String(value).length;
    }
  }
  return String(value).length;
}

function assertCellLength(value: unknown) {
  if (textLength(value) > MAX_CELL_LENGTH) {
    importPayloadError(`单元格内容过长，请控制在 ${MAX_CELL_LENGTH} 字以内。`);
  }
}

function assertRowCells(row: unknown[]) {
  for (const cell of row) assertCellLength(cell);
}

function assertJsonRow(row: unknown) {
  if (Array.isArray(row)) {
    assertRowCells(row);
    return;
  }
  if (typeof row === "object" && row !== null) {
    for (const [key, value] of Object.entries(row)) {
      assertCellLength(key);
      assertCellLength(value);
    }
    return;
  }
  assertCellLength(row);
}

function assertSheetRows(sheetName: string, rows: unknown[][]) {
  if (rows.length > MAX_ROWS_PER_SHEET) {
    importPayloadError(`单个工作表行数过多，请控制在 ${MAX_ROWS_PER_SHEET} 行以内。`);
  }
  assertCellLength(sheetName);
  for (const row of rows) assertRowCells(row);
}

function workbookSheets(value: unknown): WorkbookSheetRows[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SHEETS) {
    importPayloadError(`工作表数量过多，请控制在 ${MAX_SHEETS} 个以内。`);
  }
  const sheets: WorkbookSheetRows[] = [];
  for (const sheet of value) {
    if (typeof sheet !== "object" || sheet === null) continue;
    const candidate = sheet as { sheetName?: unknown; rows?: unknown };
    if (typeof candidate.sheetName !== "string" || !Array.isArray(candidate.rows)) continue;
    const rows = candidate.rows.filter(Array.isArray) as unknown[][];
    assertSheetRows(candidate.sheetName, rows);
    sheets.push({ sheetName: candidate.sheetName, rows });
  }
  return sheets;
}

function jsonRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_ROWS_PER_SHEET) {
    importPayloadError(`JSON 行数过多，请控制在 ${MAX_ROWS_PER_SHEET} 行以内。`);
  }
  for (const row of value) assertJsonRow(row);
  return value;
}

function isUploadedFile(value: FormDataEntryValue | null): value is File {
  return typeof value === "object"
    && value !== null
    && "arrayBuffer" in value
    && typeof value.arrayBuffer === "function"
    && "size" in value
    && typeof value.size === "number";
}

function stringArray(value: unknown): string[] | undefined {
  const checked = (items: string[]) => {
    if (items.length > MAX_SHEETS) {
      importPayloadError(`工作表数量过多，请控制在 ${MAX_SHEETS} 个以内。`);
    }
    for (const item of items) assertCellLength(item);
    return items;
  };
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return checked(value.map((item) => String(item).trim()).filter(Boolean));
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return checked(parsed.map((item) => String(item).trim()).filter(Boolean));
  } catch {
    return checked(trimmed.split(",").map((item) => item.trim()).filter(Boolean));
  }
  return undefined;
}

function formSheetNames(formData: FormData) {
  const explicit = stringArray(formData.get("sheetNames") ?? formData.get("selectedSheetNames"));
  if (explicit) return explicit;
  const repeated = formData.getAll("sheetName")
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return repeated.length > 0 ? repeated : undefined;
}

function worksheetCellValue(cell: unknown) {
  if (typeof cell !== "object" || cell === null) return cell;
  const record = cell as { v?: unknown; w?: unknown };
  if ("v" in record) return record.v;
  if ("w" in record) return record.w;
  return cell;
}

function assertWorksheetBounds(sheetName: string, worksheet: XLSX.WorkSheet | undefined) {
  assertCellLength(sheetName);
  if (!worksheet) return;
  const rangeRef = worksheet["!ref"];
  if (rangeRef) {
    const range = XLSX.utils.decode_range(rangeRef);
    const rowCount = range.e.r - range.s.r + 1;
    if (rowCount > MAX_ROWS_PER_SHEET) {
      importPayloadError(`单个工作表行数过多，请控制在 ${MAX_ROWS_PER_SHEET} 行以内。`);
    }
  }

  for (const key of Object.keys(worksheet)) {
    if (key.startsWith("!")) continue;
    assertCellLength(worksheetCellValue(worksheet[key]));
  }
}

async function sheetsFromUploadedWorkbook(file: File): Promise<WorkbookSheetRows[]> {
  if (file.size > MAX_FILE_SIZE) {
    importPayloadError("文件过大，请控制在 10MB 以内。", 413);
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  if (workbook.SheetNames.length > MAX_SHEETS) {
    importPayloadError(`工作表数量过多，请控制在 ${MAX_SHEETS} 个以内。`);
  }
  for (const sheetName of workbook.SheetNames) {
    assertWorksheetBounds(sheetName, workbook.Sheets[sheetName]);
  }
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[sheetName],
      { header: 1, defval: "", blankrows: false }
    ).filter(Array.isArray)
  }));
}

async function importPayload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!isUploadedFile(file) || file.size === 0) throw new Error("请选择要导入的工作簿");
    const sheets = await sheetsFromUploadedWorkbook(file);
    if (sheets.length === 0) throw new Error("表格为空");
    return {
      sheets,
      rows: [] as unknown[],
      dryRun: formData.get("dryRun") === "true",
      inspect: formData.get("inspect") === "true",
      selectedSheetNames: formSheetNames(formData)
    };
  }

  const body = await parseJson(request);
  const payload = requestBody(body);
  return {
    sheets: workbookSheets(payload.sheets),
    rows: jsonRows(payload.rows),
    dryRun: Boolean(payload.dryRun),
    inspect: Boolean(payload.inspect),
    selectedSheetNames: stringArray(payload.sheetNames ?? payload.selectedSheetNames)
  };
}

function mappingSamples(inspection: ExhibitorWorkbookSheetInspection, columnIndex: number) {
  return inspection.headers.find((header) => header.columnIndex === columnIndex)?.samples ?? [];
}

function inspectionPayload(inspections: ExhibitorWorkbookSheetInspection[], selectedSheetNames?: string[]) {
  const defaultSelectedSheets = inspections.filter((inspection) => inspection.importable).map((inspection) => inspection.sheetName);
  const selected = new Set(selectedSheetNames ?? defaultSelectedSheets);
  const rows = inspections
    .filter((inspection) => selected.has(inspection.sheetName))
    .flatMap((inspection) => inspection.importRows);
  const result = parseMasterDataRows(rows);
  return {
    ...result,
    sheets: inspections.map((inspection) => ({
      sheetName: inspection.sheetName,
      selected: selected.has(inspection.sheetName),
      rows: inspection.dataRowCount || inspection.rowCount,
      importable: inspection.importable,
      aiError: inspection.aiError,
      skippedReason: inspection.skippedReason
    })),
    mappings: inspections.flatMap((inspection) => inspection.mappings.map((mapping) => ({
      sheetName: inspection.sheetName,
      field: mapping.field,
      fieldLabel: FIELD_LABELS[mapping.field],
      sourceColumn: mapping.sourceHeader || "未识别",
      source: mapping.source,
      confidence: mapping.confidence,
      reason: mapping.reason,
      requiresConfirmation: mapping.requiresConfirmation,
      samples: mappingSamples(inspection, mapping.columnIndex)
    })))
  };
}

function aiMapper(repository: ReturnType<typeof getAppRepository>) {
  return async (context: ExhibitorFieldMappingContext) => {
    const config = await repository.getConfig();
    const router = createAiRouter({
      models: config.aiModels,
      provider: createConfiguredAiProvider(),
      promptConfig: config
    });
    return router.mapExhibitorFields(context);
  };
}

export async function POST(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  let payload: Awaited<ReturnType<typeof importPayload>>;
  try {
    payload = await importPayload(request);
  } catch (error) {
    if (error instanceof ImportPayloadError) {
      return NextResponse.json({ message: error.message }, { status: error.status });
    }
    return badRequest(errorMessage(error));
  }
  const { sheets } = payload;
  const repository = getAppRepository();
  const ai = aiMapper(repository);
  if (payload.inspect) {
    const inspections = await inspectWorkbookSheetsWithAi(sheets, {
      ai,
      inspectAllSheets: true
    });
    return NextResponse.json(inspectionPayload(inspections, payload.selectedSheetNames));
  }
  const rows = sheets.length > 0
    ? await extractMasterDataRowsFromWorkbookSheetsWithAi(sheets, {
        ai,
        selectedSheetNames: payload.selectedSheetNames
      })
    : payload.rows;
  const dryRun = payload.dryRun;
  const result = parseMasterDataRows(rows);
  if (result.errors.length > 0) return NextResponse.json(result, { status: 400 });
  if (dryRun) return NextResponse.json(result);

  const booths = await repository.importBooths(result.records);
  return NextResponse.json({ ...result, booths });
}
