import type { BoothRecord } from "./types";

type RawRow = Record<string, unknown>;

export type MasterDataImportResult = {
  records: BoothRecord[];
  errors: Array<{ row: number; message: string }>;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

export function parseMasterDataRows(rows: RawRow[]): MasterDataImportResult {
  const records: BoothRecord[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const seenBooths = new Set<string>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const boothNumber = text(row["展位号"] ?? row["boothNumber"]);
    const companyName = text(row["公司名称"] ?? row["companyName"]);
    const salesOwner = text(row["业务员"] ?? row["salesOwner"]);
    const builder = text(row["搭建商"] ?? row["builder"]);
    const companyShortName = text(row["公司简称"] ?? row["companyShortName"] ?? companyName);
    const isDuplicateBooth = boothNumber ? seenBooths.has(boothNumber) : false;

    if (!boothNumber) errors.push({ row: rowNumber, message: "展位号不能为空" });
    if (isDuplicateBooth) errors.push({ row: rowNumber, message: `展位号 ${boothNumber} 重复` });
    if (!companyName) errors.push({ row: rowNumber, message: "公司名称不能为空" });
    if (!salesOwner) errors.push({ row: rowNumber, message: "业务员不能为空" });
    if (!builder) errors.push({ row: rowNumber, message: "搭建商不能为空" });

    if (boothNumber) seenBooths.add(boothNumber);

    if (boothNumber && !isDuplicateBooth && companyName && salesOwner && builder) {
      records.push({ boothNumber, companyName, companyShortName, salesOwner, builder });
    }
  });

  return { records, errors };
}

export function upsertBoothRecords(existing: BoothRecord[], incoming: BoothRecord[]) {
  const byBooth = new Map(existing.map((record) => [record.boothNumber, record]));
  incoming.forEach((record) => byBooth.set(record.boothNumber, record));
  return Array.from(byBooth.values()).sort((a, b) => a.boothNumber.localeCompare(b.boothNumber, "zh-CN", { numeric: true }));
}
