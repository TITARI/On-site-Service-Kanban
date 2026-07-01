import { describe, expect, it, vi } from "vitest";
import type { ExhibitorFieldMappingContext, ExhibitorFieldMappingDecision } from "@/lib/ai/types";
import { mapExhibitorFields } from "@/lib/services/exhibitor-field-mapping-service";

function sheet(headers: string[] = ["展位号", "企业名称", "楼层", "展馆", "面积", "方案类型", "销售人员", "搭建商"]) {
  return {
    sheetName: "普通绿色搭建汇总",
    headers: headers.map((label, columnIndex) => ({
      columnIndex,
      label,
      samples: [`${label}-样例`]
    }))
  };
}

describe("exhibitor field mapping service", () => {
  it("maps known Chinese headers without calling AI", async () => {
    const ai = vi.fn<(
      context: ExhibitorFieldMappingContext
    ) => Promise<ExhibitorFieldMappingDecision>>();

    const result = await mapExhibitorFields(sheet(), { ai });

    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "boothNumber",
      sourceHeader: "展位号",
      source: "rule",
      confidence: 1,
      requiresConfirmation: false
    }));
    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "companyName",
      sourceHeader: "企业名称",
      source: "rule",
      confidence: 1,
      requiresConfirmation: false
    }));
    expect(ai).not.toHaveBeenCalled();
  });

  it("uses smart AI only for fields that rules cannot map", async () => {
    const ai = vi.fn(async (_context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => ({
      mappings: [
        { field: "boothNumber", columnIndex: 0, confidence: 0.92, reason: "席位编码是项目内展位号" },
        { field: "companyName", columnIndex: 1, confidence: 0.91, reason: "参展单位对应展商名称" }
      ]
    }));

    const result = await mapExhibitorFields(sheet(["席位编码", "参展单位", "销售人员"]), { ai });

    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toMatchObject({
      sheetName: "普通绿色搭建汇总",
      unmappedFields: expect.arrayContaining(["boothNumber", "companyName"])
    });
    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "boothNumber",
      sourceHeader: "席位编码",
      source: "ai",
      confidence: 0.92,
      reason: "席位编码是项目内展位号",
      requiresConfirmation: false
    }));
    expect(result.mappings.find((mapping) => mapping.field === "salesOwner")).toMatchObject({
      source: "rule",
      sourceHeader: "销售人员"
    });
  });

  it("infers area from a duplicated booth header when samples are area numbers", async () => {
    const result = await mapExhibitorFields({
      sheetName: "普通绿色搭建汇总",
      headers: [
        { columnIndex: 0, label: "企业名称", samples: ["汕头市昌隆机械科技有限公司", "松辽化工（黑龙江）有限公司"] },
        { columnIndex: 1, label: "楼层", samples: ["一楼"] },
        { columnIndex: 2, label: "展馆", samples: ["1E", "1A"] },
        { columnIndex: 3, label: "展位号", samples: ["1ET06", "1AT20"] },
        { columnIndex: 4, label: "展位号", samples: ["36", "18", "54"] },
        { columnIndex: 5, label: "方案类型", samples: ["普通绿搭"] },
        { columnIndex: 6, label: "销售人员", samples: ["孙晓晓"] },
        { columnIndex: 7, label: "搭建商", samples: ["李铁：13607664172"] }
      ]
    });

    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "boothNumber",
      columnIndex: 3,
      sourceHeader: "展位号",
      source: "rule"
    }));
    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "area",
      columnIndex: 4,
      sourceHeader: "展位号",
      source: "rule",
      reason: "重复展位号列的样例为面积数字",
      requiresConfirmation: false
    }));
  });

  it("marks low-confidence AI mappings as requiring confirmation", async () => {
    const result = await mapExhibitorFields(sheet(["展位编码", "展商全称"]), {
      ai: vi.fn(async (_context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => ({
        mappings: [
          { field: "boothNumber", columnIndex: 0, confidence: 0.72, reason: "可能是展位号" }
        ]
      }))
    });

    expect(result.mappings).toContainEqual(expect.objectContaining({
      field: "boothNumber",
      source: "ai",
      confidence: 0.72,
      requiresConfirmation: true
    }));
  });

  it("falls back to manual mapping when smart AI throws", async () => {
    const result = await mapExhibitorFields(sheet(["席位编码", "参展单位"]), {
      ai: vi.fn(async () => {
        throw new Error("AI timeout");
      })
    });

    expect(result.mappings).toEqual([
      expect.objectContaining({ field: "boothNumber", source: "manual", requiresConfirmation: true }),
      expect.objectContaining({ field: "companyName", source: "manual", requiresConfirmation: true })
    ]);
    expect(result.aiError).toBe("AI timeout");
  });
});
