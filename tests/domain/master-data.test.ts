import { describe, expect, it } from "vitest";
import { parseMasterDataRows, upsertBoothRecords } from "@/lib/domain/master-data";

describe("master data import", () => {
  it("validates required booth and exhibitor fields while preserving optional data", () => {
    const result = parseMasterDataRows([
      {
        boothNumber: " A01 ",
        companyName: " Alpha Seeds ",
        companyShortName: " Alpha ",
        salesOwner: " Wang ",
        builder: " Li Tie ",
        location: "Hall 1",
        area: "36",
        boothType: "Green"
      },
      { boothNumber: "", companyName: "Missing Booth", salesOwner: "Sun", builder: "Builder" },
      { boothNumber: "A02", companyName: "", salesOwner: "Sun", builder: "Builder" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "Alpha Seeds",
        companyShortName: "Alpha",
        salesOwner: "Wang",
        builder: "Li Tie",
        location: "Hall 1",
        area: "36",
        boothType: "Green"
      }
    ]);
    expect(result.errors).toEqual([
      { row: 3, message: "展位号不能为空" },
      { row: 4, message: "公司名称不能为空" }
    ]);
  });

  it("keeps different exhibitors on the same booth as separate system records", () => {
    const result = parseMasterDataRows([
      {
        boothNumber: "1AT27",
        companyName: "Dinglai Agriculture",
        salesOwner: "Ma",
        builder: "Cui",
        location: "Floor 1 1A",
        area: "18",
        boothType: "Green"
      },
      {
        boothNumber: "1AT27",
        companyName: "Xinli Agriculture",
        salesOwner: "Ma",
        builder: "Cui",
        location: "Floor 1 1A",
        area: "18",
        boothType: "Green"
      }
    ]);

    expect(result).toEqual({
      records: [
        {
          boothNumber: "1AT27",
          companyName: "Dinglai Agriculture",
          companyShortName: "Dinglai Agriculture",
          salesOwner: "Ma",
          builder: "Cui",
          location: "Floor 1 1A",
          area: "18",
          boothType: "Green"
        },
        {
          boothNumber: "1AT27",
          companyName: "Xinli Agriculture",
          companyShortName: "Xinli Agriculture",
          salesOwner: "Ma",
          builder: "Cui",
          location: "Floor 1 1A",
          area: "18",
          boothType: "Green"
        }
      ],
      errors: []
    });
  });

  it("merges repeated rows only when booth and exhibitor name both match", () => {
    const result = parseMasterDataRows([
      { boothNumber: "A01", companyName: "Alpha Seeds", salesOwner: "Wang", builder: "Li" },
      { boothNumber: "A01", companyName: "Alpha Seeds", salesOwner: "Zhao", builder: "Li" }
    ]);

    expect(result.records).toEqual([
      {
        boothNumber: "A01",
        companyName: "Alpha Seeds",
        companyShortName: "Alpha Seeds",
        salesOwner: "Wang / Zhao",
        builder: "Li"
      }
    ]);
    expect(result.errors).toEqual([]);
  });

  it("upserts booth records by booth number and exhibitor name", () => {
    const merged = upsertBoothRecords(
      [
        {
          boothNumber: "A01",
          companyName: "Alpha Seeds",
          companyShortName: "Alpha",
          salesOwner: "Old Owner",
          builder: "Old Builder"
        }
      ],
      [
        {
          boothNumber: "A01",
          companyName: "Alpha Seeds",
          companyShortName: "Alpha",
          salesOwner: "New Owner",
          builder: "New Builder"
        },
        {
          boothNumber: "A01",
          companyName: "Beta Fertilizer",
          companyShortName: "Beta",
          salesOwner: "Beta Owner",
          builder: "Beta Builder"
        }
      ]
    );

    expect(merged).toEqual([
      {
        boothNumber: "A01",
        companyName: "Alpha Seeds",
        companyShortName: "Alpha",
        salesOwner: "New Owner",
        builder: "New Builder"
      },
      {
        boothNumber: "A01",
        companyName: "Beta Fertilizer",
        companyShortName: "Beta",
        salesOwner: "Beta Owner",
        builder: "Beta Builder"
      }
    ]);
  });
});
