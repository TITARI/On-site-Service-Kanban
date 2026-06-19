import type { ImportSystemField } from "../domain/types";
import type { ExhibitorFieldMappingContext, ExhibitorFieldMappingDecision } from "../ai/types";

export type InspectedSheetHeader = {
  columnIndex: number;
  label: string;
  samples: string[];
};

export type InspectedSheetForMapping = {
  sheetName: string;
  headers: InspectedSheetHeader[];
};

export type FieldMappingSource = "rule" | "ai" | "manual";

export type ExhibitorFieldMapping = {
  field: ImportSystemField;
  columnIndex: number;
  sourceHeader: string;
  source: FieldMappingSource;
  confidence: number;
  reason: string;
  requiresConfirmation: boolean;
};

export type MapExhibitorFieldsOptions = {
  ai?: (context: ExhibitorFieldMappingContext) => Promise<ExhibitorFieldMappingDecision>;
};

const IMPORT_FIELDS: ImportSystemField[] = [
  "boothNumber",
  "companyName",
  "floor",
  "hall",
  "area",
  "areaSpecification",
  "exhibitorType",
  "salesOwner",
  "builder"
];

const FIELD_ALIASES: Record<ImportSystemField, RegExp[]> = {
  boothNumber: [/^展位号$/, /^展位$/, /^展台号$/, /^摊位号$/, /^booth/i],
  companyName: [/^(企业|公司|展商)名称$/, /^公司全称$/, /^展商$/],
  floor: [/^楼层$/],
  hall: [/^(所属)?展馆$/, /^馆号$/],
  area: [/^面积$/, /^展位面积$/],
  areaSpecification: [/^规格$/, /^尺寸$/],
  exhibitorType: [/方案类型/, /展位类别/, /^类型$/],
  salesOwner: [/销售人员/, /^业务员$/, /^销售$/],
  builder: [/^搭建商$/, /搭建公司/, /搭建组/, /搭建负责人/]
};

function compact(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function headerMatches(field: ImportSystemField, label: string) {
  const normalized = compact(label);
  return FIELD_ALIASES[field].some((alias) => alias.test(normalized));
}

function mappingForHeader(field: ImportSystemField, header: InspectedSheetHeader): ExhibitorFieldMapping {
  return {
    field,
    columnIndex: header.columnIndex,
    sourceHeader: header.label,
    source: "rule",
    confidence: 1,
    reason: "表头命中系统内置规则",
    requiresConfirmation: false
  };
}

function numericTextSamples(samples: string[]) {
  return samples.filter((sample) => /^\d+(?:\.\d+)?$/.test(sample.replace(/\s+/g, "")));
}

function isLikelyAreaHeader(header: InspectedSheetHeader) {
  const normalized = compact(header.label);
  if (/^面积$/.test(normalized) || /^展位面积$/.test(normalized)) return true;
  if (/^展位号$/.test(normalized)) return numericTextSamples(header.samples).length >= Math.min(3, Math.max(1, header.samples.length));
  return false;
}

function manualMapping(field: ImportSystemField): ExhibitorFieldMapping {
  return {
    field,
    columnIndex: -1,
    sourceHeader: "",
    source: "manual",
    confidence: 0,
    reason: "规则和高阶智能模型未能可靠识别，需要管理员手动映射",
    requiresConfirmation: true
  };
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function appendMapping(current: Map<ImportSystemField, ExhibitorFieldMapping>, mapping: ExhibitorFieldMapping) {
  if ([...current.values()].some((item) => item.columnIndex === mapping.columnIndex && mapping.columnIndex >= 0)) return;
  current.set(mapping.field, mapping);
}

export async function mapExhibitorFields(sheet: InspectedSheetForMapping, options: MapExhibitorFieldsOptions = {}) {
  const byField = new Map<ImportSystemField, ExhibitorFieldMapping>();

  for (const field of IMPORT_FIELDS) {
    const header = sheet.headers.find((item) => headerMatches(field, item.label));
    if (header) appendMapping(byField, mappingForHeader(field, header));
  }

  if (!byField.has("area")) {
    const areaHeader = sheet.headers.find((header) => isLikelyAreaHeader(header) && header.columnIndex !== byField.get("boothNumber")?.columnIndex);
    if (areaHeader) {
      appendMapping(byField, {
        field: "area",
        columnIndex: areaHeader.columnIndex,
        sourceHeader: areaHeader.label,
        source: "rule",
        confidence: 1,
        reason: areaHeader.label === "展位号"
          ? "重复展位号列的样例为面积数字"
          : "表头和样例共同指向面积列",
        requiresConfirmation: false
      });
    }
  }

  const unmappedFields = IMPORT_FIELDS.filter((field) => !byField.has(field));
  const aiRequiredFields = unmappedFields.filter((field) => field !== "areaSpecification");
  let aiError: string | undefined;
  if (options.ai && aiRequiredFields.length > 0) {
    try {
      const decision = await options.ai({
        sheetName: sheet.sheetName,
        headers: sheet.headers,
        unmappedFields: aiRequiredFields
      });
      for (const suggestion of decision.mappings) {
        if (!unmappedFields.includes(suggestion.field)) continue;
        const header = sheet.headers.find((item) => item.columnIndex === suggestion.columnIndex);
        if (!header) continue;
        const confidence = clampConfidence(suggestion.confidence);
        appendMapping(byField, {
          field: suggestion.field,
          columnIndex: header.columnIndex,
          sourceHeader: header.label,
          source: "ai",
          confidence,
          reason: suggestion.reason,
          requiresConfirmation: confidence < 0.85
        });
      }
    } catch (error) {
      aiError = error instanceof Error ? error.message : "高阶智能模型映射失败";
    }
  }

  for (const field of IMPORT_FIELDS) {
    if (!byField.has(field) && ["boothNumber", "companyName"].includes(field)) byField.set(field, manualMapping(field));
  }

  return {
    mappings: [...byField.values()],
    aiError
  };
}
