import { describe, expect, it } from "vitest";
import {
  extractMasterDataRowsFromWorkbookSheets,
  parseMasterDataRows,
  upsertBoothRecords
} from "@/lib/domain/master-data";

describe("master data import", () => {
  it("validates booth, company, sales owner and builder columns", () => {
    const result = parseMasterDataRows([
      { 展位号: "A01", 公司名称: "上海星河科技有限公司", 业务员: "王宁", 搭建商: "青木搭建" },
      { 展位号: "", 公司名称: "缺展位公司", 业务员: "李敏", 搭建商: "工匠搭建" },
      { 展位号: "A02", 公司名称: "", 业务员: "李敏", 搭建商: "工匠搭建" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "上海星河科技有限公司",
        companyShortName: "上海星河科技有限公司",
        salesOwner: "王宁",
        builder: "青木搭建"
      }
    ]);
    expect(result.errors).toEqual([
      { row: 3, message: "展位号不能为空" },
      { row: 4, message: "公司名称不能为空" }
    ]);
  });

  it("extracts booth rows from titled logistics workbook sheets", () => {
    const rows = extractMasterDataRowsFromWorkbookSheets([
      {
        sheetName: "普通绿色搭建汇总",
        rows: [
          ["", "第23届中原农资双交会绿搭"],
          [
            "品类",
            "企业名称",
            "楼层",
            "展馆",
            "展位号",
            "展位号",
            "方案类型",
            "确定方案图片",
            "方案编号",
            "确认搭建方案",
            "画面是否提交",
            "展位画面已渲染",
            "展位画面已确定",
            "组别",
            "销售人员",
            "是否到款",
            "搭建商"
          ],
          ["机械", "汕头市昌隆机械科技有限公司", "一楼", "1E", "1ET06", "36", "普通绿搭", "", "", "", "", "", "", "中原一组", "孙晓晓", "半款", "李铁：13607664172"],
          ["农药", "郑州鼎来瑞农业科技有限公司", "一楼", "1A", "1AT27", "18", "普通绿搭", "", "", "", "", "", "", "中原二组", "马永波", "半款", "崔晓安：13803812794"],
          ["农药", "郑州鑫利农农业科技有限公司", "一楼", "1A", "1AT27", "18", "普通绿搭", "", "", "", "", "", "", "中原二组", "马永波", "半款", "崔晓安：13803812794"]
        ]
      },
      {
        sheetName: "标展楣牌",
        rows: [
          ["标展楣牌下单情况"],
          ["公司名称", "所属展馆", "展位号", "展位类别（普标）", "面积", "开口", "楣板数量", "组别", "销售人员"],
          ["安徽省安邦矿物股份有限公司", "1E", "1E01", "精标", "6", "双开", "2", "中原一组", "孙晓晓"]
        ]
      },
      {
        sheetName: "退订企业汇总",
        rows: [
          ["企业名称", "展馆", "展位号", "面积", "销售人员", "搭建公司"],
          ["退订企业", "1A", "1AT99", "36", "王宁", "不应导入"]
        ]
      }
    ]);

    expect(rows).toEqual([
      {
        展位号: "1ET06",
        公司名称: "汕头市昌隆机械科技有限公司",
        业务员: "孙晓晓",
        搭建商: "李铁：13607664172",
        位置: "一楼 1E",
        面积: "36",
        类型: "普通绿搭"
      },
      {
        展位号: "1AT27",
        公司名称: "郑州鼎来瑞农业科技有限公司",
        业务员: "马永波",
        搭建商: "崔晓安：13803812794",
        位置: "一楼 1A",
        面积: "18",
        类型: "普通绿搭"
      },
      {
        展位号: "1AT27",
        公司名称: "郑州鑫利农农业科技有限公司",
        业务员: "马永波",
        搭建商: "崔晓安：13803812794",
        位置: "一楼 1A",
        面积: "18",
        类型: "普通绿搭"
      },
      {
        展位号: "1E01",
        公司名称: "安徽省安邦矿物股份有限公司",
        业务员: "孙晓晓",
        搭建商: "",
        位置: "1E",
        面积: "6",
        类型: "精标"
      }
    ]);

    expect(parseMasterDataRows(rows)).toEqual({
      records: [
        {
          boothNumber: "1AT27",
          companyName: "郑州鼎来瑞农业科技有限公司 / 郑州鑫利农农业科技有限公司",
          companyShortName: "郑州鼎来瑞农业科技有限公司 / 郑州鑫利农农业科技有限公司",
          salesOwner: "马永波",
          builder: "崔晓安：13803812794",
          location: "一楼 1A",
          area: "18",
          boothType: "普通绿搭"
        },
        {
          boothNumber: "1E01",
          companyName: "安徽省安邦矿物股份有限公司",
          companyShortName: "安徽省安邦矿物股份有限公司",
          salesOwner: "孙晓晓",
          builder: "",
          location: "1E",
          area: "6",
          boothType: "精标"
        },
        {
          boothNumber: "1ET06",
          companyName: "汕头市昌隆机械科技有限公司",
          companyShortName: "汕头市昌隆机械科技有限公司",
          salesOwner: "孙晓晓",
          builder: "李铁：13607664172",
          location: "一楼 1E",
          area: "36",
          boothType: "普通绿搭"
        }
      ],
      errors: []
    });
  });

  it("upserts booth records by booth number", () => {
    const merged = upsertBoothRecords(
      [{ boothNumber: "A01", companyName: "旧公司", companyShortName: "旧公司", salesOwner: "旧业务", builder: "旧搭建" }],
      [{ boothNumber: "A01", companyName: "新公司", companyShortName: "新公司", salesOwner: "新业务", builder: "新搭建" }]
    );

    expect(merged).toEqual([
      { boothNumber: "A01", companyName: "新公司", companyShortName: "新公司", salesOwner: "新业务", builder: "新搭建" }
    ]);
  });

  it("merges duplicate booth numbers within the same import", () => {
    const result = parseMasterDataRows([
      { 展位号: "A01", 公司名称: "第一家公司", 业务员: "王宁", 搭建商: "青木搭建" },
      { 展位号: "A01", 公司名称: "重复公司", 业务员: "李敏", 搭建商: "工匠搭建" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "第一家公司 / 重复公司",
        companyShortName: "第一家公司 / 重复公司",
        salesOwner: "王宁 / 李敏",
        builder: "青木搭建 / 工匠搭建"
      }
    ]);
    expect(result.errors).toEqual([]);
  });

  it("preserves existing booths and naturally sorts booth numbers after upsert", () => {
    const merged = upsertBoothRecords(
      [
        { boothNumber: "A10", companyName: "十号公司", companyShortName: "十号公司", salesOwner: "旧业务", builder: "旧搭建" },
        { boothNumber: "A1", companyName: "一号公司", companyShortName: "一号公司", salesOwner: "旧业务", builder: "旧搭建" }
      ],
      [{ boothNumber: "A2", companyName: "二号公司", companyShortName: "二号公司", salesOwner: "新业务", builder: "新搭建" }]
    );

    expect(merged).toEqual([
      { boothNumber: "A1", companyName: "一号公司", companyShortName: "一号公司", salesOwner: "旧业务", builder: "旧搭建" },
      { boothNumber: "A2", companyName: "二号公司", companyShortName: "二号公司", salesOwner: "新业务", builder: "新搭建" },
      { boothNumber: "A10", companyName: "十号公司", companyShortName: "十号公司", salesOwner: "旧业务", builder: "旧搭建" }
    ]);
  });

  it("accepts english keys, trims values and uses provided company short name", () => {
    const result = parseMasterDataRows([
      {
        boothNumber: " A02 ",
        companyName: " 上海云舟科技有限公司 ",
        companyShortName: " 云舟科技 ",
        salesOwner: " 赵磊 ",
        builder: " 匠心搭建 "
      }
    ]);

    expect(result).toEqual({
      records: [
        {
          boothNumber: "A02",
          companyName: "上海云舟科技有限公司",
          companyShortName: "云舟科技",
          salesOwner: "赵磊",
          builder: "匠心搭建"
        }
      ],
      errors: []
    });
  });
});
