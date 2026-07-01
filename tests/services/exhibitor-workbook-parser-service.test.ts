import { describe, expect, it, vi } from "vitest";
import type { ExhibitorFieldMappingContext, ExhibitorFieldMappingDecision } from "@/lib/ai/types";
import { extractMasterDataRowsFromWorkbookSheetsWithAi } from "@/lib/services/exhibitor-workbook-parser-service";

describe("exhibitor workbook parser service", () => {
  it("uses smart AI to recover unmapped booth and company headers", async () => {
    const ai = vi.fn(async (_context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => ({
      mappings: [
        { field: "boothNumber", columnIndex: 0, confidence: 0.95, reason: "席位编码就是展位号" },
        { field: "companyName", columnIndex: 1, confidence: 0.95, reason: "参展单位就是展商名称" }
      ]
    }));

    const rows = await extractMasterDataRowsFromWorkbookSheetsWithAi([
      {
        sheetName: "普通绿色搭建汇总",
        rows: [
          ["席位编码", "参展单位", "楼层", "展馆", "销售人员", "搭建公司"],
          ["A09", "测试公司", "一楼", "1A", "赵测试", "青木搭建"]
        ]
      }
    ], { ai });

    expect(ai).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      {
        boothNumber: "A09",
        companyName: "测试公司",
        salesOwner: "赵测试",
        builder: "青木搭建",
        location: "一楼 1A"
      }
    ]);
  });

  it("uses AI assisted mapping for the exported logistics workbook sheets", async () => {
    const ai = vi.fn(async (context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => {
      if (context.sheetName === "标展楣牌") {
        return {
          mappings: [
            { field: "floor", columnIndex: 1, confidence: 0.92, reason: "所属展馆对应楼层" },
            { field: "builder", columnIndex: 8, confidence: 0.91, reason: "销售人员旁边通常是搭建商" }
          ]
        };
      }
      return { mappings: [] };
    });

    const rows = await extractMasterDataRowsFromWorkbookSheetsWithAi([
      {
        sheetName: "普通绿色搭建汇总",
        rows: [
          ["", "第23届中原农资双交会绿搭", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
          ["品类", "企业名称", "楼层", "展馆", "展位号", "展位号", "方案类型", "确定方案图片", "方案编号", "确认搭建方案", "画面是否提交", "展位画面已渲染", "画面已确定", "组别", "销售人员", "是否到款", "搭建商"],
          ["机械", "汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "", "PT36-2", 1, "收到3.21", "", "", "中原一组", "孙晓晓", "半款", "李铁：13607664172"]
        ]
      },
      {
        sheetName: "标展楣牌",
        rows: [
          ["标展楣牌下单情况，已在提交批次里面需要修改的，请在备注中备注更改日期"],
          ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "开口", "楣板数量", "组别", "销售人员", "是否到款", "备注"],
          ["山东省聊城经济开发区齐龙精细化工厂", "1E", "1E05", "精标", 9, "双开", 2, "农药二组", "韩世军", "全款", ""]
        ]
      }
    ], { ai });

    expect(rows).toEqual([
      expect.objectContaining({
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        location: "一楼 1E",
        area: "36",
        boothType: "普通绿搭",
        salesOwner: "孙晓晓",
        builder: "李铁：13607664172"
      }),
      expect.objectContaining({
        boothNumber: "1E05",
        companyName: "山东省聊城经济开发区齐龙精细化工厂",
        location: "1E",
        area: "9",
        boothType: "精标",
        salesOwner: "韩世军"
      })
    ]);
    expect(ai).toHaveBeenCalledWith(expect.objectContaining({
      sheetName: "标展楣牌",
      unmappedFields: expect.arrayContaining(["floor", "builder"])
    }));
  });

  it("infers green-build area from the duplicated booth-number column without AI", async () => {
    const ai = vi.fn();

    const rows = await extractMasterDataRowsFromWorkbookSheetsWithAi([
      {
        sheetName: "普通绿色搭建汇总",
        rows: [
          ["", "第23届中原农资双交会绿搭", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""],
          ["品类", "企业名称", "楼层", "展馆", "展位号", "展位号", "方案类型", "确定方案图片", "方案编号", "确认搭建方案", "画面是否提交", "展位画面已渲染", "画面已确定", "组别", "销售人员", "是否到款", "搭建商"],
          ["机械", "汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", 36, "普通绿搭", "", "PT36-2", 1, "收到3.21", "", "", "中原一组", "孙晓晓", "半款", "李铁：13607664172"],
          ["农药", "松辽化工（黑龙江）有限公司", "一楼", "1A", "1AT20", 18, "普通绿搭", "", "PT18-3", 1, "收到3.21", "", "", "中原二组", "樊高岩", "全款", "崔晓安：13803812794"]
        ]
      }
    ], { ai });

    expect(rows).toEqual([
      expect.objectContaining({
        boothNumber: "1ET06",
        companyName: "汕头市昌隆机械科技有限公司",
        area: "36"
      }),
      expect.objectContaining({
        boothNumber: "1AT20",
        companyName: "松辽化工（黑龙江）有限公司",
        area: "18"
      })
    ]);
    expect(ai).not.toHaveBeenCalled();
  });

  it("uses smart AI to parse 标摊楣牌 sheets with unknown headers", async () => {
    const ai = vi.fn(async (context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => ({
      mappings: ([
        { field: "companyName", columnIndex: 0, confidence: 0.95, reason: "参展单位是展商名称" },
        { field: "hall", columnIndex: 1, confidence: 0.9, reason: "馆号对应展馆位置" },
        { field: "boothNumber", columnIndex: 2, confidence: 0.96, reason: "席位编码是展位号" },
        { field: "salesOwner", columnIndex: 5, confidence: 0.9, reason: "业务员对应销售人员" }
      ] satisfies ExhibitorFieldMappingDecision["mappings"]).filter((mapping) => context.unmappedFields.includes(mapping.field))
    }));

    const rows = await extractMasterDataRowsFromWorkbookSheetsWithAi([
      {
        sheetName: "标摊楣牌",
        rows: [
          ["标摊楣牌下单情况"],
          ["参展单位", "馆号", "席位编码", "展位类别（普标）", "面积", "业务员"],
          ["安徽省安邦矿物股份有限公司", "1E", "1E01", "精标", 6, "孙晓晓"]
        ]
      }
    ], { ai });

    expect(ai).toHaveBeenCalledWith(expect.objectContaining({
      sheetName: "标摊楣牌",
      unmappedFields: expect.arrayContaining(["boothNumber", "companyName"])
    }));
    expect(rows).toEqual([
      expect.objectContaining({
        boothNumber: "1E01",
        companyName: "安徽省安邦矿物股份有限公司",
        location: "1E",
        area: "6",
        boothType: "精标",
        salesOwner: "孙晓晓"
      })
    ]);
  });

  it("uses smart AI to infer columns from continuation sheets without headers", async () => {
    const ai = vi.fn(async (_context: ExhibitorFieldMappingContext): Promise<ExhibitorFieldMappingDecision> => ({
      mappings: [
        { field: "companyName", columnIndex: 0, confidence: 0.96, reason: "样例都是展商名称" },
        { field: "floor", columnIndex: 1, confidence: 0.9, reason: "样例是一楼、二楼" },
        { field: "hall", columnIndex: 2, confidence: 0.9, reason: "样例是展馆编码" },
        { field: "boothNumber", columnIndex: 3, confidence: 0.97, reason: "样例是展位号" },
        { field: "area", columnIndex: 4, confidence: 0.94, reason: "样例是面积数字" },
        { field: "exhibitorType", columnIndex: 5, confidence: 0.9, reason: "样例是搭建类型" },
        { field: "builder", columnIndex: 6, confidence: 0.92, reason: "样例是现场搭建成员" }
      ]
    }));

    const rows = await extractMasterDataRowsFromWorkbookSheetsWithAi([
      {
        sheetName: "工作表1",
        rows: [
          ["广西金丝鸟农化有限公司", "一楼", "1A", "1AT13", 54, "普通绿搭", "李娜：15237810685"],
          ["河南柯睿纳生物科技有限公司", "一楼", "1A", "1AT15", 54, "普通绿搭", "李娜：15237810685"]
        ]
      }
    ], { ai });

    expect(ai).toHaveBeenCalledWith(expect.objectContaining({
      sheetName: "工作表1",
      headers: expect.arrayContaining([
        expect.objectContaining({ columnIndex: 0, label: "第1列", samples: expect.arrayContaining(["广西金丝鸟农化有限公司"]) }),
        expect.objectContaining({ columnIndex: 3, label: "第4列", samples: expect.arrayContaining(["1AT13"]) })
      ]),
      unmappedFields: expect.arrayContaining(["boothNumber", "companyName", "area", "builder"])
    }));
    expect(rows).toEqual([
      expect.objectContaining({
        boothNumber: "1AT13",
        companyName: "广西金丝鸟农化有限公司",
        location: "一楼 1A",
        area: "54",
        boothType: "普通绿搭",
        builder: "李娜：15237810685"
      }),
      expect.objectContaining({
        boothNumber: "1AT15",
        companyName: "河南柯睿纳生物科技有限公司",
        location: "一楼 1A",
        area: "54",
        boothType: "普通绿搭",
        builder: "李娜：15237810685"
      })
    ]);
  });
});
