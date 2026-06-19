import type { ExhibitorFieldMappingDecision } from "../ai/types";
import type { ImportSystemField } from "../domain/types";
import {
  mapExhibitorFields,
  type ExhibitorFieldMapping,
  type InspectedSheetHeader,
  type MapExhibitorFieldsOptions
} from "./exhibitor-field-mapping-service";

type RawRow = Record<string, unknown>;
type WorkbookSheetRows = {
  sheetName: string;
  rows: unknown[][];
};

type ParserOptions = {
  ai?: MapExhibitorFieldsOptions["ai"];
  selectedSheetNames?: string[];
  inspectAllSheets?: boolean;
};

type ExhibitorWorkbookSheetInspection = {
  sheetName: string;
  rowCount: number;
  dataRowCount: number;
  importable: boolean;
  headers: InspectedSheetHeader[];
  mappings: ExhibitorFieldMapping[];
  importRows: RawRow[];
  aiError?: string;
  skippedReason?: string;
};

const TARGET_SHEET_NAMES = [
  "普通绿色搭建汇总",
  "标展楣牌",
  "标摊楣牌"
];

const SYSTEM_KEYS: Partial<Record<ImportSystemField, keyof RawRow>> = {
  boothNumber: "boothNumber",
  companyName: "companyName",
  salesOwner: "salesOwner",
  builder: "builder",
  area: "area",
  exhibitorType: "boothType"
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function compactText(value: unknown) {
  return text(value).replace(/\s+/g, "");
}

function hasAnyText(row: unknown[]) {
  return row.some((cell) => text(cell));
}

function shouldExtractSheet(sheetName: string) {
  return TARGET_SHEET_NAMES.some((target) => sheetName.includes(target));
}

function headerScore(row: unknown[]) {
  const headers = row.map(compactText);
  const hasBooth = headers.some((header) => ["展位号", "展位", "boothNumber"].some((alias) => header.includes(alias)));
  const hasCompany = headers.some((header) => ["企业名称", "公司名称", "展商名称", "companyName"].some((alias) => header.includes(alias)));
  return Number(hasBooth) + Number(hasCompany);
}

function headerIndexOf(rows: unknown[][]) {
  let bestIndex = -1;
  let bestScore = 0;
  rows.slice(0, 12).forEach((row, index) => {
    const score = headerScore(row);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  if (bestScore >= 2) return bestIndex;
  return rows.findIndex((row) => row.filter((cell) => text(cell)).length >= 2);
}

function sampleValues(rows: unknown[][], columnIndex: number) {
  return rows
    .map((row) => text(row[columnIndex]))
    .filter(Boolean)
    .slice(0, 5);
}

function selectedSheetSet(sheetNames?: string[]) {
  if (!sheetNames) return undefined;
  return new Set(sheetNames.map(text).filter(Boolean));
}

function headersForMapping(headers: unknown[], dataRows: unknown[][]) {
  return headers.map((label, columnIndex) => ({
    columnIndex,
    label: text(label),
    samples: sampleValues(dataRows, columnIndex)
  })).filter((header) => header.label);
}

function inferredHeadersForMapping(dataRows: unknown[][]) {
  const width = Math.max(0, ...dataRows.map((row) => row.length));
  return Array.from({ length: width }, (_, columnIndex) => ({
    columnIndex,
    label: `第${columnIndex + 1}列`,
    samples: sampleValues(dataRows, columnIndex)
  })).filter((header) => header.samples.length > 0);
}

function looksLikeBoothNumber(value: unknown) {
  return /^[A-Z0-9]{1,4}[A-Z]{0,2}T?\d{2,4}$/i.test(compactText(value));
}

function looksLikeContinuationSheet(rows: unknown[][]) {
  const dataRows = rows.filter(hasAnyText);
  if (dataRows.length < 2) return false;
  const inspected = dataRows.slice(0, 8);
  const boothLikeRows = inspected.filter((row) => row.some(looksLikeBoothNumber)).length;
  const companyLikeRows = inspected.filter((row) => {
    const firstText = text(row[0]);
    return firstText.length >= 4 && /公司|厂|集团|合作社|中心|门市|商贸|农业|科技|农化|生物|化工|肥业/.test(firstText);
  }).length;
  return boothLikeRows >= 2 && companyLikeRows >= 2;
}

function mappingByField(mappings: ExhibitorFieldMapping[]) {
  return new Map(mappings.map((mapping) => [mapping.field, mapping]));
}

function cell(row: unknown[], mapping?: ExhibitorFieldMapping) {
  return mapping ? text(row[mapping.columnIndex]) : "";
}

function pushMappedRow(rows: RawRow[], sheetRow: unknown[], mappings: Map<ImportSystemField, ExhibitorFieldMapping>) {
  const boothNumber = cell(sheetRow, mappings.get("boothNumber"));
  const companyName = cell(sheetRow, mappings.get("companyName"));
  if (!boothNumber || !companyName) return;
  const location = [
    cell(sheetRow, mappings.get("floor")),
    cell(sheetRow, mappings.get("hall"))
  ].filter(Boolean).join(" ");
  const row: RawRow = {};
  for (const [field, key] of Object.entries(SYSTEM_KEYS) as Array<[ImportSystemField, keyof RawRow]>) {
    const value = cell(sheetRow, mappings.get(field));
    if (value) row[key] = value;
  }
  if (location) row.location = location;
  rows.push(row);
}

async function inspectWorkbookSheet(
  sheet: WorkbookSheetRows,
  options: ParserOptions,
  selectedSheets: Set<string> | undefined
): Promise<ExhibitorWorkbookSheetInspection> {
  const rowCount = sheet.rows.filter(hasAnyText).length;
  const isTargetSheet = shouldExtractSheet(sheet.sheetName);
  const isContinuationSheet = !isTargetSheet && looksLikeContinuationSheet(sheet.rows);
  const hasExplicitSelection = selectedSheets !== undefined;
  const isSelected = selectedSheets?.has(sheet.sheetName) ?? false;
  const shouldInspect = options.inspectAllSheets
    || isSelected
    || (!hasExplicitSelection && (isTargetSheet || isContinuationSheet));

  if (!shouldInspect) {
    return {
      sheetName: sheet.sheetName,
      rowCount,
      dataRowCount: 0,
      importable: false,
      headers: [],
      mappings: [],
      importRows: [],
      skippedReason: "工作表未选择或不在系统默认读取范围内"
    };
  }

  const headerIndex = isContinuationSheet ? -1 : headerIndexOf(sheet.rows);
  if (headerIndex < 0 && !isContinuationSheet) {
    return {
      sheetName: sheet.sheetName,
      rowCount,
      dataRowCount: 0,
      importable: false,
      headers: [],
      mappings: [],
      importRows: [],
      skippedReason: "未找到可识别的表头"
    };
  }

  const dataRows = (headerIndex >= 0 ? sheet.rows.slice(headerIndex + 1) : sheet.rows).filter(hasAnyText);
  const headers = headerIndex >= 0 ? headersForMapping(sheet.rows[headerIndex], dataRows) : inferredHeadersForMapping(dataRows);
  if (headers.length === 0 || dataRows.length === 0) {
    return {
      sheetName: sheet.sheetName,
      rowCount,
      dataRowCount: dataRows.length,
      importable: false,
      headers,
      mappings: [],
      importRows: [],
      skippedReason: "未找到候选数据行"
    };
  }

  const result = await mapExhibitorFields({
    sheetName: sheet.sheetName,
    headers
  }, { ai: options.ai });
  const mappedFields = mappingByField(result.mappings.filter((mapping) => mapping.columnIndex >= 0));
  const hasRequiredFields = mappedFields.has("boothNumber") && mappedFields.has("companyName");
  const importRows: RawRow[] = [];
  if (hasRequiredFields) {
    for (const sheetRow of dataRows) pushMappedRow(importRows, sheetRow, mappedFields);
  }

  return {
    sheetName: sheet.sheetName,
    rowCount,
    dataRowCount: dataRows.length,
    importable: importRows.length > 0,
    headers,
    mappings: result.mappings,
    importRows,
    aiError: result.aiError,
    skippedReason: hasRequiredFields
      ? (importRows.length > 0 ? undefined : "未找到可导入的展商行")
      : "未识别展位号和展商列"
  };
}

export async function inspectWorkbookSheetsWithAi(
  sheets: WorkbookSheetRows[],
  options: ParserOptions = {}
): Promise<ExhibitorWorkbookSheetInspection[]> {
  const selectedSheets = selectedSheetSet(options.selectedSheetNames);
  const inspections: ExhibitorWorkbookSheetInspection[] = [];
  for (const sheet of sheets) {
    inspections.push(await inspectWorkbookSheet(sheet, options, selectedSheets));
  }
  return inspections;
}

export async function extractMasterDataRowsFromWorkbookSheetsWithAi(
  sheets: WorkbookSheetRows[],
  options: ParserOptions = {}
): Promise<RawRow[]> {
  const inspections = await inspectWorkbookSheetsWithAi(sheets, options);
  return inspections.flatMap((inspection) => inspection.importRows);
}

export type { ExhibitorFieldMappingDecision, ExhibitorWorkbookSheetInspection, WorkbookSheetRows };
