import { describe, expect, it } from "vitest";
import { parseMasterDataRows, upsertBoothRecords } from "@/lib/domain/master-data";

describe("master data import", () => {
  it("validates booth, company, sales owner and builder columns", () => {
    const result = parseMasterDataRows([
      { 展位号: "A01", 公司名称: "上海星河科技有限公司", 业务员: "王宁", 搭建商: "青木搭建" },
      { 展位号: "", 公司名称: "缺展位公司", 业务员: "李敏", 搭建商: "工匠搭建" }
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
    expect(result.errors).toEqual([{ row: 3, message: "展位号不能为空" }]);
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

  it("rejects duplicate booth numbers within the same import", () => {
    const result = parseMasterDataRows([
      { 展位号: "A01", 公司名称: "第一家公司", 业务员: "王宁", 搭建商: "青木搭建" },
      { 展位号: "A01", 公司名称: "重复公司", 业务员: "李敏", 搭建商: "工匠搭建" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "第一家公司",
        companyShortName: "第一家公司",
        salesOwner: "王宁",
        builder: "青木搭建"
      }
    ]);
    expect(result.errors).toEqual([{ row: 3, message: "展位号 A01 重复" }]);
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
