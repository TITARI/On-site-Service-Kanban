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

function workbookSheets(value: unknown): WorkbookSheetRows[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sheet) => {
    if (typeof sheet !== "object" || sheet === null) return [];
    const candidate = sheet as { sheetName?: unknown; rows?: unknown };
    if (typeof candidate.sheetName !== "string" || !Array.isArray(candidate.rows)) return [];
    const rows = candidate.rows.filter(Array.isArray) as unknown[][];
    return [{ sheetName: candidate.sheetName, rows }];
  });
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
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
  } catch {
    return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
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

async function sheetsFromUploadedWorkbook(file: File): Promise<WorkbookSheetRows[]> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
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
    rows: Array.isArray(payload.rows) ? payload.rows : [],
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
