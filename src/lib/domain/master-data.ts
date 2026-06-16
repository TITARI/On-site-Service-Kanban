import type { BoothRecord } from "./types";

type RawRow = Record<string, unknown>;
type WorkbookSheetRows = {
  sheetName: string;
  rows: unknown[][];
};

export type MasterDataImportResult = {
  records: BoothRecord[];
  errors: Array<{ row: number; message: string }>;
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

function uniqueJoined(values: string[]) {
  return [...new Set(values.map(text).filter(Boolean))].join(" / ");
}

const TARGET_SHEET_NAMES = [
  "普通绿色搭建汇总",
  "标展楣牌"
];

const HEADER_ALIASES = {
  boothNumber: ["展位号", "展位", "boothNumber"],
  companyName: ["企业名称", "公司名称", "展商名称", "companyName"],
  salesOwner: ["销售人员", "业务员", "销售", "salesOwner"],
  builder: ["搭建商", "搭建公司", "搭建组", "builder"],
  floor: ["楼层"],
  hall: ["展馆", "所属展馆"],
  area: ["面积"],
  boothType: ["方案类型", "展位类别", "展位类别（普标）", "类型"]
} as const;

function shouldExtractSheet(sheetName: string) {
  return TARGET_SHEET_NAMES.some((target) => sheetName.includes(target));
}

function headerScore(row: unknown[]) {
  const headers = row.map(compactText);
  const hasBooth = headers.some((header) => HEADER_ALIASES.boothNumber.some((alias) => header.includes(alias)));
  const hasCompany = headers.some((header) => HEADER_ALIASES.companyName.some((alias) => header.includes(alias)));
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
  return bestScore >= 2 ? bestIndex : -1;
}

function columnFor(headers: unknown[], aliases: readonly string[]) {
  const normalized = headers.map(compactText);
  for (const alias of aliases) {
    const exactIndex = normalized.findIndex((header) => header === alias);
    if (exactIndex >= 0) return exactIndex;
  }
  for (const alias of aliases) {
    const includesIndex = normalized.findIndex((header) => header.includes(alias));
    if (includesIndex >= 0) return includesIndex;
  }
  return -1;
}

function duplicateColumnFor(headers: unknown[], label: string, occurrence: number) {
  const normalized = headers.map(compactText);
  let found = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== label) continue;
    found += 1;
    if (found === occurrence) return index;
  }
  return -1;
}

function cell(row: unknown[], index: number) {
  return index >= 0 ? text(row[index]) : "";
}

export function extractMasterDataRowsFromWorkbookSheets(
  sheets: WorkbookSheetRows[]
): RawRow[] {
  const rows: RawRow[] = [];
  for (const sheet of sheets) {
    if (!shouldExtractSheet(sheet.sheetName)) continue;
    const headerIndex = headerIndexOf(sheet.rows);
    if (headerIndex < 0) continue;
    const headers = sheet.rows[headerIndex];
    const columns = {
      boothNumber: columnFor(headers, HEADER_ALIASES.boothNumber),
      companyName: columnFor(headers, HEADER_ALIASES.companyName),
      salesOwner: columnFor(headers, HEADER_ALIASES.salesOwner),
      builder: columnFor(headers, HEADER_ALIASES.builder),
      floor: columnFor(headers, HEADER_ALIASES.floor),
      hall: columnFor(headers, HEADER_ALIASES.hall),
      area: columnFor(headers, HEADER_ALIASES.area),
      boothType: columnFor(headers, HEADER_ALIASES.boothType)
    };
    if (columns.area < 0) {
      columns.area = duplicateColumnFor(headers, "展位号", 2);
    }
    if (columns.boothNumber < 0 || columns.companyName < 0) continue;

    for (const sheetRow of sheet.rows.slice(headerIndex + 1)) {
      if (!hasAnyText(sheetRow)) continue;
      const boothNumber = cell(sheetRow, columns.boothNumber);
      const companyName = cell(sheetRow, columns.companyName);
      if (!boothNumber && !companyName) continue;
      if (!boothNumber || !companyName) continue;
      const location = [
        cell(sheetRow, columns.floor),
        cell(sheetRow, columns.hall)
      ].filter(Boolean).join(" ");
      rows.push({
        展位号: boothNumber,
        公司名称: companyName,
        业务员: cell(sheetRow, columns.salesOwner),
        搭建商: cell(sheetRow, columns.builder),
        位置: location,
        面积: cell(sheetRow, columns.area),
        类型: cell(sheetRow, columns.boothType)
      });
    }
  }
  return rows;
}

export function parseMasterDataRows(rows: RawRow[]): MasterDataImportResult {
  const errors: Array<{ row: number; message: string }> = [];
  const rowsByBooth = new Map<string, Array<BoothRecord & { rowNumber: number }>>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const boothNumber = text(row["展位号"] ?? row["boothNumber"]);
    const companyName = text(row["公司名称"] ?? row["企业名称"] ?? row["展商名称"] ?? row["companyName"]);
    const salesOwner = text(row["业务员"] ?? row["销售人员"] ?? row["销售"] ?? row["salesOwner"]);
    const builder = text(row["搭建商"] ?? row["搭建公司"] ?? row["builder"]);
    const companyShortName = text(row["公司简称"] ?? row["companyShortName"] ?? companyName);
    const location = text(row["位置"] ?? row["location"]);
    const area = text(row["面积"] ?? row["area"]);
    const boothType = text(row["类型"] ?? row["方案类型"] ?? row["展位类别"] ?? row["boothType"]);

    if (!boothNumber) errors.push({ row: rowNumber, message: "展位号不能为空" });
    if (!companyName) errors.push({ row: rowNumber, message: "公司名称不能为空" });

    if (boothNumber && companyName) {
      const boothRows = rowsByBooth.get(boothNumber) ?? [];
      boothRows.push({
        boothNumber,
        companyName,
        companyShortName,
        salesOwner,
        builder,
        location,
        area,
        boothType,
        rowNumber
      });
      rowsByBooth.set(boothNumber, boothRows);
    }
  });

  const records = [...rowsByBooth.values()].map((boothRows) => ({
    boothNumber: boothRows[0].boothNumber,
    companyName: uniqueJoined(boothRows.map((row) => row.companyName)),
    companyShortName: uniqueJoined(boothRows.map((row) => row.companyShortName || row.companyName)),
    salesOwner: uniqueJoined(boothRows.map((row) => row.salesOwner)),
    builder: uniqueJoined(boothRows.map((row) => row.builder)),
    location: uniqueJoined(boothRows.map((row) => row.location ?? "")),
    area: uniqueJoined(boothRows.map((row) => row.area ?? "")),
    boothType: uniqueJoined(boothRows.map((row) => row.boothType ?? ""))
  })).map((record) => {
    const next: BoothRecord = {
      boothNumber: record.boothNumber,
      companyName: record.companyName,
      companyShortName: record.companyShortName,
      salesOwner: record.salesOwner,
      builder: record.builder
    };
    if (record.location) next.location = record.location;
    if (record.area) next.area = record.area;
    if (record.boothType) next.boothType = record.boothType;
    return next;
  }).sort((a, b) => a.boothNumber.localeCompare(b.boothNumber, "zh-CN", { numeric: true }));

  return { records, errors };
}

export function upsertBoothRecords(existing: BoothRecord[], incoming: BoothRecord[]) {
  const byBooth = new Map(existing.map((record) => [record.boothNumber, record]));
  incoming.forEach((record) => byBooth.set(record.boothNumber, record));
  return Array.from(byBooth.values()).sort((a, b) => a.boothNumber.localeCompare(b.boothNumber, "zh-CN", { numeric: true }));
}
